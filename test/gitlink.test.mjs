import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, addWorktree, tmp, sh, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';
import { readTask } from '../scripts/lib/tasks.mjs';
import { onStop, onSafetyNote } from '../scripts/lib/hooks.mjs';
import { reflogSince } from '../scripts/lib/gitlink.mjs';

const MIN = 60_000;

function commit(cwd, name, message = name) {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`);
  sh(['add', '-A'], cwd);
  sh(['commit', '-q', '-m', message], cwd);
  return head(cwd);
}
const head = (cwd) => sh(['rev-parse', 'HEAD'], cwd).slice(0, 12);
const commitsOf = (root, id) => readTask(pmDir(root), id).data.commits ?? [];

function boardWithTask(root, ...titles) {
  cli(['init'], root);
  for (const title of titles.length ? titles : ['x']) cli(['task', 'new', '--title', title], root);
}

test('reflogSince reads complete lines only and restarts on a shrunken file', () => {
  const file = path.join(tmp(), 'HEAD');
  const line = (old, sha, subject) => `${old} ${sha} t <t@e> 1789410128 +0500\t${subject}\n`;
  const [z, a, b] = ['0', 'a', 'b'].map((c) => c.repeat(40));
  const whole = line(z, a, 'commit (initial): init') + line(a, b, 'commit (amend): two');
  fs.writeFileSync(file, `${whole}${b} ${'c'.repeat(40)} t <t@e> 17894`); // git is still writing the last line
  const first = reflogSince(file, 0);
  assert.deepEqual(first.entries, [
    { old: z, sha: a, subject: 'commit (initial): init' },
    { old: a, sha: b, subject: 'commit (amend): two' },
  ]);
  assert.equal(first.offset, Buffer.byteLength(whole));
  assert.deepEqual(reflogSince(file, first.offset).entries, []);
  assert.deepEqual(reflogSince(file, 5).entries.map((e) => e.subject), ['commit (amend): two'], 'a cut line is dropped, not misread');
  assert.deepEqual(reflogSince(file, 10_000), { entries: [], offset: fs.statSync(file).size });
  assert.deepEqual(reflogSince(path.join(tmp(), 'missing'), 50), { entries: [], offset: 0 });
});

test('claim records the branch; only commits after the claim are linked and committed with the board', () => {
  const { root } = setup();
  boardWithTask(root);
  commit(root, 'before.txt');
  cli(['claim', 'T-001'], root);
  const a = commit(root, 'a.txt');
  onStop({}, root);
  const t = readTask(pmDir(root), 'T-001');
  assert.equal(t.data.branch, 'main');
  assert.deepEqual(t.data.commits, [a]);
  assert.equal(sh(['status', '--porcelain'], pmDir(root)), '');
  assert.equal(sh(['log', '-1', '--format=%s'], pmDir(root)), 'pm: stop');
});

test('amend replaces the SHA, a repeated Stop adds nothing, and the same-size edit is still committed', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  commit(root, 'a.txt');
  onStop({}, root);
  const pm = pmDir(root);
  // Make the board index trust stat data: it records an old mtime and is itself newer than it (not "racily clean").
  // A capture that restored the old mtime would now leave the same-size edit uncommitted on Git for Windows.
  const past = new Date(Date.now() - 120 * MIN);
  fs.utimesSync(path.join(pm, 'tasks', 'T-001.md'), past, past);
  sh(['update-index', '--refresh'], pm);
  sh(['commit', '-q', '--amend', '-m', 'a amended'], root);
  const amended = head(root);
  onStop({}, root);
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [amended]);
  assert.equal(sh(['status', '--porcelain'], pm), '');
  assert.match(sh(['show', 'HEAD:tasks/T-001.md'], pm), new RegExp(`\\ncommits: \\[${amended}\\]\\n`));
});

test('fast-forward and merge commits and resets are skipped; cherry-pick and revert are linked', () => {
  const { root } = setup();
  const other = addWorktree(root, 'other');
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  commit(other, 'o1.txt');
  sh(['merge', '-q', '--ff-only', 'other'], root);
  commit(other, 'o2.txt');
  sh(['merge', '-q', '--no-ff', '-m', 'merge o2', 'other'], root);
  sh(['reset', '-q', '--hard', 'HEAD~1'], root);
  sh(['cherry-pick', 'other'], root);
  const picked = head(root);
  sh(['revert', '--no-edit', 'HEAD'], root);
  const reverted = head(root);
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [picked, reverted]);
});

test('each worktree links only its own commits, made with plain git between pm calls', () => {
  const { root } = setup();
  const b = addWorktree(root, 'b');
  boardWithTask(root, 'a', 'b');
  cli(['claim', 'T-001'], root);
  cli(['claim', 'T-002'], b);
  const inB = commit(b, 'b.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  onSafetyNote({ session_id: 's' }, b, 'session-end');
  assert.deepEqual(commitsOf(root, 'T-002'), [inB]);
  assert.equal(readTask(pmDir(root), 'T-002').data.branch, 'b');
});

test('two tasks in progress in one worktree: commits are logged as not attributed', () => {
  const { root } = setup();
  boardWithTask(root, 'a', 'b');
  cli(['claim', 'T-001'], root);
  cli(['claim', 'T-002'], root);
  const sha = commit(root, 'a.txt');
  onStop({}, root);
  for (const id of ['T-001', 'T-002']) {
    const t = readTask(pmDir(root), id);
    assert.equal(t.data.commits, undefined);
    assert.match(t.body, new RegExp(`auto: commits not attributed \\(2 tasks in progress\\): ${sha} — pm set T-NNN commits=`));
  }
});

test('commits made while the task is not in progress are never linked; a status change flushes the last ones', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  cli(['set', 'T-001', 'status=waiting', 'waiting_on=review'], root);
  commit(root, 'while-waiting.txt');
  cli(['set', 'T-001', 'status=in_progress'], root);
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  const last = commit(root, 'last.txt');
  cli(['set', 'T-001', 'status=done'], root);
  assert.deepEqual(commitsOf(root, 'T-001'), [last]);
});

test('a task claimed before capture existed starts its cursor without backfill', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  fs.rmSync(path.join(pmDir(root), '.state', `capture-${path.basename(root)}.json`));
  commit(root, 'unseen.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  const seen = commit(root, 'seen.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [seen]);
});

test('a missing reflog neither throws nor links; the cursor restarts', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  commit(root, 'a.txt');
  fs.rmSync(sh(['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'], root));
  commit(root, 'b.txt'); // git starts a new, shorter reflog
  assert.doesNotThrow(() => onStop({}, root));
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  const c = commit(root, 'c.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [c]);
});

test('capture does not hide a stale board from the Stop nudge', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  const pm = pmDir(root);
  const past = new Date(Date.now() - 120 * MIN);
  for (const f of ['PLAN.md', 'decisions.md', path.join('tasks', 'T-001.md')]) fs.utimesSync(path.join(pm, f), past, past);
  const sha = commit(root, 'a.txt');
  const out = onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [sha], 'the commit was linked');
  assert.equal(JSON.parse(out).decision, 'block', 'and the nudge still fired');
});

test('tasks without a branch or commits keep their file shape', () => {
  const { root } = setup();
  boardWithTask(root, 'x', 'y');
  cli(['set', 'T-001', 'status=done'], root);
  sh(['checkout', '-q', '--detach'], root);
  cli(['claim', 'T-002'], root);
  onStop({}, root);
  for (const id of ['T-001', 'T-002']) {
    assert.doesNotMatch(fs.readFileSync(path.join(pmDir(root), 'tasks', `${id}.md`), 'utf8'), /^(branch|commits|pr):/m);
  }
});
