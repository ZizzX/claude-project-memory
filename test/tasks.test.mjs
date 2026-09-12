import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.mjs';
import { newTask, listTasks, readTask, setFields, claim, appendLog, appendLogLine, lastNext } from '../scripts/lib/tasks.mjs';

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
