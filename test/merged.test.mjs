import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, tmp, sh } from './helpers.mjs';
import { subjectIds, sinceDate, subjectHits, originHeadHint, problem, mergeCandidates, acquireLock, runMergeCheck, refreshInBackground, cachedLookup, fetchCommand, classify, closeMerged, CACHE, LOCK_STALE_MS, BACKOFF_MS, REFRESH_AFTER_MS, BACKGROUND_LOOKUPS, GIT_TIMEOUT_MS } from '../scripts/lib/merged.mjs';
import { newTask, setFields, listTasks } from '../scripts/lib/tasks.mjs';
import { readState, writeState } from '../scripts/lib/store.mjs';

function mk(id, data = {}, body = '## Log\n') {
  return { id, file: `${id}.md`, body, data: { id, status: 'in_progress', updated: '2026-09-01', depends_on: [], worktrees: [], ...data } };
}

// A commit on the current branch with a fixed committer date; returns its SHA.
function commit(root, subject, date, body = '') {
  fs.appendFileSync(path.join(root, 'README.md'), `${subject}\n`);
  sh(['add', '-A'], root);
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  execFileSync('git', ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], { cwd: root, env });
  return sh(['rev-parse', 'HEAD'], root);
}

const publish = (root, branch = 'master') => sh(['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], root);

test('subjectIds: conventional scope and brackets, nothing else', () => {
  assert.deepEqual([...subjectIds('feat(T-038): pm alias (#10)')], ['T-038']);
  assert.deepEqual([...subjectIds('fix(PM-056)!: board')], ['PM-056']);
  assert.deepEqual([...subjectIds('[T-041] keep scroll [PM-060]')].sort(), ['PM-060', 'T-041']);
  assert.deepEqual([...subjectIds('docs: after T-041 lands')], []);
  assert.deepEqual([...subjectIds('feat(board): T-041 mention')], []);
});

test('sinceDate: the first Log date, else updated; the oldest wins', () => {
  assert.equal(sinceDate([mk('T-001', { updated: '2026-09-20' }, '## Log\n- 2026-09-10 · w · did: a · next: b\n- 2026-09-15 · w · did: c · next: d\n'), mk('T-002', { updated: '2026-09-12' })]), '2026-09-10');
  assert.equal(sinceDate([]), null);
});

test('mergeCandidates: open statuses including review, never done or dropped', () => {
  const ts = ['todo', 'in_progress', 'waiting', 'review', 'done', 'dropped'].map((s, i) => mk(`T-00${i + 1}`, { status: s }));
  assert.deepEqual(mergeCandidates(ts).map((t) => t.id), ['T-001', 'T-002', 'T-003', 'T-004']);
});

test('subjectHits: the newest subject per open task, body ignored, mixed prefixes, bounded by --since', () => {
  const { root } = setup();
  commit(root, 'feat(T-005): too old to count', '2026-08-01T10:00:00');
  const first = commit(root, 'feat(T-038): first part (#9)', '2026-09-10T10:00:00');
  const latest = commit(root, 'feat(T-038): second part (#10)', '2026-09-12T10:00:00');
  commit(root, 'docs: notes', '2026-09-12T11:00:00', 'follows T-041');
  const pm56 = commit(root, '[PM-056] board design', '2026-09-13T10:00:00');
  commit(root, 'feat(T-099): done task', '2026-09-13T11:00:00');
  publish(root);
  const tasks = [
    mk('T-005', { status: 'todo', updated: '2026-09-02' }),
    mk('T-038', { status: 'review' }),
    mk('T-041'),
    mk('PM-056', { status: 'waiting' }),
    mk('T-099', { status: 'done' }),
  ];
  const { branch, hits, notChecked } = subjectHits(root, tasks);
  assert.equal(notChecked, null);
  assert.equal(branch.ref, 'origin/master');
  assert.deepEqual([...hits.keys()].sort(), ['PM-056', 'T-038']);
  assert.deepEqual(hits.get('T-038'), { how: 'subject', sha: latest, at: Date.parse('2026-09-12T10:00:00') / 1000, pr: '#10' });
  assert.notEqual(hits.get('T-038').sha, first);
  assert.deepEqual(hits.get('PM-056'), { how: 'subject', sha: pm56, at: Date.parse('2026-09-13T10:00:00') / 1000, pr: null });
});

test('subjectHits: no default branch ref → not checked with a fix, no exception', () => {
  const { root } = setup();
  const { hits, notChecked } = subjectHits(root, [mk('T-001')]);
  assert.equal(hits.size, 0);
  assert.match(notChecked, /^Merge not checked — .+ — fix: git fetch origin, then pm reconcile$/);
});

test('originHeadHint: printed once per repo, only when main/master was guessed', () => {
  const pm = tmp();
  assert.equal(originHeadHint(pm, { ref: 'origin/trunk', guessed: false }), null);
  assert.match(originHeadHint(pm, { ref: 'origin/master', guessed: true }), /fix: git remote set-head origin -a$/);
  assert.equal(originHeadHint(pm, { ref: 'origin/master', guessed: true }), null);
});

test('problem: what — why — fix', () => {
  assert.equal(problem('Merge not checked: T-041', 'gh is not installed', 'install gh, then pm reconcile'), 'Merge not checked: T-041 — gh is not installed — fix: install gh, then pm reconcile');
});

// --- forge cache, lock and background runs ---

function withFixture(responses, fn) {
  const file = path.join(tmp(), 'forge.json');
  fs.writeFileSync(file, JSON.stringify(responses));
  const prev = process.env.PM_FORGE_FIXTURE;
  process.env.PM_FORGE_FIXTURE = file;
  try {
    return fn();
  } finally {
    process.env.PM_FORGE_FIXTURE = prev;
  }
}

// A board with `n` in-progress tasks on branches feat/1..feat/n and a GitHub origin.
function board(n) {
  const { root } = setup();
  sh(['remote', 'add', 'origin', 'git@github.com:o/r.git'], root);
  const pm = tmp();
  for (let i = 1; i <= n; i += 1) {
    const t = newTask(pm, { title: `t${i}`, date: '2026-09-12' });
    setFields(pm, t.id, { status: 'in_progress', branch: `feat/${i}` }, '2026-09-12');
  }
  return { root, pm };
}
const branchPath = (i) => `repos/o/r/pulls?head=o%3Afeat%2F${i}&state=all`;

test('acquireLock: one holder; a lock older than 10 minutes is taken over', () => {
  const pm = tmp();
  const release = acquireLock(pm, 1_000);
  assert.ok(release);
  assert.equal(acquireLock(pm, 2_000), null, 'a second run waits');
  assert.equal(runMergeCheck({ pm, cwd: pm, fetch: false, now: 2_000 }).busy, true, 'a foreground reconcile waits too');
  const takeover = acquireLock(pm, 1_000 + LOCK_STALE_MS + 1);
  assert.ok(takeover, 'a crashed run does not block forever');
  takeover();
  assert.ok(acquireLock(pm, 5_000));
});

test('runMergeCheck: background runs rotate by checkedAt, foreground checks all', () => {
  const { root, pm } = board(6);
  const responses = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [branchPath(i), [{ html_url: `https://github.com/o/r/pull/${i}`, state: 'open', merged_at: null, base: { ref: 'main' }, head: { ref: `feat/${i}` }, user: { login: 'a' } }]]));
  withFixture(responses, () => {
    assert.deepEqual(runMergeCheck({ pm, cwd: root, limit: BACKGROUND_LOOKUPS, fetch: false, background: true, now: 1_000 }), { checked: 5, total: 6 });
    const first = readState(pm, CACHE).tasks;
    const skipped = listTasks(pm).find((t) => !first[t.id]);
    assert.ok(skipped, 'one task waits for the next run');
    runMergeCheck({ pm, cwd: root, limit: BACKGROUND_LOOKUPS, fetch: false, background: true, now: 2_000 });
    assert.equal(readState(pm, CACHE).tasks[skipped.id].checkedAt, 2_000, 'the unchecked task goes first');
    assert.deepEqual(runMergeCheck({ pm, cwd: root, fetch: false, now: 3_000 }), { checked: 6, total: 6 });
    const entry = readState(pm, CACHE).tasks['T-001'];
    assert.equal(entry.key, 'branch:feat/1');
    assert.equal(entry.url, 'https://github.com/o/r/pull/1');
    assert.equal(entry.head, 'feat/1');
    assert.equal(entry.foundByBranch, true);
  });
});

test('runMergeCheck: a permanent forge failure pauses background runs for 24 h; pm reconcile retries', () => {
  const { root, pm } = board(2);
  withFixture({ [branchPath(1)]: { $error: 'gh is not logged in', permanent: true }, [branchPath(2)]: { $error: 'gh is not logged in', permanent: true } }, () => {
    assert.deepEqual(runMergeCheck({ pm, cwd: root, limit: 5, fetch: false, background: true, now: 1_000 }), { checked: 1, total: 2 });
    const cache = readState(pm, CACHE);
    assert.deepEqual(cache.backoff, { until: 1_000 + BACKOFF_MS, cause: 'gh is not logged in' });
    assert.equal(Object.values(cache.tasks)[0].lastError, 'gh is not logged in');
    const spawned = [];
    const spawnFn = (...a) => (spawned.push(a), { unref() {} });
    const prev = process.env.PM_NO_BACKGROUND;
    delete process.env.PM_NO_BACKGROUND;
    try {
      assert.equal(refreshInBackground(pm, root, { now: 1_000 + REFRESH_AFTER_MS + 1, spawnFn }), false, 'no spawn while waiting out the failure');
      assert.equal(runMergeCheck({ pm, cwd: root, limit: 5, fetch: false, background: true, now: 5_000 }).checked, 0);
      assert.equal(runMergeCheck({ pm, cwd: root, fetch: false, now: 6_000 }).checked, 1, 'foreground retries at once');
    } finally {
      process.env.PM_NO_BACKGROUND = prev;
    }
    assert.equal(spawned.length, 0);
  });
});

test('refreshInBackground: spawns only for a stale cache and a free lock, never waits', () => {
  const pm = tmp();
  const spawned = [];
  const spawnFn = (...a) => (spawned.push(a), { unref() {} });
  const prev = process.env.PM_NO_BACKGROUND;
  delete process.env.PM_NO_BACKGROUND;
  try {
    writeState(pm, CACHE, { checkedAt: 1_000 });
    assert.equal(refreshInBackground(pm, pm, { now: 1_000 + REFRESH_AFTER_MS - 1, spawnFn }), false);
    const release = acquireLock(pm, 1_000 + REFRESH_AFTER_MS);
    assert.equal(refreshInBackground(pm, pm, { now: 1_000 + REFRESH_AFTER_MS + 1, spawnFn }), false, 'a run is already going');
    release();
    assert.equal(refreshInBackground(pm, pm, { now: 1_000 + REFRESH_AFTER_MS + 1, spawnFn }), true);
  } finally {
    process.env.PM_NO_BACKGROUND = prev;
  }
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][1][1], '_merge-check');
  assert.equal(spawned[0][2].detached, true);
  assert.equal(spawned[0][2].windowsHide, true);
});

test('cachedLookup: an entry for an older PR url is ignored after pm set pr=', () => {
  const cache = { tasks: { 'T-001': { key: 'https://github.com/o/r/pull/1', state: 'merged' } } };
  assert.equal(cachedLookup(cache, mk('T-001', { pr: 'https://github.com/o/r/pull/1' })).state, 'merged');
  assert.equal(cachedLookup(cache, mk('T-001', { pr: 'https://github.com/o/r/pull/2' })), null);
  assert.equal(cachedLookup(cache, mk('T-001', { branch: 'feat/x' })), null);
});

test('fetch: no terminal prompt and a timeout; a failure is kept as fetchError with a fix', () => {
  const { args, opts } = fetchCommand({ remote: 'origin', branch: 'master' });
  assert.deepEqual(args, ['fetch', '--quiet', 'origin', 'master']);
  assert.equal(opts.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(opts.timeout, GIT_TIMEOUT_MS);
  const { root } = setup();
  sh(['remote', 'add', 'origin', path.join(tmp(), 'missing.git')], root);
  sh(['update-ref', 'refs/remotes/origin/master', 'HEAD'], root);
  const pm = tmp();
  runMergeCheck({ pm, cwd: root, now: 1_000 });
  assert.match(readState(pm, CACHE).fetchError, /^git fetch origin master failed — .+ — fix: git fetch origin master, then pm reconcile$/);
});

test('writeState: an interrupted write (temp left, no rename) keeps the previous state readable', () => {
  const pm = tmp();
  writeState(pm, CACHE, { checkedAt: 1 });
  fs.writeFileSync(path.join(pm, '.state', `${CACHE}.json.999.tmp`), '{"checked');
  assert.deepEqual(readState(pm, CACHE), { checkedAt: 1 });
  assert.deepEqual(fs.readdirSync(path.join(pm, '.state')).filter((f) => f.endsWith('.tmp') && !f.includes('.999.')), [], 'a completed write leaves no temp file');
});

// --- closing rules ---

const REVIEW_AT = '2026-09-20T10:00:00.000Z';
const T = (iso) => Date.parse(iso) / 1000;
const master = { remote: 'origin', branch: 'master', ref: 'origin/master', guessed: false };
const local = (hits = {}, cause) => ({ branch: master, hits: new Map(Object.entries(hits)), cause });
const merged = (key, at, extra = {}) => ({ key, checkedAt: 1, state: 'merged', url: key.startsWith('branch:') ? 'https://github.com/o/r/pull/15' : key, base: 'master', head: 'feat/x', mergeSha: 'f00dbeef1234', mergedAt: T(at), lastError: null, ...extra });
const review = (id, data = {}) => mk(id, { status: 'review', review_at: REVIEW_AT, branch: 'feat/x', ...data });
const ids = (list) => list.map((x) => x.id);

test('classify: review + own PR merged after pm done closes; autoClose=false asks instead', () => {
  const tasks = [review('T-001', { pr: 'https://github.com/o/r/pull/15' })];
  const cache = { tasks: { 'T-001': merged('https://github.com/o/r/pull/15', '2026-09-21T09:00:00Z') } };
  const out = classify({ tasks, local: local(), cache });
  assert.deepEqual(out.close.map(({ snapshot, ...x }) => x), [{ id: 'T-001', how: 'forge', sha: 'f00dbeef1234', pr: '#15', at: T('2026-09-21T09:00:00Z') }]);
  assert.deepEqual(out.close[0].snapshot, { status: 'review', pr: 'https://github.com/o/r/pull/15', review_at: REVIEW_AT });
  const off = classify({ tasks, local: local(), cache, autoClose: false });
  assert.deepEqual([ids(off.close), ids(off.ask)], [[], ['T-001']]);
});

test('classify: a subject hit at or after review_at closes; one before it (the first of two PRs) keeps review', () => {
  const after = classify({ tasks: [review('T-001')], local: local({ 'T-001': { how: 'subject', sha: 'a1', at: T(REVIEW_AT), pr: '#16' } }), cache: {} });
  assert.deepEqual(ids(after.close), ['T-001']);
  const before = classify({ tasks: [review('T-001')], local: local({ 'T-001': { how: 'subject', sha: 'a0', at: T('2026-09-19T10:00:00Z'), pr: '#14' } }), cache: {} });
  assert.deepEqual([ids(before.close), ids(before.ask), ids(before.awaiting)], [[], [], ['T-001']]);
});

test('classify: a forge merge before review_at, through the cache, keeps review', () => {
  const cache = { tasks: { 'T-001': merged('branch:feat/x', '2026-09-19T10:00:00Z') } };
  const out = classify({ tasks: [review('T-001')], local: local(), cache });
  assert.deepEqual([ids(out.close), ids(out.ask), ids(out.awaiting)], [[], [], ['T-001']]);
});

test('classify: open tasks that are not review are asked about, never closed', () => {
  const tasks = ['todo', 'in_progress', 'waiting'].map((status, i) => mk(`T-00${i + 1}`, { status }));
  const hits = Object.fromEntries(tasks.map((t) => [t.id, { how: 'subject', sha: 'a1', at: T('2026-09-21T10:00:00Z'), pr: null }]));
  const out = classify({ tasks, local: local(hits), cache: {} });
  assert.deepEqual([ids(out.close), ids(out.ask)], [[], ['T-001', 'T-002', 'T-003']]);
});

test('classify: a pr from another branch is a conflict, never closed; a merge into another base does not count', () => {
  const wrong = review('T-001', { pr: 'https://github.com/o/r/pull/7' });
  const cacheWrong = { tasks: { 'T-001': merged('https://github.com/o/r/pull/7', '2026-09-21T09:00:00Z', { head: 'feat/other' }) } };
  const c = classify({ tasks: [wrong], local: local(), cache: cacheWrong });
  assert.deepEqual(c.conflicts, [{ id: 'T-001', pr: 'https://github.com/o/r/pull/7', prBranch: 'feat/other', branch: 'feat/x' }]);
  assert.deepEqual([ids(c.close), ids(c.ask)], [[], []]);
  const cacheBase = { tasks: { 'T-001': merged('branch:feat/x', '2026-09-21T09:00:00Z', { base: 'release' }) } };
  const b = classify({ tasks: [review('T-001')], local: local(), cache: cacheBase });
  assert.deepEqual([ids(b.close), ids(b.ask)], [[], []]);
});

test('classify: awaiting merge (checked) vs merge not checked (with the reason)', () => {
  const now = Date.parse('2026-09-30T10:00:00Z');
  const tasks = [review('T-001'), review('T-002', { branch: 'feat/y' }), review('T-003', { branch: 'feat/z' })];
  const cache = { tasks: {
    'T-001': { key: 'branch:feat/x', checkedAt: 1, state: 'open', url: 'https://github.com/o/r/pull/15', lastError: null },
    'T-002': { key: 'branch:feat/y', checkedAt: 1, state: null, lastError: 'gh is not installed' },
  } };
  const out = classify({ tasks, local: local({}, 'origin has no default branch here'), cache, now });
  assert.deepEqual(out.awaiting, [{ id: 'T-001', pr: '#15', days: 10 }]);
  assert.deepEqual(out.notChecked, [{ id: 'T-002', reason: 'gh is not installed', days: 10 }, { id: 'T-003', reason: 'origin has no default branch here', days: 10 }]);
});

test('closeMerged: writes done with the merge and a Log line; skips a task changed since the check', () => {
  const pm = tmp();
  newTask(pm, { title: 'a', date: '2026-09-12' });
  newTask(pm, { title: 'b', date: '2026-09-12' });
  for (const id of ['T-001', 'T-002']) setFields(pm, id, { status: 'review', review_at: REVIEW_AT, pr: 'https://github.com/o/r/pull/15' }, '2026-09-20');
  const [a, b] = listTasks(pm);
  const [ca, cb] = classify({ tasks: [a, b], local: local(), cache: { tasks: {
    'T-001': merged('https://github.com/o/r/pull/15', '2026-09-21T09:00:00Z', { head: null }),
    'T-002': merged('https://github.com/o/r/pull/15', '2026-09-21T09:00:00Z', { head: null }),
  } } }).close;
  setFields(pm, 'T-002', { status: 'in_progress' }, '2026-09-21'); // someone reopened it in between
  assert.equal(closeMerged(pm, ca, { date: '2026-09-22', note: 'closed automatically' }), true);
  assert.equal(closeMerged(pm, cb, { date: '2026-09-22', note: 'closed automatically' }), false);
  const done = listTasks(pm)[0];
  assert.equal(done.data.status, 'done');
  assert.equal(done.data.merged_sha, 'f00dbeef1234');
  assert.equal(done.data.merged_how, 'forge');
  assert.equal(done.data.merged_at, '2026-09-21T09:00:00.000Z');
  assert.match(done.body, /- 2026-09-22 · pm · merged f00dbee \(#15\), closed automatically\n$/);
  assert.equal(listTasks(pm)[1].data.status, 'in_progress');
});
