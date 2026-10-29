import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmp } from './helpers.mjs';
import { newTask, setFields, claim, appendLog, setNext } from '../scripts/lib/tasks.mjs';
import { planFile, planTemplate } from '../scripts/lib/plan.mjs';
import { appendDecision } from '../scripts/lib/decisions.mjs';
import { buildSummary, MAX_LINES } from '../scripts/lib/summary.mjs';
import { addLearning, learningsDir } from '../scripts/lib/learn.mjs';

const D = '2026-09-12';

test('summary shows my tasks, elsewhere, ready, waiting, decisions, CLI and rules', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D).replace('## Current focus\n', '## Current focus\nM1 core\n'));
  newTask(pm, { title: 'mine', date: D });
  claim(pm, 'T-001', 'wt-a', D);
  appendLog(pm, 'T-001', { worktree: 'wt-a', did: 'x', next: 'write parser', date: D });
  newTask(pm, { title: 'theirs', date: D });
  claim(pm, 'T-002', 'wt-b', D);
  newTask(pm, { title: 'free', date: D });
  newTask(pm, { title: 'blocked', date: D });
  setFields(pm, 'T-004', { status: 'waiting', waiting_on: 'API key' }, D);
  appendDecision(pm, { title: 'Local by default', why: 'privacy', rejected: 'auto sync', date: D });

  const s = buildSummary({ pm, worktree: 'wt-a', scriptPath: '/p/pm.mjs', statusLine: '[pm] status here' });
  assert.match(s, /^\[pm\] demo · focus: M1 core · board: file:\/\//);
  assert.match(s, /\n\[pm\] status here\n/);
  assert.match(s, /T-001 mine \[in_progress\] → next: write parser \(2026-09-12, wt-a\)/);
  assert.match(s, /Elsewhere: T-002 theirs @ wt-b/);
  assert.match(s, /Ready: T-003 free/);
  assert.match(s, /Waiting: T-004 ← API key/);
  assert.match(s, /Decisions: D-001 Local by default/);
  assert.match(s, /CLI: node "\/p\/pm\.mjs" <command>/);
  assert.match(s, /\nRules:/);
});

test('an idle worktree is told what to do', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /no active task/);
});

test('summary never exceeds MAX_LINES and keeps the rules', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  for (let i = 0; i < 60; i += 1) claim(pm, newTask(pm, { title: `t${i}`, date: D }).id, 'wt-a', D);
  const lines = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }).split('\n');
  assert.ok(lines.length <= MAX_LINES, `${lines.length} lines`);
  assert.match(lines.at(-2), /^Rules:/);
  assert.match(lines.join('\n'), /more lines — see BOARD\.md/);
});

test('summary puts the next task first', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a', date: D });
  newTask(pm, { title: 'b', date: D });
  setNext(pm, 'T-002', D);
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /Ready: T-002 b ← next · T-001 a/);
});

test('a blocked next task says what it waits for', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a', date: D });
  newTask(pm, { title: 'b', deps: ['T-001'], date: D });
  setNext(pm, 'T-002', D);
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /Ready: T-002 b ← next \(after T-001\) · T-001 a/);
});

test('an orphan in_progress task prints (no worktree)', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'c', date: D });
  setFields(pm, 'T-001', { status: 'in_progress' }, D);
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /Elsewhere: T-001 c @ \(no worktree\)/);
});

test('summary lists learnings of my epic first, newest last-date first, at most five', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  for (let i = 1; i <= 2; i += 1) newTask(pm, { title: `t${i}`, epic: 'A', date: D });
  claim(pm, 'T-001', 'wt-a', D);
  newTask(pm, { title: 'other', epic: 'B', date: D });
  const wt = 'wt-a';
  addLearning(pm, { title: 'mine old', pattern: 'a.one', tasks: ['T-002'], worktree: wt, date: '2026-09-01' });
  addLearning(pm, { title: 'mine new', pattern: 'a.two', tasks: ['T-001'], worktree: wt, date: '2026-09-20' });
  addLearning(pm, { title: 'theirs', pattern: 'b.one', tasks: ['T-003'], worktree: wt, date: '2026-09-30' });
  for (let i = 0; i < 6; i += 1) addLearning(pm, { title: `extra${i}`, pattern: `c.n${i}`, tasks: ['T-001'], worktree: wt, date: '2026-08-01' });
  const s = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' });
  const line = s.split('\n').find((l) => l.startsWith('Learnings: '));
  assert.ok(line, s);
  assert.match(line, /^Learnings: L-002 mine new · L-001 mine old · L-004 extra0 · L-005 extra1 · L-006 extra2$/);
  assert.doesNotMatch(line, /theirs/);
});

test('summary names promotable learnings', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  for (let i = 1; i <= 2; i += 1) newTask(pm, { title: `t${i}`, date: D });
  addLearning(pm, { title: 'hot', pattern: 'a.hot', tasks: ['T-001'], worktree: 'w', date: '2026-09-01' });
  addLearning(pm, { title: 'hot', pattern: 'a.hot', tasks: ['T-002'], worktree: 'w', date: '2026-09-02' });
  addLearning(pm, { title: 'hot', pattern: 'a.hot', tasks: ['T-001'], worktree: 'w', date: '2026-09-03' });
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /\nPromote: L-001 hot \(seen 3 in 2 tasks\)/);
});

test('a broken learning file does not break the summary', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  fs.mkdirSync(learningsDir(pm));
  fs.writeFileSync(`${learningsDir(pm)}/L-009.md`, 'garbage');
  const s = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' });
  assert.match(s, /\nRules:/);
  assert.doesNotMatch(s, /Learnings:/);
});

test('a fresh worktree on a board with epics sees every next task first', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a1', epic: 'A', date: D });
  newTask(pm, { title: 'a2', epic: 'A', date: D });
  newTask(pm, { title: 'b1', epic: 'B', date: D });
  setNext(pm, 'T-002', D);
  assert.match(buildSummary({ pm, worktree: 'fresh', scriptPath: 'x' }), /Ready: T-002 a2 \(A\) ← next · T-001 a1 \(A\) · T-003 b1 \(B\)/);
});

test('a next mark left on a non-todo task by an older client is ignored', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a', date: D });
  setNext(pm, 'T-001', D);
  const file = `${pm}/tasks/T-001.md`;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('status: todo', 'status: in_progress'));
  assert.doesNotMatch(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /← next/);
});

test('an epic worktree also leads with a repo-wide next task', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a1', epic: 'A', date: D });
  claim(pm, 'T-001', 'wt-a', D);
  for (let i = 2; i <= 4; i += 1) newTask(pm, { title: `a${i}`, epic: 'A', date: D });
  newTask(pm, { title: 'shared', date: D });
  setNext(pm, 'T-005', D);
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /Ready: T-005 shared ← next · T-002 a2 · T-003 a3/);
});

test('summary: the epic line says how much of the epic is left, or that nothing is open', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a1', epic: 'A', date: D });
  claim(pm, 'T-001', 'wt-a', D);
  newTask(pm, { title: 'a2', epic: 'A', date: D });
  newTask(pm, { title: 'a3', epic: 'A', deps: ['T-001'], date: D });
  newTask(pm, { title: 'b1', epic: 'B', date: D });
  claim(pm, 'T-004', 'wt-b', D);
  const s = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' });
  assert.match(s, /\n {2}T-001 a1 \[in_progress\]\nEpic A: 3 left of 3 \(1 ready, 1 blocked, 1 in progress\)\nElsewhere: /);
  for (const id of ['T-001', 'T-002', 'T-003']) setFields(pm, id, { status: 'done' }, D);
  const done = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' });
  assert.match(done, /^\[pm\] demo · epic A · /, 'the header keeps the epic');
  assert.match(done, /\nEpic A: no open tracked tasks \(3 done\) — ask the user which direction is next: pm next --options\n/);
  assert.doesNotMatch(done, /finished/);
  for (const id of ['T-001', 'T-002', 'T-003']) setFields(pm, id, { status: 'dropped' }, D);
  assert.match(buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' }), /\nEpic A: no open tracked tasks \(3 dropped\) — /);
  assert.doesNotMatch(buildSummary({ pm, worktree: 'wt-c', scriptPath: 'x' }), /^Epic /m, 'a worktree without an epic');
});

test('summary over the cap keeps the header and the epic line', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  for (let i = 0; i < 45; i += 1) claim(pm, newTask(pm, { title: `t${i}`, epic: 'A', date: D }).id, 'wt-a', D);
  const s = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' });
  assert.equal(s.split('\n').length, MAX_LINES);
  assert.match(s, /^\[pm\] demo · epic A · /);
  assert.match(s, /\n {2}… \d+ more lines — see BOARD\.md\nEpic A: 45 left of 45 \(45 in progress\)\n/);
});
