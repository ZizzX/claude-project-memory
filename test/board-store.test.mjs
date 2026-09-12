import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, setup, sh } from './helpers.mjs';
import { newTask, setFields, claim, appendLog, listTasks } from '../scripts/lib/tasks.mjs';
import { planFile, planTemplate } from '../scripts/lib/plan.mjs';
import { columns, writeBoard } from '../scripts/lib/board.mjs';
import { initBoard, hasBoard, commitPm, isSyncOn } from '../scripts/lib/store.mjs';

const D = '2026-09-12';

test('board puts every non-dropped task in its column', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'done one', date: D });
  setFields(pm, 'T-001', { status: 'done' }, D);
  newTask(pm, { title: 'ready one', deps: ['T-001'], date: D });
  newTask(pm, { title: 'blocked one', deps: ['T-004'], date: D });
  newTask(pm, { title: 'active <one>', date: D });
  claim(pm, 'T-004', 'wt-a', D);
  appendLog(pm, 'T-004', { worktree: 'wt-a', did: 'a', next: 'b', date: D });
  newTask(pm, { title: 'waiting one', date: D });
  setFields(pm, 'T-005', { status: 'waiting', waiting_on: 'user' }, D);
  newTask(pm, { title: 'dropped one', date: D });
  setFields(pm, 'T-006', { status: 'dropped' }, D);

  const ids = Object.fromEntries(Object.entries(columns(listTasks(pm))).map(([k, v]) => [k, v.map((t) => t.id)]));
  assert.deepEqual(ids, { todo: ['T-003'], ready: ['T-002'], in_progress: ['T-004'], waiting: ['T-005'], done: ['T-001'] });

  writeBoard(pm);
  const md = fs.readFileSync(path.join(pm, 'BOARD.md'), 'utf8');
  assert.match(md, /## Ready \(1\)\n- \*\*T-002\*\* ready one · after T-001/);
  assert.match(md, /- \*\*T-004\*\* active <one> · @ wt-a · next: b/);
  assert.match(md, /waiting: user/);
  assert.doesNotMatch(md, /T-006/);
  const html = fs.readFileSync(path.join(pm, 'board.html'), 'utf8');
  assert.match(html, /active &lt;one&gt;/);
  assert.match(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /dropped one/);
});

test('initBoard creates a committed local board with no remote', () => {
  const { root } = setup();
  const { pm, created } = initBoard(root, D);
  assert.equal(created, true);
  for (const f of ['PLAN.md', 'decisions.md', '.gitignore', '.gitattributes', 'tasks/.gitkeep', 'BOARD.md', 'board.html']) {
    assert.ok(fs.existsSync(path.join(pm, f)), f);
  }
  assert.equal(sh(['branch', '--show-current'], pm), 'pm');
  assert.equal(sh(['log', '--format=%s'], pm), 'pm: init');
  assert.equal(sh(['remote'], pm), '');
  assert.equal(sh(['status', '--porcelain'], pm), '', 'generated files are ignored');
  assert.equal(hasBoard(root), true);
  assert.equal(isSyncOn(pm), false);
  assert.equal(initBoard(root, D).created, false);
});

test('commitPm commits only when something changed', () => {
  const { root } = setup();
  const { pm } = initBoard(root, D);
  assert.equal(commitPm(pm, 'noop'), false);
  fs.appendFileSync(path.join(pm, 'decisions.md'), 'x\n');
  assert.equal(commitPm(pm, 'pm: edit'), true);
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: edit');
});
