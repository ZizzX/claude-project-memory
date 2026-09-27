import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tryGit } from './paths.mjs';
import { readState, writeState } from './store.mjs';
import { defaultBranch, isDefaultBranch, prLookup, parsePrUrl } from './forge.mjs';
import { listTasks, readTask, setFields, appendLogLine } from './tasks.mjs';

const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));

// ponytail: fixed budgets for a board of tens of open tasks. One git log over the default branch per check
// (a huge history would want --max-count), at most 5 forge calls per background run (hundreds of open tasks
// with PRs would want a per-forge search API), a 24 h pause after a permanent failure.
export const GIT_TIMEOUT_MS = 30_000;
export const REFRESH_AFTER_MS = 30 * 60_000;
export const BACKGROUND_LOOKUPS = 5;
export const LOCK_STALE_MS = 10 * 60_000;
export const BACKOFF_MS = 24 * 3_600_000;
export const CACHE = 'merge-check';
const HINT_STATE = 'merge-hint';

export const OPEN_FOR_MERGE = ['todo', 'in_progress', 'waiting', 'review'];
export const mergeCandidates = (tasks) => tasks.filter((t) => OPEN_FOR_MERGE.includes(t.data.status));

// Every failure the merge code prints: what happened — why — the command that fixes it.
export const problem = (what, cause, fix) => `${what} — ${cause} — fix: ${fix}`;

// A task id in a commit subject: the conventional-commit scope `feat(T-038): …` or a bracket `[T-038]`.
// Only the subject counts: a body saying "after T-041" is not a merge of T-041.
const SCOPE_RE = /^[a-z]+\(([A-Z][A-Z0-9]*-\d+)\)!?:/i;
const BRACKET_RE = /\[([A-Z][A-Z0-9]*-\d+)\]/g;
const PR_RE = /\(#(\d+)\)\s*$/;

export function subjectIds(subject) {
  const ids = new Set([...subject.matchAll(BRACKET_RE)].map((m) => m[1]));
  const scope = subject.match(SCOPE_RE);
  if (scope) ids.add(scope[1]);
  return ids;
}

const firstLogDate = (task) => task.body.match(/^- (\d{4}-\d{2}-\d{2}) · /m)?.[1];

// The oldest date any candidate could have been merged after: its first Log entry, else its last update.
export function sinceDate(tasks) {
  const dates = tasks.map((t) => firstLogDate(t) ?? t.data.updated).filter(Boolean).map(String).sort();
  return dates[0] ?? null;
}

// Local signal, no network: subjects on origin's default branch that name an open task.
// { branch, hits: Map<id, { how, sha, at, pr }> (newest commit per id), cause, notChecked } — never throws.
export function subjectHits(cwd, tasks) {
  const candidates = mergeCandidates(tasks);
  const def = defaultBranch(cwd);
  const hits = new Map();
  if (!def) {
    const cause = 'origin has no default branch here (no origin/HEAD, origin/main or origin/master)';
    return { branch: null, hits, cause, notChecked: problem('Merge not checked', cause, 'git fetch origin, then pm reconcile') };
  }
  if (!candidates.length) return { branch: def, hits, notChecked: null };
  const ids = new Set(candidates.map((t) => t.id));
  const since = sinceDate(candidates);
  const out = tryGit(['log', def.ref, ...(since ? [`--since=${since} 00:00:00`] : []), '--format=%H%x09%ct%x09%s'], cwd, { timeout: GIT_TIMEOUT_MS });
  if (out === null) {
    const cause = `git log ${def.ref} failed or took longer than ${GIT_TIMEOUT_MS / 1000} s`;
    return { branch: def, hits, cause, notChecked: problem('Merge not checked', cause, 'git fetch origin, then pm reconcile') };
  }
  for (const line of out.split('\n')) {
    const [sha, ct, ...rest] = line.split('\t');
    if (!sha || !ct) continue;
    const subject = rest.join('\t');
    for (const id of subjectIds(subject)) {
      if (!ids.has(id) || hits.has(id)) continue; // git log is newest first: the first hit is the latest merge
      const pr = subject.match(PR_RE)?.[1];
      hits.set(id, { how: 'subject', sha, at: Number(ct), pr: pr ? `#${pr}` : null });
    }
  }
  return { branch: def, hits, notChecked: null };
}

// The origin/HEAD fix, printed once per repo: main/master was a guess.
export function originHeadHint(pm, def) {
  if (!def?.guessed || readState(pm, HINT_STATE).shown) return null;
  writeState(pm, HINT_STATE, { shown: true });
  return `origin/HEAD is not set, so ${def.ref} is assumed to be the default branch — fix: git remote set-head origin -a`;
}

// --- forge signal: a cache filled by a background run (or pm reconcile), read without network ---

// What a cache entry was looked up for: the task's `pr`, else its branch. An entry for another key never counts,
// so after `pm set T-NNN pr=<new>` the old PR's answer is ignored.
export const lookupKey = (data) => (data.pr ? String(data.pr) : data.branch ? `branch:${data.branch}` : null);

export function cachedLookup(cache, task) {
  const entry = cache.tasks?.[task.id];
  return entry && entry.key === lookupKey(task.data) ? entry : null;
}

// One exclusive lock file serializes background runs and pm reconcile; a lock older than LOCK_STALE_MS
// (a crashed run) is taken over. Returns a release function, or null when another run holds it.
const lockFile = (pm) => path.join(pm, '.state', `${CACHE}.lock`);

export function acquireLock(pm, now = Date.now()) {
  const file = lockFile(pm);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if (e.code !== 'EEXIST' || !lockStale(file, now)) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

function lockStale(file, now) {
  let at;
  try {
    at = JSON.parse(fs.readFileSync(file, 'utf8')).at;
  } catch {
    at = null;
  }
  if (!Number.isFinite(at)) at = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0; // half-written lock
  return now - at > LOCK_STALE_MS;
}

// A forge lookup is possible when the task has a PR URL or a branch that is not the default one.
const lookupable = (task, cwd) => Boolean(task.data.pr || (task.data.branch && !isDefaultBranch(cwd, task.data.branch)));

export const fetchCommand = (def) => ({
  args: ['fetch', '--quiet', def.remote, def.branch],
  opts: { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
});

// Fetch the default branch, then look up PRs: at most `limit`, the least recently checked first, so every
// candidate gets its turn across background runs. A permanent failure (no CLI, not logged in) stops the run and
// pauses background runs for BACKOFF_MS. Returns { busy } when another run holds the lock, else { checked, total }.
export function runMergeCheck({ pm, cwd, limit = Infinity, fetch = true, background = false, now = Date.now() }) {
  const release = acquireLock(pm, now);
  if (!release) return { busy: true };
  try {
    const cache = readState(pm, CACHE);
    cache.tasks ??= {};
    if (!background) delete cache.backoff; // pm reconcile is the user retrying: try the forge again
    if (fetch) {
      const def = defaultBranch(cwd);
      const { args, opts } = def ? fetchCommand(def) : {};
      cache.fetchError = !def
        ? problem('Fetch skipped', 'origin has no default branch here', 'git fetch origin')
        : tryGit(args, cwd, opts) === null
          ? problem(`git fetch ${def.remote} ${def.branch} failed`, `offline, no access, or slower than ${GIT_TIMEOUT_MS / 1000} s`, `git fetch ${def.remote} ${def.branch}, then pm reconcile`)
          : null;
    }
    const candidates = mergeCandidates(listTasks(pm)).filter((t) => lookupable(t, cwd));
    const last = (t) => cachedLookup(cache, t)?.checkedAt ?? 0;
    const queue = cache.backoff?.until > now ? [] : [...candidates].sort((a, b) => last(a) - last(b)).slice(0, limit);
    let checked = 0;
    for (const task of queue) {
      const r = prLookup(task.data, cwd);
      checked += 1;
      const pr = r.status === 'ok' ? r.pr : null;
      cache.tasks[task.id] = {
        key: lookupKey(task.data),
        checkedAt: now,
        state: pr?.state ?? (r.status === 'none' ? 'none' : null),
        url: pr?.url ?? null,
        base: pr?.base ?? null,
        head: pr?.head ?? null,
        mergeSha: pr?.mergeSha ?? pr?.squashSha ?? null,
        mergedAt: pr?.mergedAt ?? null,
        foundByBranch: Boolean(pr?.foundByBranch),
        lastError: r.status === 'error' ? r.cause : null,
      };
      if (r.status === 'error' && r.permanent && r.cli) {
        cache.backoff = { until: now + BACKOFF_MS, cause: r.cause };
        break; // every other lookup would fail the same way
      }
    }
    cache.checkedAt = now;
    writeState(pm, CACHE, cache);
    return { checked, total: candidates.length };
  } finally {
    release();
  }
}

// SessionStart: never waits on the network. Starts one detached background run when the cache is older than
// REFRESH_AFTER_MS, no run holds the lock and no permanent failure is being waited out. true when it spawned.
export function refreshInBackground(pm, cwd, { now = Date.now(), spawnFn = spawn } = {}) {
  if (process.env.PM_NO_BACKGROUND) return false;
  const cache = readState(pm, CACHE);
  if (now - (cache.checkedAt ?? 0) < REFRESH_AFTER_MS) return false;
  if (cache.backoff?.until > now) return false;
  const lock = lockFile(pm);
  if (fs.existsSync(lock) && !lockStale(lock, now)) return false;
  spawnFn(process.execPath, [PM_SCRIPT, '_merge-check', pm], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

// --- what closes by itself, what is only asked ---

export const autoCloseEnabled = (cwd) => tryGit(['config', '--get', 'pm.autoClose'], cwd) !== 'false';

const prLabel = (url) => {
  const n = parsePrUrl(url ?? '')?.number;
  return n ? `#${n}` : null;
};
const unixOf = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : NaN);
const snapshot = (t) => ({ status: t.data.status, pr: t.data.pr ?? '', review_at: t.data.review_at ?? '' });

// Sorts open tasks by what the merge signals say. Pure over its inputs: `local` = subjectHits(), the forge cache.
//   close      — review tasks whose own merge came at or after `pm done` (pm.autoClose=false moves them to ask)
//   ask        — every other merge hit: shown, never closed without the user
//   conflicts  — the task's PR comes from another branch than the task's: never closed
//   awaiting   — review tasks checked and not merged yet, with days since review_at
//   notChecked — review tasks nobody could check, with the reason
// Each item: { id, how, sha, pr, at, snapshot } (snapshot = what the task looked like, re-checked before a write).
export function classify({ tasks, local, cache, autoClose = true, now = Date.now() }) {
  const { hits: subject, branch } = local;
  const out = { close: [], ask: [], conflicts: [], awaiting: [], notChecked: [] };
  for (const t of mergeCandidates(tasks)) {
    const entry = cachedLookup(cache, t);
    const conflict = Boolean(t.data.pr && t.data.branch && entry?.head && entry.head !== t.data.branch);
    if (conflict) {
      out.conflicts.push({ id: t.id, pr: t.data.pr, prBranch: entry.head, branch: t.data.branch });
    }
    const forge = !conflict && entry?.state === 'merged' && branch && entry.base === branch.branch
      ? { how: 'forge', sha: entry.mergeSha, pr: prLabel(entry.url), at: entry.mergedAt }
      : null;
    const byId = subject.get(t.id) ?? null;
    const reviewAt = unixOf(t.data.review_at);
    const own = t.data.status === 'review' && !conflict && [forge, byId].find((h) => h && h.at >= reviewAt);
    if (own) {
      (autoClose ? out.close : out.ask).push({ id: t.id, ...own, snapshot: snapshot(t) });
      continue;
    }
    const hit = forge ?? byId;
    // A review task whose only merge predates `pm done` (the first of two PRs) is still awaiting its own merge.
    if (hit && t.data.status !== 'review') {
      out.ask.push({ id: t.id, ...hit, snapshot: snapshot(t) });
      continue;
    }
    if (t.data.status !== 'review') continue;
    const days = Number.isFinite(reviewAt) ? Math.floor((now / 1000 - reviewAt) / 86_400) : 0;
    const reason = entry?.lastError ?? (entry || !local.cause ? null : local.cause);
    if (reason) out.notChecked.push({ id: t.id, reason, days });
    else out.awaiting.push({ id: t.id, pr: prLabel(entry?.url ?? t.data.pr), days });
  }
  return out;
}

// Closes one merged task, unless it changed since it was classified (status, pr or review_at). true when written.
export function closeMerged(pm, item, { date, note }) {
  const task = readTask(pm, item.id);
  const now = snapshot(task);
  if (Object.keys(now).some((k) => now[k] !== item.snapshot[k])) return false;
  const fields = { status: 'done', merged_sha: item.sha ?? '', merged_how: item.how, merged_at: item.at ? new Date(item.at * 1000).toISOString() : '' };
  setFields(pm, item.id, fields, date);
  const what = [item.sha ? item.sha.slice(0, 7) : null, item.pr ? `(${item.pr})` : null].filter(Boolean).join(' ');
  appendLogLine(pm, item.id, `- ${date} · pm · merged ${what || 'on the default branch'}, ${note}`, date);
  return true;
}

// --- pm reconcile: the same work in the foreground, every candidate, with the lists printed ---

export const AWAITING_DAYS = 7;

const mergeLabel = (hit, branch) => hit.pr ?? `${branch?.branch ?? 'default branch'} ${String(hit.sha ?? '').slice(0, 7)}`.trim();

function notCheckedFix(id, reason) {
  const cli = reason.match(/^(gh|glab) /)?.[1];
  if (/is not installed/.test(reason)) return `install ${cli}, run ${cli} auth login, then pm reconcile`;
  if (/not logged in/.test(reason)) return `${cli} auth login, then pm reconcile`;
  if (/unknown PR URL|not found on the forge/.test(reason)) return `pm set ${id} pr=<the GitHub PR or GitLab MR url>`;
  return 'pm reconcile again when online';
}

// Checks every open task, closes what may close by itself (and with yes, what was asked), returns the lines to
// print and the closed ids. Never throws on git or forge failures: they become "problem — cause — fix" lines.
export function reconcile({ pm, cwd, yes = false, fetch = true, date, now = Date.now() }) {
  const lines = [];
  const run = runMergeCheck({ pm, cwd, fetch, now });
  if (run.busy) lines.push(problem('Forge not checked now', 'a background merge check is running', 'pm reconcile again in a minute'));
  else lines.push(`checked ${run.checked} of ${run.total} tasks with a PR or branch`);
  const tasks = listTasks(pm);
  const local = subjectHits(cwd, tasks);
  const cache = readState(pm, CACHE);
  const hint = originHeadHint(pm, local.branch);
  if (hint) lines.push(hint);
  if (cache.fetchError) lines.push(cache.fetchError);
  if (local.notChecked) lines.push(local.notChecked);
  const out = classify({ tasks, local, cache, autoClose: autoCloseEnabled(cwd), now });
  const closed = [];
  const close = (items, note) => {
    for (const item of items) {
      if (closeMerged(pm, item, { date, note })) closed.push(`${item.id} (${mergeLabel(item, local.branch)})`);
    }
  };
  close(out.close, 'closed automatically');
  if (yes) close(out.ask, 'closed by pm reconcile --yes');
  if (closed.length) lines.push(`Closed: ${closed.join(', ')}`);
  if (!yes && out.ask.length) {
    lines.push(`Merged, still open: ${out.ask.map((a) => `${a.id} (${mergeLabel(a, local.branch)})`).join(', ')} — close them: pm reconcile --yes, or one by one: pm set <id> status=done`);
  }
  for (const c of out.conflicts) {
    lines.push(problem(`PR conflict: ${c.id}`, `pr ${c.pr} comes from branch ${c.prBranch}, the task's branch is ${c.branch}`, `pm set ${c.id} pr=<the PR of ${c.branch}>`));
  }
  for (const a of out.awaiting.filter((x) => x.days >= AWAITING_DAYS)) lines.push(`Awaiting merge ${a.days} days: ${a.id}${a.pr ? ` (${a.pr})` : ''}`);
  for (const n of out.notChecked) lines.push(problem(`Merge not checked: ${n.id}`, n.reason, notCheckedFix(n.id, n.reason)));
  if (lines.length === 1) lines.push(`Nothing merged among ${mergeCandidates(tasks).length} open tasks.`);
  return { lines, closed: closed.map((c) => c.split(' ')[0]) };
}
