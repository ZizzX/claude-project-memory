import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setup, cli, addWorktree, PM } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

const read = (root, id) => fs.readFileSync(path.join(pmDir(root), 'tasks', `${id}.md`), 'utf8');
const today = new Date().toLocaleDateString('sv-SE');

test('pm next marks one todo task per epic and claim clears it', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a', '--epic', 'A'], root);
  cli(['task', 'new', '--title', 'b', '--epic', 'A'], root);
  cli(['task', 'new', '--title', 'c', '--epic', ''], root);

  const r1 = cli(['next', 'T-001'], root);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /T-001 ← next/);
  assert.match(read(root, 'T-001'), new RegExp(`^next: ${today}$`, 'm'));

  cli(['next', 'T-002'], root);
  assert.match(read(root, 'T-002'), /^next: /m);
  assert.doesNotMatch(read(root, 'T-001'), /^next: /m, 'one next per epic');

  cli(['next', 'T-003'], root);
  assert.match(read(root, 'T-002'), /^next: /m, 'a repo-wide task is its own group');
  assert.match(read(root, 'T-003'), /^next: /m);

  cli(['claim', 'T-002'], root);
  assert.doesNotMatch(read(root, 'T-002'), /^next: /m, 'claim clears next');

  const r2 = cli(['next', 'T-002'], root);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /only a todo task/);

  cli(['next', '--clear'], root);
  assert.doesNotMatch(read(root, 'T-003'), /^next: /m);
});

test('waiting_since follows the waiting status', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['set', 'T-001', 'status=waiting', 'waiting_on=x'], root);
  assert.match(read(root, 'T-001'), new RegExp(`^waiting_since: ${today}$`, 'm'));
  cli(['set', 'T-001', 'status=todo'], root);
  assert.doesNotMatch(read(root, 'T-001'), /^waiting_since: /m);
});

test('pm prefix --start continues numbering', () => {
  const { root } = setup();
  cli(['init'], root);
  const r = cli(['prefix', 'PM', '--start', '61'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PM-061/);
  assert.match(cli(['task', 'new', '--title', 'a'], root).out, /^PM-061 created/);
  assert.match(cli(['task', 'new', '--title', 'b'], root).out, /^PM-062 created/);
});

test('old files gain no fields', () => {
  const { root } = setup();
  cli(['init'], root);
  const file = path.join(pmDir(root), 'tasks', 'T-001.md');
  fs.writeFileSync(file, '---\nid: T-001\ntitle: old\nstatus: todo\norder: 1\ndepends_on: []\nwaiting_on: ""\nworktrees: []\nmilestone: ""\nlinks: []\nupdated: 2026-09-01\nepic: ""\n---\n## Goal\n\n## Log\n');
  cli(['set', 'T-001', 'order=2'], root);
  const text = read(root, 'T-001');
  assert.doesNotMatch(text, /^(next|waiting_since): /m);
});

test('an old waiting file gains no waiting_since on an unrelated edit', () => {
  const { root } = setup();
  cli(['init'], root);
  const file = path.join(pmDir(root), 'tasks', 'T-001.md');
  fs.writeFileSync(file, '---\nid: T-001\ntitle: old\nstatus: waiting\norder: 1\ndepends_on: []\nwaiting_on: api\nworktrees: []\nmilestone: ""\nlinks: []\nupdated: 2026-09-01\nepic: ""\n---\n## Goal\n\n## Log\n');
  cli(['set', 'T-001', 'order=2'], root);
  assert.doesNotMatch(read(root, 'T-001'), /^waiting_since: /m);
});

test('pm prefix --start without a key applies to the current prefix', () => {
  const { root } = setup();
  cli(['init'], root);
  const r = cli(['prefix', '--start', '61'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /T-061/);
  assert.match(cli(['task', 'new', '--title', 'a'], root).out, /^T-061 created/);
});

const status = (root, id) => read(root, id).match(/^status: (.+)$/m)[1];

test('pm next without an id claims the head of the ready queue', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'blocked', '--order', '1', '--deps', 'T-003'], root);
  cli(['task', 'new', '--title', 'later', '--order', '3'], root);
  cli(['task', 'new', '--title', 'first', '--order', '2'], root);

  const r = cli(['next'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T-003 claimed by .+: first$/);
  assert.equal(status(root, 'T-003'), 'in_progress');
  assert.equal(status(root, 'T-002'), 'todo');
});

test('pm next takes the task marked next before the order', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a', '--order', '1'], root);
  cli(['task', 'new', '--title', 'b', '--order', '2'], root);
  cli(['next', 'T-002'], root);

  const r = cli(['next'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T-002 claimed/);
  assert.doesNotMatch(read(root, 'T-002'), /^next: /m, 'claim clears next');
});

test('pm next refuses while this worktree has a task in progress', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['task', 'new', '--title', 'b'], root);
  cli(['claim', 'T-001'], root);

  const r = cli(['next'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /T-001 is in progress here/);
  assert.equal(status(root, 'T-002'), 'todo');
});

test('pm next with nothing ready fails', () => {
  const { root } = setup();
  cli(['init'], root);
  const r = cli(['next'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing ready/);
});

test('pm next stays in the epic of this worktree', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a1', '--epic', 'A', '--order', '1'], root);
  cli(['task', 'new', '--title', 'b1', '--epic', 'B', '--order', '1'], root);
  cli(['task', 'new', '--title', 'a2', '--epic', 'A', '--order', '2'], root);
  cli(['task', 'new', '--title', 'b2', '--epic', 'B', '--order', '2'], root);
  cli(['claim', 'T-002'], root);
  cli(['set', 'T-002', 'status=done'], root);

  const r = cli(['next'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T-004 claimed/, 'B is the epic of this worktree, A1 has a lower id but another direction');
});

test('pm next in a worktree without an epic takes only repo-wide tasks, or the epic given', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a1', '--epic', 'A'], root);

  const r1 = cli(['next'], root);
  assert.equal(r1.code, 1);
  assert.match(r1.err, /no epic for this worktree/);
  assert.equal(status(root, 'T-001'), 'todo');
  assert.match(cli(['next', '--epic', 'Z'], root).err, /unknown epic "Z"/);

  const r2 = cli(['next', '--epic', 'A'], root);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /^T-001 claimed/);
});

const writeBody = (root, id, body) => {
  const file = path.join(pmDir(root), 'tasks', `${id}.md`);
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(/\n---\n[\s\S]*$/, `\n---\n${body}`));
};

test('pm next --options lists the tasks of this epic and the other epics, with a description', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'b1', '--epic', 'B', '--order', '1'], root);
  cli(['task', 'new', '--title', 'b2', '--epic', 'B', '--order', '2'], root);
  cli(['task', 'new', '--title', 'b3', '--epic', 'B', '--order', '3'], root);
  cli(['task', 'new', '--title', 'a1', '--epic', 'A', '--order', '1'], root);
  cli(['task', 'new', '--title', 'c1', '--epic', 'C', '--order', '1', '--deps', 'T-002'], root);
  cli(['claim', 'T-001'], root);
  cli(['set', 'T-001', 'status=done'], root);
  writeBody(root, 'T-002', '## Goal\nValidate the form before submit\n\n## Understanding\n\n## Log\n');
  writeBody(root, 'T-003', '## Goal\n\n## Understanding\n\n## Log\n- 2026-10-01 · w · did: x · next: wire the export button\n');
  cli(['next', 'T-003'], root);

  const r = cli(['next', '--options'], root);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.match(lines[0], /^# epic B/);
  assert.equal(lines[1], 'task T-003 · b3 ← next · wire the export button');
  assert.equal(lines[2], 'task T-002 · b2 · Validate the form before submit');
  assert.match(r.out, /^epic A · 1 ready · first: T-004 a1$/m);
  assert.doesNotMatch(r.out, /epic C/, 'an epic with nothing ready is not an option');
  assert.equal(status(root, 'T-002'), 'todo', '--options claims nothing');
});

test('pm next --options shows the task in progress here first', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['task', 'new', '--title', 'b'], root);
  cli(['claim', 'T-001'], root);

  const r = cli(['next', '--options'], root);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n')[1], 'current T-001 · a');
  assert.match(r.out, /^task T-002 · b$/m);
});

test('pm next --options in a worktree without an epic offers repo-wide tasks and every epic', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a1', '--epic', 'A'], root);
  cli(['task', 'new', '--title', 'shared', '--epic', ''], root);

  const r = cli(['next', '--options'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^# no epic for this worktree/);
  assert.match(r.out, /^task T-002 · shared$/m);
  assert.match(r.out, /^epic A · 1 ready · first: T-001 a1$/m);
});

test('pm next --options with nothing anywhere says so', () => {
  const { root } = setup();
  cli(['init'], root);
  const r = cli(['next', '--options'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\(nothing ready\)/);
});

test('pm next --epic takes a task of that epic before a repo-wide one, as --options advertises', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'shared', '--epic', '', '--order', '1'], root);
  cli(['task', 'new', '--title', 'a1', '--epic', 'A', '--order', '2'], root);

  assert.match(cli(['next', '--options'], root).out, /^epic A · 1 ready · first: T-002 a1$/m);
  const r = cli(['next', '--epic', 'A'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T-002 claimed/);
});

test("pm next and pm ready put the epic's next marker before the repo-wide one, as the summary does", () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'b0', '--epic', 'B', '--order', '1'], root);
  cli(['task', 'new', '--title', 'shared', '--epic', '', '--order', '2'], root);
  cli(['task', 'new', '--title', 'b1', '--epic', 'B', '--order', '3'], root);
  cli(['claim', 'T-001'], root);
  cli(['set', 'T-001', 'status=done'], root);
  cli(['next', 'T-002'], root);
  cli(['next', 'T-003'], root);

  assert.match(cli(['ready'], root).out.split('\n')[1], /^T-003 /);
  const r = cli(['next'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T-003 claimed/);
});

const run = (args, cwd, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [PM, ...args], { cwd, env: { ...process.env, ...env } });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => (out += d));
  c.stderr.on('data', (d) => (err += d));
  c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
});

test('two pm next at once in one worktree claim one task; in two worktrees, two different tasks', async () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a', '--order', '1'], root);
  cli(['task', 'new', '--title', 'b', '--order', '2'], root);
  cli(['task', 'new', '--title', 'c', '--order', '3'], root);

  const same = await Promise.all([run(['next'], root), run(['next'], root)]);
  assert.deepEqual(same.map((r) => r.code).sort(), [0, 1], JSON.stringify(same));
  assert.match(same.find((r) => r.code === 1).err, /is in progress here/);

  const other = addWorktree(root, 'wt-b');
  const third = addWorktree(root, 'wt-c');
  const two = await Promise.all([run(['next'], other), run(['next'], third)]);
  assert.deepEqual(two.map((r) => r.code), [0, 0], JSON.stringify(two));
  assert.notEqual(two[0].out.split(' ')[0], two[1].out.split(' ')[0]);
});

test('the claim lock waits for a live holder and takes over a dead one', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  const lock = path.join(pmDir(root), '.state', 'claim.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} 0 live`);

  const r1 = cli(['next'], root, { env: { PM_LOCK_WAIT_MS: '300' } });
  assert.equal(r1.code, 1);
  assert.match(r1.err, /the board is busy/);
  assert.equal(status(root, 'T-001'), 'todo');

  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(path.join(lock, 'owner'), `${dead} 0 dead`);
  const r2 = cli(['next'], root);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.out, /^T-001 claimed/);
  assert.equal(fs.existsSync(lock), false, 'released after the claim');
});
