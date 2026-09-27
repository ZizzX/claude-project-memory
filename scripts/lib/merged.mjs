import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tryGit } from './paths.mjs';
import { readState, writeState } from './store.mjs';
import { defaultBranch, isDefaultBranch, prLookup } from './forge.mjs';
import { listTasks } from './tasks.mjs';

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
// { branch, hits: Map<id, { how, sha, at, pr }> (newest commit per id), notChecked } — never throws.
export function subjectHits(cwd, tasks) {
  const candidates = mergeCandidates(tasks);
  const def = defaultBranch(cwd);
  const hits = new Map();
  if (!def) {
    const notChecked = problem('Merge not checked', 'origin has no default branch here (no origin/HEAD, origin/main or origin/master)', 'git fetch origin, then pm reconcile');
    return { branch: null, hits, notChecked };
  }
  if (!candidates.length) return { branch: def, hits, notChecked: null };
  const ids = new Set(candidates.map((t) => t.id));
  const since = sinceDate(candidates);
  const out = tryGit(['log', def.ref, ...(since ? [`--since=${since} 00:00:00`] : []), '--format=%H%x09%ct%x09%s'], cwd, { timeout: GIT_TIMEOUT_MS });
  if (out === null) {
    return { branch: def, hits, notChecked: problem('Merge not checked', `git log ${def.ref} failed or took longer than ${GIT_TIMEOUT_MS / 1000} s`, 'git fetch origin, then pm reconcile') };
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
