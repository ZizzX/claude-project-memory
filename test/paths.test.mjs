import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setup, addWorktree, tmp } from './helpers.mjs';
import { repoKey, pmDir, memoryDir, worktreeName, mainRoot, claudeHome, today } from '../scripts/lib/paths.mjs';

test('repoKey replaces every non-alphanumeric char with a dash', () => {
  assert.equal(repoKey('C:\\Users\\a\\my proj'), 'C--Users-a-my-proj');
  assert.equal(repoKey('/Users/a/проект'), `-Users-a-${'-'.repeat(6)}`);
});

test('pm/ resolves to one folder from the main and a linked worktree', () => {
  const { home, root } = setup();
  const wt = addWorktree(root, 'feature');
  assert.equal(pmDir(wt), pmDir(root));
  assert.equal(path.dirname(pmDir(root)), path.join(home, 'projects', repoKey(mainRoot(root))));
  assert.equal(memoryDir(wt), path.join(path.dirname(pmDir(root)), 'memory'));
  assert.equal(worktreeName(wt), path.basename(wt));
  assert.equal(worktreeName(root), path.basename(root));
  assert.equal(claudeHome(), home);
});

test('outside a git repo there is no pm dir', () => {
  setup();
  assert.equal(pmDir(tmp()), null);
  assert.equal(worktreeName(tmp()), null);
});

test('today is YYYY-MM-DD', () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});
