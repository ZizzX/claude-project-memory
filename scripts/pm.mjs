#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pmDir, memoryDir, worktreeName, today } from './lib/paths.mjs';
import { hasBoard, initBoard, persist, commitPm, isSyncOn } from './lib/store.mjs';
import { listTasks, newTask, setFields, STATUSES, claim, appendLog, readyQueue, validate, parseOrder, isOpen, byEpic, activeEpic } from './lib/tasks.mjs';
import { captureCommits, startCapture, currentBranch } from './lib/gitlink.mjs';
import { showTask } from './lib/show.mjs';
import { currentFocus } from './lib/plan.mjs';
import { appendDecision } from './lib/decisions.mjs';
import { writeBoard } from './lib/board.mjs';
import { buildSummary } from './lib/summary.mjs';
import { scanPlans } from './lib/scan.mjs';
import { syncTarget, syncOn, syncOff, pushNow, conflictFiles, linkMemory, memorySyncEnabled } from './lib/sync.mjs';
import { onSessionStart, onPostToolUse, onStop, onSafetyNote } from './lib/hooks.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const USAGE = `usage: pm <command>
  init                                         create the local board for this repo
  task new --title T [--order N] [--deps T-001,T-002] [--milestone M1] [--epic KEY | --epic ""] [--links a,b]
  set <id> key=value ...                       update task fields (status, order, depends_on, waiting_on, epic, ...)
  claim <id>                                   attach this worktree and set in_progress
  log <id> --did "..." --next "..."            append a work log entry
  show <id>                                    task history: branch, pr, timeline, commits, decisions, dependents
  decision --title T --why W --rejected R [--tasks T-001,T-002]
  ready [--epic KEY | --all]                   ready tasks of this worktree's epic (default), one epic, or all
  epics                                        every epic with open/total and its focus line
  validate | board | summary | scan
  sync [on [--remote url] [--yes] | off]       opt-in sync of board and memory across machines
  help                                         this list, plus what to say to Claude in a session
  hook <event>                                 hook entry point (used by the plugin)`;

const PHRASES = `In a Claude Code session you rarely run these yourself — say it and Claude runs them:
  "what's next?" / "take the next one"         pick and claim the next ready task of this worktree's epic
  "break it down"                              turn a large request into tasks (with --epic and a linked plan)
  "remember …"                                 record a decision, a project fact or a task detail
  "waiting for …"                              mark the active task blocked, with the reason
  "we're done" / "continue in a new session"   log did/next on active tasks, so /clear is safe
  "the plan changes"                           edit PLAN.md, add a Changelog line and a decision
  "undo that" / "undo the board change"        revert that change of the board itself
  "undo the code of T-007"                     show the undo block, ask, then revert the task's commits
  "go back to the state before T-007"          offer the safe branch first, the dangerous ways only on request
  "enable board sync" / "connect the board"    opt-in sync across machines (asks before pushing)
After creating an MR/PR for a task: pm set T-NNN pr=<url> — pm show then reads its state and merge SHA.
Protocol Claude follows: /pm · docs: https://github.com/ZizzX/claude-project-memory#readme`;

class UsageError extends Error {}
const fail = (msg) => {
  throw new UsageError(msg);
};
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const strings = (args, names) => parseArgs({ args, options: Object.fromEntries(names.map((n) => [n, { type: 'string' }])) }).values;

function requireBoard(cwd) {
  if (!hasBoard(cwd)) fail('no board here — run: pm init');
  return pmDir(cwd);
}

const conflictHelp = (pm) => `sync conflict in: ${(conflictFiles(pm) ?? []).join(', ') || 'unknown files'}
nothing was discarded. To resolve: cd "${pm}" && git pull --rebase origin pm (first sync: git merge origin/pm),
fix the listed files, git add -A, then git rebase --continue (or git commit), then run: pm sync
If git still reports a lock, delete ${path.join(pm, '.git', 'index.lock')} — safe once no pm command is running.`;

const commands = {
  init(cwd) {
    const { pm, created } = initBoard(cwd, today());
    return `${created ? 'created' : 'exists'}: ${pm}`;
  },

  task(cwd, [sub, ...args]) {
    if (sub !== 'new') fail(USAGE);
    const v = strings(args, ['title', 'order', 'deps', 'milestone', 'epic', 'links']);
    if (!v.title) fail('--title is required');
    const pm = requireBoard(cwd);
    const all = listTasks(pm);
    // A task inherits the epic of its worktree; --epic "" makes it repo-wide on purpose.
    const epic = (v.epic ?? activeEpic(all, worktreeName(cwd))).trim();
    const t = newTask(pm, {
      title: v.title,
      order: v.order === undefined ? undefined : parseOrder(v.order),
      deps: list(v.deps),
      milestone: v.milestone ?? '',
      epic,
      links: list(v.links),
      date: today(),
    });
    persist(pm, `pm: task new ${t.id}`);
    const note = epic ? ` (epic ${epic}${all.some((x) => x.data.epic === epic) ? '' : ', new epic'})` : '';
    return `${t.id} created${note}: ${t.file}`;
  },

  set(cwd, [id, ...pairs]) {
    if (!id || !pairs.length) fail('usage: pm set <id> key=value ...');
    const fields = Object.fromEntries(pairs.map((p) => {
      const i = p.indexOf('=');
      if (i < 1) fail(`bad field "${p}", use key=value`);
      return [p.slice(0, i), p.slice(i + 1)];
    }));
    const pm = requireBoard(cwd);
    const statusChange = 'status' in fields;
    if (statusChange && !STATUSES.includes(fields.status)) fail(`bad status "${fields.status}"; use ${STATUSES.join(' | ')}`);
    if (statusChange) captureCommits(pm, cwd); // the last commits land while the task is still in progress
    setFields(pm, id, fields, today());
    if (statusChange) startCapture(pm, cwd); // commits made in another status are never linked later
    persist(pm, `pm: set ${id} ${pairs.join(' ')}`);
    return `${id} updated`;
  },

  claim(cwd, [id]) {
    if (!id) fail('usage: pm claim <id>');
    const pm = requireBoard(cwd);
    const wt = worktreeName(cwd);
    captureCommits(pm, cwd); // commits so far belong to the tasks already in progress here
    claim(pm, id, wt, today(), currentBranch(cwd));
    startCapture(pm, cwd);
    persist(pm, `pm: claim ${id}`);
    return `${id} claimed by ${wt}`;
  },

  log(cwd, [id, ...args]) {
    const v = strings(args, ['did', 'next']);
    if (!id || !v.did || !v.next) fail('usage: pm log <id> --did "..." --next "..."');
    const pm = requireBoard(cwd);
    appendLog(pm, id, { worktree: worktreeName(cwd), did: v.did, next: v.next, date: today() });
    persist(pm, `pm: log ${id}`);
    return `${id} logged`;
  },

  show(cwd, [id]) {
    if (!id) fail('usage: pm show <id>');
    return showTask(requireBoard(cwd), cwd, id);
  },

  decision(cwd, args) {
    const v = strings(args, ['title', 'why', 'rejected', 'tasks']);
    if (!v.title || !v.why || !v.rejected) fail('usage: pm decision --title T --why W --rejected R [--tasks T-001]');
    const pm = requireBoard(cwd);
    const id = appendDecision(pm, { title: v.title, why: v.why, rejected: v.rejected, tasks: list(v.tasks), date: today() });
    persist(pm, `pm: decision ${id}`);
    return `${id} recorded`;
  },

  ready(cwd, args) {
    const v = parseArgs({ args, options: { epic: { type: 'string' }, all: { type: 'boolean' } } }).values;
    if (v.all && v.epic !== undefined) fail('usage: pm ready [--epic KEY | --all]');
    const all = listTasks(requireBoard(cwd));
    const hasEpics = all.some((t) => t.data.epic);
    const epic = v.all ? '' : (v.epic?.trim() ?? activeEpic(all, worktreeName(cwd)));
    if (epic && v.epic !== undefined && !all.some((t) => t.data.epic === epic)) fail(`unknown epic "${epic}" — pm epics lists them`);
    // Say when the list is narrowed, and when it could not be: a silent subset reads as "nothing else exists".
    const head = epic
      ? `# epic ${epic} · pm ready --all for every direction`
      : hasEpics && !v.all ? '# no epic for this worktree yet — start yours with: pm task new --epic KEY' : '';
    const body = byEpic(readyQueue(all), epic).map((t) => `${t.id} ${t.data.title}${!epic && t.data.epic ? ` (${t.data.epic})` : ''}`).join('\n') || '(nothing ready)';
    return head ? `${head}\n${body}` : body;
  },

  epics(cwd) {
    const pm = requireBoard(cwd);
    const all = listTasks(pm);
    const keys = [...new Set(all.map((t) => t.data.epic))].sort((a, b) => (a === '') - (b === '')); // first appearance, repo-wide last
    if (!keys.some(Boolean)) return '(no epics)';
    const known = new Set(keys.filter(Boolean));
    return keys.map((e) => {
      const ts = all.filter((t) => t.data.epic === e && t.data.status !== 'dropped');
      const open = ts.filter(isOpen).length;
      const focus = e ? currentFocus(pm, e, known) : '';
      return `${e || '(none)'} · ${open}/${ts.length} open${e && !open && ts.length ? ' · closed' : ''}${focus ? ` · focus: ${focus}` : ''}`;
    }).join('\n');
  },

  validate(cwd) {
    const problems = validate(listTasks(requireBoard(cwd)));
    if (!problems.length) return 'ok';
    process.exitCode = 1;
    return problems.join('\n');
  },

  board(cwd) {
    const pm = requireBoard(cwd);
    writeBoard(pm);
    return path.join(pm, 'board.html');
  },

  scan(cwd) {
    requireBoard(cwd);
    return scanPlans(cwd).map((p) => `${p.done}/${p.total}  ${p.path}`).join('\n') || '(no plans found)';
  },

  sync(cwd, [sub, ...args]) {
    if (sub === 'on') {
      const v = parseArgs({ args, options: { remote: { type: 'string' }, yes: { type: 'boolean' } } }).values;
      const url = syncTarget(cwd, v.remote);
      if (!url) fail('this project has no origin remote; pass --remote <url>');
      if (!v.yes) {
        return `The board (and auto-memory, unless git config pm.syncMemory false) will be pushed to ${url} (branch pm).
If that repository is public, they become public; use --remote <private-url> instead.
Re-run with --yes to proceed.`;
      }
      if (hasBoard(cwd)) commitPm(pmDir(cwd), 'pm: before sync on');
      const r = syncOn(cwd, url);
      let mem = '';
      if (memorySyncEnabled(cwd)) {
        const m = linkMemory(cwd, r.pm);
        persist(r.pm, 'pm: link memory');
        mem = m.linked
          ? `\nmemory linked${m.moved.length ? ` (moved: ${m.moved.join(', ')})` : ''}`
            + `${m.clashes.length ? `; clashes kept as <name>.${os.hostname()}.md: ${m.clashes.join(', ')}` : ''}`
          : `\nmemory NOT linked: ${memoryDir(cwd)} is already a link elsewhere`;
      }
      return (r.conflict ? conflictHelp(r.pm) : `sync on (${r.mode}): ${url} branch pm`) + mem;
    }
    if (sub === 'off') {
      syncOff(requireBoard(cwd));
      return 'sync off; the local board is kept. To delete the remote branch: git push <remote> --delete pm';
    }
    if (sub) fail('usage: pm sync [on [--remote url] [--yes] | off]');
    const pm = requireBoard(cwd);
    if (!isSyncOn(pm)) fail('sync is off for this project — run: pm sync on');
    commitPm(pm, 'pm: sync');
    const r = pushNow(pm);
    writeBoard(pm);
    if (r === 'conflict') return conflictHelp(pm);
    return r === 'ok' ? 'synced' : 'offline — changes are committed locally and will be pushed later';
  },

  _push(cwd, [pm]) {
    pushNow(pm);
    return '';
  },

  // Hooks must never break a session: every path returns normally, errors are swallowed.
  // Everything that touches `input` lives inside this one try/catch, so a stdin payload
  // that parses to something falsy-but-not-an-object (null, 5, "text", []) can't throw
  // past this command.
  hook(cwd, [event]) {
    try {
      let input;
      try {
        input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
      } catch {
        input = {};
      }
      if (typeof input !== 'object' || input === null || Array.isArray(input)) input = {};
      const at = input.cwd || cwd;
      const handlers = {
        'session-start': () => onSessionStart(input, at),
        'post-tool-use': () => onPostToolUse(input, at),
        stop: () => onStop(input, at),
        'pre-compact': () => onSafetyNote(input, at, 'pre-compact'),
        'session-end': () => onSafetyNote(input, at, 'session-end'),
      };
      return handlers[event]?.() ?? '';
    } catch (e) {
      if (process.env.PM_DEBUG) console.error(e);
      return '';
    }
  },

  help() {
    return `${USAGE}\n\n${PHRASES}`;
  },

  summary(cwd) {
    return buildSummary({ pm: requireBoard(cwd), worktree: worktreeName(cwd), scriptPath: SCRIPT });
  },
};

async function main() {
  const [arg, ...args] = process.argv.slice(2);
  // --help anywhere shows help instead of running the command (`pm init --help` must not create a board).
  // `hook` is exempt: it is called by Claude Code, never by a person.
  const asksHelp = [arg, ...args].some((a) => a === '-h' || a === '--help');
  const cmd = asksHelp && arg !== 'hook' ? 'help' : arg;
  const run = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
  if (!run) fail(USAGE);
  const out = await run(process.cwd(), args);
  if (out) console.log(out);
}

main().catch((e) => {
  console.error(e instanceof UsageError ? e.message : `pm: ${e.message}`);
  process.exit(1);
});
