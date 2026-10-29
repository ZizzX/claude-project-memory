import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit, pmDir, worktreeName, today, normPath } from './paths.mjs';
import { hasBoard, commitPm, isSyncOn, persist, readState, writeState, hasState, manualMtime, autoWrite } from './store.mjs';
import { captureCommits, reflogFile, reflogSince, sizeOf, TAKEN } from './gitlink.mjs';
import { listTasks, appendLogLine, validate } from './tasks.mjs';
import { writeBoard } from './board.mjs';
import { buildSummary } from './summary.mjs';
import { pull, conflictFiles, unpushedOverDay, sharedBoardHint, linkMemory, memorySyncEnabled } from './sync.mjs';
import { updateLine } from './update.mjs';
import { mergeAtStart } from './merged.mjs';
import { CLOSED_PREFIX } from './show.mjs';
import { auditLine } from './audit.mjs';

// ponytail: one global threshold; per-project config only if users ask for it.
export const STALE_MINUTES = 20;
export const PLAN_PATTERNS = [
  /\/docs\/superpowers\/(plans|specs)\//,
  /\/docs\/designs\//,
  /\/\.claude\/plans\//,
  /\/\.gstack\/projects\/[^/]+\/ceo-plans\//,
  /\/\.dev-cycle\/tasks\//,
];
const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const HINT = '[pm] this repo has a shared board (branch pm) — say "connect the board" to use it';

const inside = (file, dir) => normPath(file).startsWith(normPath(dir) + path.sep);

// A deleted path has no mtime of its own: removing it touched the nearest directory that still exists.
function ancestorMtime(top, rel) {
  for (let dir = path.dirname(path.join(top, rel)); ; dir = path.dirname(dir)) {
    try {
      return fs.statSync(dir).mtimeMs;
    } catch {
      if (normPath(dir) === normPath(top) || path.dirname(dir) === dir) return 0;
    }
  }
}

function dirtyFilesSince(cwd, since) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  const entries = (tryGit(['status', '--porcelain', '-z'], cwd) ?? '').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry[0] === 'R' || entry[0] === 'C') i += 1; // next entry is the rename/copy source
    const rel = entry.slice(3);
    try {
      if (fs.statSync(path.join(top, rel)).mtimeMs > since) files.push(rel);
    } catch {
      if (ancestorMtime(top, rel) > since) files.push(rel);
    }
  }
  return files;
}

function committedSince(cwd, head) {
  if (!head) return [];
  return (tryGit(['diff', '--name-only', `${head}..HEAD`], cwd) ?? '').split('\n').filter(Boolean);
}

function lastBoardUpdate(pm, worktree, tasks) {
  const files = [
    path.join(pm, 'PLAN.md'),
    path.join(pm, 'decisions.md'),
    ...tasks.filter((t) => t.data.worktrees.includes(worktree)).map((t) => t.file),
  ];
  return Math.max(0, ...files.filter((f) => fs.existsSync(f)).map((f) => manualMtime(pm, f)));
}

// What a session window starts from: its time, HEAD for the note's file list, the reflog size for Stop's commits.
function sessionState(cwd) {
  const file = reflogFile(cwd);
  return { start: Date.now(), head: tryGit(['rev-parse', 'HEAD'], cwd), reflogOffset: file ? sizeOf(file) : null };
}

// Commits made in this worktree after the session window opened, read from its own reflog offset: pulls,
// merges, rebases and resets are not commits of the session. A reflog shorter than the offset counts none.
function sessionCommits(cwd, { reflogOffset }, since) {
  const file = typeof reflogOffset === 'number' && reflogFile(cwd);
  if (!file) return 0;
  return reflogSince(file, reflogOffset).entries.filter((e) => TAKEN.test(e.subject) && e.time * 1000 > since).length;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// PM_DEBUG: what Stop saw and decided — times, counts and paths only. Returns '' so a no-block path ends with it.
const debug = (line) => {
  if (process.env.PM_DEBUG) console.error(`[pm] stop: ${line}`);
  return '';
};

export function onSessionStart(input, cwd) {
  const pm = pmDir(cwd);
  if (!pm) return '';
  if (!hasBoard(cwd)) return sharedBoardHint(cwd) ? HINT : '';
  let status = '';
  let conflicted = false;
  if (isSyncOn(pm)) {
    commitPm(pm, 'pm: session start');
    conflicted = pull(pm) === 'conflict';
    if (conflicted) status = `[pm] sync conflict in ${(conflictFiles(pm) ?? []).join(', ')} — run: pm sync`;
    if (memorySyncEnabled(cwd)) {
      try {
        linkMemory(cwd, pm);
      } catch (e) {
        if (!status) status = `[pm] memory link check failed: ${e.message}`;
      }
    }
    const unpushed = unpushedOverDay(pm);
    if (!status && unpushed) status = `[pm] ${unpushed} board commits not pushed for over a day — run: pm sync`;
  }
  let tasks = listTasks(pm); // after the pull: one scan serves the board, validation and the summary
  let merge = null;
  // Mid-rebase the task files may hold one side of a conflict: nothing is closed or committed until pm sync.
  if (!conflicted) {
    try {
      merge = mergeAtStart({ pm, cwd, tasks, date: today() });
    } catch (e) {
      if (process.env.PM_DEBUG) console.error(e); // a merge check never breaks a session start
      tasks = listTasks(pm);
    }
  }
  if (merge?.closedIds.length) {
    tasks = listTasks(pm);
    persist(pm, `${CLOSED_PREFIX}${merge.closedIds.join(', ')}`, tasks);
  } else {
    writeBoard(pm, tasks);
  }
  const problems = validate(tasks);
  if (!status && problems.length) status = `[pm] board problems: ${problems.slice(0, 3).join('; ')} — run: pm validate`;
  // A missing session_id means no stdin reached us (a plugin reload, not a real session start).
  // Keying state as "undefined" pools unrelated runs into one window; the summary still prints.
  if (input.session_id) writeState(pm, `session-${input.session_id}`, sessionState(cwd));
  const notice = updateLine({ pm, cwd }); // never blocks: local sources plus the cached network result
  let audit = '';
  try {
    audit = auditLine(pm, cwd); // a weekly count; a failure here is not worth a missing summary
  } catch (e) {
    if (process.env.PM_DEBUG) console.error(e);
  }
  const statusLine = [status, notice, audit].filter(Boolean).join('\n');
  return buildSummary({ pm, worktree: worktreeName(cwd), scriptPath: PM_SCRIPT, statusLine, tasks, merge });
}

export function onPostToolUse(input, cwd) {
  const pm = pmDir(cwd);
  if (!pm || !hasBoard(cwd)) return '';
  const file = String(input.tool_input?.file_path ?? '');
  if (file && inside(file, pm)) {
    writeBoard(pm);
    return '';
  }
  const slashed = file.replace(/\\/g, '/');
  if (input.tool_name !== 'ExitPlanMode' && !PLAN_PATTERNS.some((re) => re.test(slashed))) return '';
  const additionalContext = `[pm] plan updated: ${file || 'plan mode'} — reconcile with the board (coarse items + link).`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } });
}

export function onStop(input, cwd, now = Date.now()) {
  const pm = pmDir(cwd);
  if (!pm || !hasBoard(cwd)) return '';
  const tasks = listTasks(pm);
  captureCommits(pm, cwd, tasks); // before the commit below, so linked commits land in "pm: stop"
  // The commit stays before the re-entrancy check: after a block the agent may have edited PLAN.md
  // by hand, and this repeated Stop is the only place that commits it.
  persist(pm, 'pm: stop', tasks);
  if (input.stop_hook_active) return '';
  // Without its session's state there is no window to compare with: some other run, or a plugin reload.
  const session = `session-${input.session_id}`;
  if (!input.session_id || !hasState(pm, session)) return debug('no block — no session state');
  const worktree = worktreeName(cwd);
  const updated = lastBoardUpdate(pm, worktree, tasks);
  const stateName = `stop-${worktree}`;
  const { lastBlock = 0 } = readState(pm, stateName);
  const windowMs = STALE_MINUTES * 60_000;
  if (now - updated < windowMs) return debug(`no block — board updated ${Math.round((now - updated) / 60_000)} min ago`);
  if (now - lastBlock < windowMs) return debug('no block — already blocked in this window');
  const state = readState(pm, session);
  const since = Math.max(state.start ?? 0, updated);
  const commits = sessionCommits(cwd, state, since);
  const files = dirtyFilesSince(cwd, since);
  const saw = `since ${new Date(since).toISOString()}: ${commits} commits, ${files.length} files${files.length ? ` (${files.slice(0, 10).join(', ')})` : ''}`;
  if (!commits && !files.length) return debug(`no block — ${saw}`);
  debug(`block — ${saw}`);
  writeState(pm, stateName, { lastBlock: now });
  const what = [commits && `made ${plural(commits, 'commit')}`, files.length && `changed ${plural(files.length, 'file')}`].filter(Boolean).join(' and ');
  return JSON.stringify({
    decision: 'block',
    reason: `[pm] This session ${what}; the board was not updated for ${STALE_MINUTES}+ minutes. Log progress on this worktree's task (pm log), or reply that there is nothing to track.`,
  });
}

export function onSafetyNote(input, cwd, event) {
  const pm = pmDir(cwd);
  if (!pm || !hasBoard(cwd)) return '';
  captureCommits(pm, cwd);
  if (!input.session_id) {
    // Without a stable key the "changed since" window belongs to some other run: note nothing.
    persist(pm, `pm: auto ${event}`);
    return '';
  }
  const stateName = `session-${input.session_id}`;
  const { start = Date.now(), head = null } = readState(pm, stateName);
  const worktree = worktreeName(cwd);
  const files = [...new Set([...committedSince(cwd, head), ...dirtyFilesSince(cwd, start)])];
  if (files.length) {
    const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ` (+${files.length - 10} more)` : '');
    const last = tryGit(['log', '-1', '--format=%h %s'], cwd) ?? 'none';
    const line = `- ${today()} · ${worktree} · auto: changed files: ${shown} · last commit: ${last}`;
    for (const t of listTasks(pm)) {
      // An automatic write: the Stop nudge keeps seeing the last manual board update.
      if (t.data.status === 'in_progress' && t.data.worktrees.includes(worktree)) autoWrite(pm, t.file, () => appendLogLine(pm, t.id, line, today()));
    }
    writeState(pm, stateName, sessionState(cwd)); // next note and the Stop window cover only new changes
  }
  persist(pm, `pm: auto ${event}`);
  return '';
}
