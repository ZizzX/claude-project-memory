import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmp } from './helpers.mjs';
import { decisionsFile, appendDecision, recentDecisions } from '../scripts/lib/decisions.mjs';
import { planFile, planTemplate, projectName, currentFocus } from '../scripts/lib/plan.mjs';

const D = '2026-09-12';

test('appendDecision numbers entries; recentDecisions is newest first', () => {
  const pm = tmp();
  fs.writeFileSync(decisionsFile(pm), '# Decisions\n');
  assert.equal(appendDecision(pm, { title: 'Store board outside branches', why: 'worktrees', rejected: 'in-repo', tasks: ['T-001'], date: D }), 'D-001');
  assert.equal(appendDecision(pm, { title: 'Own format', why: 'fits', rejected: 'Backlog.md', date: D }), 'D-002');
  const text = fs.readFileSync(decisionsFile(pm), 'utf8');
  assert.match(text, /## D-001 · 2026-09-12 · Store board outside branches\n- why: worktrees\n- rejected: in-repo\n- tasks: T-001\n/);
  assert.deepEqual(recentDecisions(pm, 3), [
    { id: 'D-002', date: D, title: 'Own format' },
    { id: 'D-001', date: D, title: 'Store board outside branches' },
  ]);
});

test('appendDecision creates the file when missing', () => {
  const pm = tmp();
  assert.equal(appendDecision(pm, { title: 't', why: 'w', rejected: 'r', date: D }), 'D-001');
  assert.deepEqual(recentDecisions(tmp()), []);
});

test('plan template exposes name and focus', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  assert.equal(projectName(pm), 'demo');
  assert.equal(currentFocus(pm), '');
  fs.writeFileSync(planFile(pm), planTemplate('demo', D).replace('## Current focus\n', '## Current focus\nM1 board core\n'));
  assert.equal(currentFocus(pm), 'M1 board core');
  assert.equal(projectName(tmp()), '');
});
