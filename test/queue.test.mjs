import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyQueue, validate } from '../scripts/lib/tasks.mjs';

function mk(id, data = {}) {
  return {
    id,
    file: `${id}.md`,
    body: '',
    data: { id, title: id, status: 'todo', order: Number(id.slice(2)), depends_on: [], worktrees: [], links: [], waiting_on: '', milestone: '', ...data },
  };
}

test('ready = todo whose deps are done or dropped, in order', () => {
  const tasks = [
    mk('T-001', { status: 'done' }),
    mk('T-002', { status: 'dropped' }),
    mk('T-003', { depends_on: ['T-001', 'T-002'], order: 9 }),
    mk('T-004', { depends_on: ['T-005'] }),
    mk('T-005', { status: 'in_progress' }),
    mk('T-006', { status: 'waiting', waiting_on: 'x' }),
    mk('T-007', { order: 1 }),
    mk('T-008', { depends_on: ['T-404'] }),
    mk('T-009', { status: 'review' }),
    mk('T-010', { depends_on: ['T-009'] }),
  ];
  assert.deepEqual(readyQueue(tasks).map((t) => t.id), ['T-007', 'T-003'], 'review is not Ready and does not satisfy depends_on');
});

test('validate reports every kind of problem', () => {
  const bad = mk('T-008');
  bad.data.id = 'T-009';
  const problems = validate([
    mk('T-001', { depends_on: ['T-002'] }),
    mk('T-002', { depends_on: ['T-001'] }),
    mk('T-003', { depends_on: ['T-404'] }),
    mk('T-004', { status: 'waiting' }),
    mk('T-005', { status: 'doing' }),
    mk('T-006', { status: 'dropped' }),
    mk('T-007', { depends_on: ['T-006'] }),
    bad,
  ]);
  assert.deepEqual(problems.sort(), [
    'T-003: depends on unknown T-404',
    'T-004: waiting without waiting_on',
    'T-005: bad status "doing"',
    'T-007: depends on dropped T-006',
    'T-008: frontmatter id is T-009',
    'cycle: T-001 -> T-002 -> T-001',
  ].sort());
});

test('a healthy board has no problems', () => {
  assert.deepEqual(validate([mk('T-001'), mk('T-002', { depends_on: ['T-001'] }), mk('T-003', { status: 'review' })]), []);
});
