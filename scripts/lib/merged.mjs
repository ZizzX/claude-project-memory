import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tryGit } from './paths.mjs';
import { readState, writeState } from './store.mjs';
import { defaultBranch, isDefaultIn, prLookup, parsePrUrl } from './forge.mjs';
import { listTasks, readTask, writeTask, setFields, appendLog } from './tasks.mjs';
import { captureCommits } from './gitlink.mjs';

const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));

// ponytail: fixed budgets for a board of tens of open tasks. One git log over the default branch per check
// (a huge history would want --max-count), at most 5 forge calls per background run (hundreds of open tasks
// with PRs would want a per-forge search API), a 24 h pause of forge calls after a permanent failure.
export const GIT_TIMEOUT_MS = 30_000;
export const START_GIT_TIMEOUT_MS = 5_000; // SessionStart's hook budget is 15 s, and the sync pull comes first
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
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
export function subjectHits(cwd, tasks, { timeout = GIT_TIMEOUT_MS } = {}) {
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
  const out = tryGit(['log', def.ref, ...(since ? [`--since=${since} 00:00:00`] : []), '--format=%H%x09%ct%x09%s'], cwd, { timeout, maxBuffer: GIT_MAX_BUFFER });
  if (out === null) {
    const cause = `git log ${def.ref} failed or took longer than ${timeout / 1000} s`;
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

// Runs fn under the lock; null (and fn not run) when another run holds it.
function withLock(pm, now, fn) {
  const release = acquireLock(pm, now);
  if (!release) return null;
  try {
    return fn();
  } finally {
    release();
  }
}

// A forge lookup is possible when the task has a PR URL or a branch that is not the default one.
const lookupable = (task, def) => Boolean(task.data.pr || (task.data.branch && !isDefaultIn(def, task.data.branch)));

// No prompt of any kind from a detached process: no terminal prompt, no Git Credential Manager window.
export const fetchCommand = (def) => ({
  args: ['fetch', '--quiet', def.remote, def.branch],
  opts: { timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } },
});

// Fetch the default branch, then look up PRs: at most `limit`, review tasks first, then the least recently
// checked, so every candidate gets its turn across background runs. A permanent failure (no CLI, not logged in)
// stops the lookups and pauses them for BACKOFF_MS (the fetch goes on); a timeout stops this run's lookups.
// Returns { busy } when another run holds the lock, else { checked, total }.
export function runMergeCheck({ pm, cwd, limit = Infinity, fetch = true, background = false, now = Date.now() }) {
  const release = acquireLock(pm, now);
  if (!release) return { busy: true };
  try {
    const cache = readState(pm, CACHE);
    cache.tasks ??= {};
    if (!background) delete cache.backoff; // pm reconcile is the user retrying: try the forge again
    const def = defaultBranch(cwd);
    if (fetch) {
      const { args, opts } = def ? fetchCommand(def) : {};
      cache.fetchError = !def
        ? problem('Fetch skipped', 'origin has no default branch here', 'git fetch origin')
        : tryGit(args, cwd, opts) === null
          ? problem(`git fetch ${def.remote} ${def.branch} failed`, `offline, no access, or slower than ${GIT_TIMEOUT_MS / 1000} s`, `git fetch ${def.remote} ${def.branch}, then pm reconcile`)
          : null;
    }
    const candidates = mergeCandidates(listTasks(pm)).filter((t) => lookupable(t, def));
    const last = (t) => cachedLookup(cache, t)?.checkedAt ?? 0;
    const rank = (t) => (t.data.status === 'review' ? 0 : 1);
    const queue = cache.backoff?.until > now ? [] : [...candidates].sort((a, b) => rank(a) - rank(b) || last(a) - last(b)).slice(0, limit);
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
      if (r.timeout) break; // offline: every other lookup would wait just as long
    }
    cache.checkedAt = now;
    writeState(pm, CACHE, cache);
    return { checked, total: candidates.length };
  } finally {
    release();
  }
}

// SessionStart: never waits on the network. Starts one detached background run when the cache is older than
// REFRESH_AFTER_MS and no run holds the lock (a forge pause still fetches). true when it spawned.
export function refreshInBackground(pm, cwd, { now = Date.now(), spawnFn = spawn } = {}) {
  if (process.env.PM_NO_BACKGROUND) return false;
  const cache = readState(pm, CACHE);
  if (now - (cache.checkedAt ?? 0) < REFRESH_AFTER_MS) return false;
  const lock = lockFile(pm);
  if (fs.existsSync(lock) && !lockStale(lock, now)) return false;
  spawnFn(process.execPath, [PM_SCRIPT, '_merge-check', pm], { cwd, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return true;
}

// --- what closes by itself, what is only asked ---

// git normalizes false / no / off / 0; an unreadable value keeps the default.
export const autoCloseEnabled = (cwd) => tryGit(['config', '--type=bool', '--get', 'pm.autoClose'], cwd) !== 'false';

const prLabel = (url) => {
  const n = parsePrUrl(url ?? '')?.number;
  return n ? `#${n}` : null;
};
const unixOf = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : NaN);
const snapshot = (t) => ({ status: t.data.status, pr: t.data.pr ?? '', review_at: t.data.review_at ?? '' });

// Sorts open tasks by what the merge signals say. Pure over its inputs: `local` = subjectHits(), the forge cache.
//   close      — review tasks whose own merge came at or after `pm done` (pm.autoClose=false moves them to ask)
//   ask        — every other merge hit: shown, never closed without the user (a review task without a readable
//                review_at, e.g. set by hand, is asked about too)
//   conflicts  — the task's PR comes from another branch than the task's: never closed (a task claimed on the
//                default branch is not a conflict: its PR necessarily comes from another branch)
//   awaiting   — review tasks checked and not merged yet, with days since review_at
//   notChecked — review tasks nobody could check, with the reason
// Each item: { id, how, sha, pr, at, snapshot } (snapshot = what the task looked like, re-checked before a write).
export function classify({ tasks, local, cache, autoClose = true, now = Date.now() }) {
  const { hits: subject, branch } = local;
  const out = { close: [], ask: [], conflicts: [], awaiting: [], notChecked: [] };
  for (const t of mergeCandidates(tasks)) {
    const entry = cachedLookup(cache, t);
    const conflict = Boolean(t.data.pr && t.data.branch && !isDefaultIn(branch, t.data.branch) && entry?.head && entry.head !== t.data.branch);
    if (conflict) {
      out.conflicts.push({ id: t.id, pr: t.data.pr, prBranch: entry.head, branch: t.data.branch });
    }
    const forge = !conflict && entry?.state === 'merged' && branch && entry.base === branch.branch
      ? { how: 'forge', sha: entry.mergeSha, pr: prLabel(entry.url), at: entry.mergedAt }
      : null;
    const byId = subject.get(t.id) ?? null;
    const reviewAt = unixOf(t.data.review_at);
    const timed = Number.isFinite(reviewAt);
    const own = t.data.status === 'review' && timed && !conflict && [forge, byId].find((h) => h && h.at >= reviewAt);
    if (own) {
      (autoClose ? out.close : out.ask).push({ id: t.id, ...own, snapshot: snapshot(t) });
      continue;
    }
    const hit = forge ?? byId;
    // A review task whose only merge predates `pm done` (the first of two PRs) is still awaiting its own merge.
    if (hit && (t.data.status !== 'review' || !timed)) {
      out.ask.push({ id: t.id, ...hit, snapshot: snapshot(t) });
      continue;
    }
    if (t.data.status !== 'review') continue;
    const days = timed ? Math.floor((now / 1000 - reviewAt) / 86_400) : 0;
    const reason = entry?.lastError ?? (entry || !local.cause ? null : local.cause);
    if (reason) out.notChecked.push({ id: t.id, reason, days });
    else out.awaiting.push({ id: t.id, pr: prLabel(entry?.url ?? t.data.pr), days });
  }
  return out;
}

// Closes one merged task, unless it changed since it was classified (status, pr or review_at): fields and the Log
// line in one read and one write. true when written; a task that cannot be read or written is left as it is.
export function closeMerged(pm, item, { date, note }) {
  try {
    const task = readTask(pm, item.id);
    const now = snapshot(task);
    if (Object.keys(now).some((k) => now[k] !== item.snapshot[k])) return false;
    Object.assign(task.data, { status: 'done', waiting_on: '', merged_sha: item.sha ?? '', merged_how: item.how, merged_at: item.at ? new Date(item.at * 1000).toISOString() : '', updated: date });
    delete task.data.review_at;
    const what = [item.sha ? item.sha.slice(0, 7) : null, item.pr ? `(${item.pr})` : null].filter(Boolean).join(' ');
    task.body = `${task.body.replace(/\n*$/, '\n')}- ${date} · pm · merged ${what || 'on the default branch'}, ${note}\n`;
    writeTask(task);
    return true;
  } catch {
    return false;
  }
}

// Closes items under the merge lock, so two sessions starting at once never close the same task twice.
// null when another run holds the lock (nothing closed now; the next start or pm reconcile closes them).
const closeAll = (pm, items, opts, now) => withLock(pm, now, () => items.filter((item) => closeMerged(pm, item, opts)));

// --- pm reconcile: the same work in the foreground, every candidate, with the lists printed ---

export const AWAITING_DAYS = 7;

const mergeLabel = (hit, branch) => hit.pr ?? `${branch?.branch ?? 'default branch'} ${String(hit.sha ?? '').slice(0, 7)}`.trim();

function notCheckedFix(id, reason) {
  const cli = reason.match(/^(gh|glab) /)?.[1];
  if (/is not installed/.test(reason)) return `install ${cli}, run ${cli} auth login, then pm reconcile`;
  if (/not logged in/.test(reason)) return `${cli} auth login, then pm reconcile`;
  if (/unknown PR URL|not found on the forge|the PR is on /.test(reason)) return `pm set ${id} pr=<the GitHub PR or GitLab MR url on origin's host>`;
  return 'pm reconcile again when online';
}

// Checks every open task, closes what may close by itself, and with yes the asked ones: all of them (true) or only
// the listed ids. Returns the lines to print and the closed ids. Never throws on git or forge failures: they become
// "problem — cause — fix" lines.
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
  if (fetch && !run.busy && cache.fetchError) lines.push(cache.fetchError);
  if (local.notChecked) lines.push(local.notChecked);
  const out = classify({ tasks, local, cache, autoClose: autoCloseEnabled(cwd), now });
  const chosen = yes === true ? out.ask : yes ? out.ask.filter((a) => yes.includes(a.id)) : [];
  const auto = closeAll(pm, out.close, { date, note: 'closed automatically' }, now);
  const confirmed = closeAll(pm, chosen, { date, note: 'closed by pm reconcile --yes' }, now);
  if (!auto || !confirmed) lines.push(problem('Not closed now', 'a background merge check is running', 'pm reconcile again in a minute'));
  const closed = [...(auto ?? []), ...(confirmed ?? [])];
  const label = (x) => `${x.id} (${mergeLabel(x, local.branch)})`;
  if (closed.length) lines.push(`Closed: ${closed.map(label).join(', ')}`);
  if (Array.isArray(yes)) {
    const unknown = yes.filter((id) => !out.ask.some((a) => a.id === id));
    if (unknown.length) lines.push(problem(`Not closed: ${unknown.join(', ')}`, 'no merge of these open tasks was found', 'pm reconcile to see the list'));
  }
  const left = out.ask.filter((a) => !closed.includes(a));
  if (left.length) {
    lines.push(`Merged, still open: ${left.map(label).join(', ')} — close the confirmed ones: pm reconcile --yes <ids>, or pm set <id> status=done`);
  }
  for (const c of out.conflicts) {
    lines.push(problem(`PR conflict: ${c.id}`, `pr ${c.pr} comes from branch ${c.prBranch}, the task's branch is ${c.branch}`, `pm set ${c.id} pr=<the PR of ${c.branch}>`));
  }
  for (const a of out.awaiting.filter((x) => x.days >= AWAITING_DAYS)) lines.push(`Awaiting merge ${a.days} days: ${a.id}${a.pr ? ` (${a.pr})` : ''}`);
  for (const n of out.notChecked) lines.push(problem(`Merge not checked: ${n.id}`, n.reason, notCheckedFix(n.id, n.reason)));
  if (lines.length === 1 && !run.busy) lines.push(`Nothing merged among ${mergeCandidates(tasks).length} open tasks.`);
  return { lines, closed: closed.map((c) => c.id) };
}

// --- pm done: finished and verified; done now, or review until the merge closes it ---

const hasLogEntry = (task) => /^- \d{4}-\d{2}-\d{2} · /m.test(task.body);

// Unix time of the task's newest linked commit; null when there are none or one was rewritten away.
function newestCommitAt(cwd, shas) {
  if (!shas?.length) return null;
  const times = (tryGit(['show', '-s', '--format=%ct', ...shas], cwd) ?? '').split('\n').map(Number).filter((n) => n > 0);
  return times.length === shas.length ? Math.max(...times) : null;
}

// Decides and writes done or review. A merge is expected when the task has a `pr` or captured `commits`
// (a branch alone does not count: pm claim records one even for research). noMerge forces done, pr forces the
// merge path. Returns { status, line } — the line says the outcome and why.
export function markDone({ pm, cwd, id, did, pr, noMerge = false, worktree, date, now = Date.now() }) {
  if (pr && noMerge) throw new Error('usage: pm done <id> [--did "..."] [--pr <url> | --no-merge]');
  if (pr && !parsePrUrl(pr)) throw new Error(`unknown PR URL "${pr}" — expected a GitHub PR or GitLab MR url`);
  const before = readTask(pm, id);
  if (!OPEN_FOR_MERGE.includes(before.data.status)) throw new Error(`${id} is already ${before.data.status}`);
  if (!did && !hasLogEntry(before)) throw new Error(`${id} has no Log entry yet — say what was done: pm done ${id} --did "..."`);
  captureCommits(pm, cwd); // commits made since the last Stop still belong to this task
  const task = readTask(pm, id);
  const data = { ...task.data, ...(pr && { pr }) };
  const commits = data.commits?.length ?? 0;
  const expects = !noMerge && Boolean(data.pr || commits);
  const finish = (status, fields, why, next) => {
    setFields(pm, id, { status, ...fields }, date);
    if (did) appendLog(pm, id, { worktree, did, next, date });
    return { status, line: `${id} → ${status}: ${why}` };
  };
  if (!expects) {
    return finish('done', {}, noMerge ? '--no-merge' : 'no PR or commits, nothing to merge', '—');
  }
  const r = prLookup(data, cwd);
  const found = r.status === 'ok' ? r.pr : null;
  const label = prLabel(found?.url ?? data.pr) ?? (found?.url || null);
  const def = defaultBranch(cwd);
  // A merge older than the task's newest commit cannot contain it: an earlier PR of a reused branch.
  const latest = newestCommitAt(cwd, data.commits);
  const covers = (at) => latest == null || at >= latest;
  const intoDefault = !found?.base || !def || found.base === def.branch;
  const stale = found?.state === 'merged' && found.foundByBranch && !covers(found.mergedAt);
  const unix = (at) => (at ? new Date(at * 1000).toISOString() : '');
  if (found?.state === 'merged' && intoDefault && !stale) {
    return finish('done', { pr: found.url, merged_sha: found.mergeSha ?? found.squashSha ?? '', merged_how: 'forge', merged_at: unix(found.mergedAt) }, `${label} is already merged`, '—');
  }
  // The forge cannot confirm (no CLI, offline, no PR), but the default branch already has a commit naming the task.
  const hit = found?.state === 'open' ? null : subjectHits(cwd, [task]).hits.get(id);
  if (hit && covers(hit.at)) {
    const where = `${hit.sha.slice(0, 7)}${hit.pr ? ` (${hit.pr})` : ''} is already on ${def?.branch ?? 'the default branch'}`;
    return finish('done', { merged_sha: hit.sha, merged_how: 'subject', merged_at: unix(hit.at) }, where, '—');
  }
  const fields = { review_at: new Date(now).toISOString(), ...((pr || (found?.url && !stale)) && { pr: pr || found.url }) };
  const why = !found ? (r.status === 'error' ? `merge not checked (${r.cause})` : `${commits} commit${commits === 1 ? '' : 's'}, no PR found`)
    : stale ? `${label} was merged before this task's last commit, no newer PR found`
      : found.state === 'merged' ? `${label} was merged into ${found.base}, not ${def?.branch}`
        : found.state === 'closed' ? `${label} was closed without merging`
          : `${label} not merged yet`;
  const after = autoCloseEnabled(cwd)
    ? 'closes by itself after the merge (git config pm.autoClose false turns that off)'
    : 'pm reconcile asks to close it after the merge (pm.autoClose is false)';
  return finish('review', fields, `${why}; ${after}`, `merge ${label ?? 'the commits'} into the default branch`);
}

// --- session start: local refs and the cache only, never the network ---

// Closes the review tasks whose own merge is already known, starts a background refresh when the cache is stale,
// and returns the summary's merge lines. The caller commits the board when `closedIds` is not empty.
export function mergeAtStart({ pm, cwd, tasks, date, now = Date.now() }) {
  const local = subjectHits(cwd, tasks, { timeout: START_GIT_TIMEOUT_MS });
  const out = classify({ tasks, local, cache: readState(pm, CACHE), autoClose: autoCloseEnabled(cwd), now });
  const closed = closeAll(pm, out.close, { date, note: 'closed automatically' }, now) ?? [];
  refreshInBackground(pm, cwd, { now });
  const label = (x) => `${x.id} (${mergeLabel(x, local.branch)})`;
  return {
    closedIds: closed.map((x) => x.id),
    closed: closed.map(label),
    ask: out.ask.map(label),
    conflicts: out.conflicts.map((c) => c.id),
  };
}
