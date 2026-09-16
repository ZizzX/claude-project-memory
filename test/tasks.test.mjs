import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.mjs';
import { newTask, listTasks, readTask, setFields, claim, appendLog, appendLogLine, lastNext, taskPrefix, setTaskPrefix } from '../scripts/lib/tasks.mjs';

const D = '2026-09-12';

test('newTask creates sequential ids from the template', () => {
  const pm = tmp();
  assert.equal(newTask(pm, { title: 'First', date: D }).id, 'T-001');
  assert.equal(newTask(pm, { title: 'Second: with colon', deps: ['T-001'], date: D }).id, 'T-002');
  assert.ok(fs.existsSync(path.join(pm, 'tasks', 'T-002.md')));
  const t = readTask(pm, 'T-002');
  assert.equal(t.data.title, 'Second: with colon');
  assert.equal(t.data.status, 'todo');
  assert.equal(t.data.order, 2);
  assert.deepEqual(t.data.depends_on, ['T-001']);
  assert.equal(t.data.updated, D);
  assert.match(t.body, /^## Goal\n\n## Understanding\n\n## Checklist\n\n## Log\n$/);
  assert.deepEqual(listTasks(pm).map((x) => x.id), ['T-001', 'T-002']);
});

test('newTask skips ids that already exist', () => {
  const pm = tmp();
  fs.mkdirSync(path.join(pm, 'tasks'));
  fs.writeFileSync(path.join(pm, 'tasks', 'T-005.md'), '---\nid: T-005\ntitle: x\nstatus: todo\norder: 5\n---\n');
  assert.equal(newTask(pm, { title: 'next', date: D }).id, 'T-006');
});

test('a board prefix names new tasks and keeps counting after the old ids', () => {
  const pm = tmp();
  newTask(pm, { title: 'old', date: D });
  newTask(pm, { title: 'old too', date: D });
  assert.equal(taskPrefix(pm), 'T');
  setTaskPrefix(pm, 'PM');
  assert.equal(taskPrefix(pm), 'PM');
  const t = newTask(pm, { title: 'new', deps: ['T-002'], date: D });
  assert.equal(t.id, 'PM-003');
  assert.equal(newTask(pm, { title: 'next', date: D }).id, 'PM-004');
  assert.deepEqual(listTasks(pm).map((x) => x.id), ['T-001', 'T-002', 'PM-003', 'PM-004']);
  assert.deepEqual(readTask(pm, 'PM-003').data.depends_on, ['T-002']);
});

test('the prefix must be an uppercase key', () => {
  const pm = tmp();
  for (const bad of ['pm', 'P-M', '1PM', '', 'ABCDEFGHIJK']) assert.throws(() => setTaskPrefix(pm, bad), /prefix/);
  setTaskPrefix(pm, 'ATS2');
  assert.equal(taskPrefix(pm), 'ATS2');
});

test('setFields validates and normalizes', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  assert.throws(() => setFields(pm, 'T-001', { status: 'doing' }, D), /bad status/);
  assert.throws(() => setFields(pm, 'T-001', { status: 'waiting' }, D), /waiting_on/);
  assert.throws(() => setFields(pm, 'T-001', { order: 'abc' }, D), /order/);
  assert.throws(() => setFields(pm, 'T-001', { id: 'T-002' }, D), /id cannot/);
  assert.throws(() => readTask(pm, 'T-404'), /unknown task T-404/);
  const t = setFields(pm, 'T-001', { status: 'waiting', waiting_on: 'answer about dates', depends_on: 'T-009, T-010', order: '7' }, '2026-09-13');
  assert.deepEqual(t.data.depends_on, ['T-009', 'T-010']);
  assert.equal(t.data.order, 7);
  assert.equal(t.data.updated, '2026-09-13');
  assert.equal(setFields(pm, 'T-001', { status: 'todo' }, D).data.waiting_on, '');
});

test('claim adds the worktree once and starts the task', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  claim(pm, 'T-001', 'wt-a', D);
  const t = claim(pm, 'T-001', 'wt-a', D);
  claim(pm, 'T-001', 'wt-b', D);
  assert.equal(t.data.status, 'in_progress');
  assert.deepEqual(readTask(pm, 'T-001').data.worktrees, ['wt-a', 'wt-b']);
});

test('appendLog adds signed entries and lastNext reads the latest model entry', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  assert.equal(lastNext(readTask(pm, 'T-001')), null);
  appendLog(pm, 'T-001', { worktree: 'wt-a', did: 'parser', next: 'empty rows', date: D });
  appendLogLine(pm, 'T-001', '- 2026-09-13 · wt-a · auto: changed files: a.js · last commit: abc x', '2026-09-13');
  appendLog(pm, 'T-001', { worktree: 'wt-b', did: 'tests', next: 'handle BOM · then docs', date: '2026-09-14' });
  const t = readTask(pm, 'T-001');
  assert.match(t.body, /## Log\n- 2026-09-12 · wt-a · did: parser · next: empty rows\n- 2026-09-13 · wt-a · auto:/);
  assert.deepEqual(lastNext(t), { date: '2026-09-14', who: 'wt-b', next: 'handle BOM · then docs' });
});

test('newTask retries on EEXIST (concurrent id collision)', () => {
  const pm = tmp();

  // Create T-001 first
  const first = newTask(pm, { title: 'first', date: D });
  assert.equal(first.id, 'T-001');

  // Save the real fs.openSync
  const realOpenSync = fs.openSync;

  // Track calls to openSync with 'wx' flag for T-002
  let collisionThrown = false;
  fs.openSync = function(file, flags, ...args) {
    if (flags === 'wx' && file.endsWith('T-002.md') && !collisionThrown) {
      collisionThrown = true;
      const err = new Error('File exists');
      err.code = 'EEXIST';
      throw err;
    }
    return realOpenSync.apply(this, [file, flags, ...args]);
  };

  try {
    // This should encounter EEXIST for T-002, then retry and succeed with T-003
    const second = newTask(pm, { title: 'second', date: D });
    assert.equal(second.id, 'T-003');
    assert.ok(fs.existsSync(path.join(pm, 'tasks', 'T-003.md')));
    const t = readTask(pm, 'T-003');
    assert.equal(t.data.id, 'T-003');
  } finally {
    fs.openSync = realOpenSync;
  }
});

test('claim writes the branch only when there is one; commits is an optional list', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  newTask(pm, { title: 'y', date: D });
  claim(pm, 'T-001', 'wt-a', D, 'feat/x');
  claim(pm, 'T-002', 'wt-a', D); // detached HEAD: no branch
  assert.equal(readTask(pm, 'T-001').data.branch, 'feat/x');
  const plain = fs.readFileSync(path.join(pm, 'tasks', 'T-002.md'), 'utf8');
  assert.doesNotMatch(plain, /^(branch|commits|pr):/m, 'unset fields never appear in the file');
  assert.equal(readTask(pm, 'T-002').data.commits, undefined);
  setFields(pm, 'T-002', { commits: 'aaaaaaaaaaaa, bbbbbbbbbbbb' }, D);
  assert.deepEqual(readTask(pm, 'T-002').data.commits, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-002.md'), 'utf8'), /\ncommits: \[aaaaaaaaaaaa, bbbbbbbbbbbb\]\n/);
});
