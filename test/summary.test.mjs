import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmp } from './helpers.mjs';
import { newTask, setFields, claim, appendLog } from '../scripts/lib/tasks.mjs';
import { planFile, planTemplate } from '../scripts/lib/plan.mjs';
import { appendDecision } from '../scripts/lib/decisions.mjs';
import { buildSummary, MAX_LINES } from '../scripts/lib/summary.mjs';

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
