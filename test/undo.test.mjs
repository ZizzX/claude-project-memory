import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, sh, cli } from './helpers.mjs';

function commit(cwd, name, message = name, content = `${name}\n`) {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
  sh(['add', '-A'], cwd);
  sh(['commit', '-q', '-m', message], cwd);
  return head(cwd);
}
const head = (cwd) => sh(['rev-parse', 'HEAD'], cwd).slice(0, 12);
const files = (cwd) => sh(['ls-files'], cwd).split('\n').sort();

function forge(root, responses) {
  const file = path.join(root, '..', `${path.basename(root)}-forge.json`);
  fs.writeFileSync(file, JSON.stringify(responses));
  return { env: { PM_FORGE_FIXTURE: file } };
}

// The rows after "undo:", without their indentation.
function undoOf(root, id, opts) {
  const lines = cli(['show', id], root, opts).out.split('\n');
  const at = lines.indexOf('undo:');
  return at === -1 ? null : lines.slice(at + 1).map((l) => l.trim());
}
// Runs a printed row ("revert: git revert …   (why)") exactly as a person would paste it.
function run(cwd, row) {
  const command = row.replace(/^\w+:\s+/, '').split('   (')[0];
  sh(command.replace(/^git /, '').split(' '), cwd);
}

test('undo, task commits: reverted newest first; the printed commands really undo and restore', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['task', 'new', '--title', 'b'], root);
  const init = head(root);
  cli(['claim', 'T-001'], root);
  const a = commit(root, 'a.txt');
  const b = commit(root, 'b.txt');
  cli(['set', 'T-001', 'status=done'], root);
  cli(['claim', 'T-002'], root);
  commit(root, 'c.txt');
  cli(['set', 'T-002', 'status=done'], root);
  const undo = undoOf(root, 'T-001');
  assert.deepEqual(undo, [
    `revert: git revert --no-edit ${b} ${a}   (the task's commits, newest first)`,
    `before: git switch -c before/T-001 ${init}   (the state before the task)`,
  ]);
  run(root, undo[0]);
  assert.deepEqual(files(root), ['README.md', 'c.txt']);
  run(root, undo[1]);
  assert.deepEqual(files(root), ['README.md']);
});

test('undo risks: a done dependent and a later commit on the same file, named by its task', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['task', 'new', '--title', 'b', '--deps', 'T-001'], root);
  cli(['claim', 'T-001'], root);
  commit(root, 'shared.txt');
  cli(['set', 'T-001', 'status=done'], root);
  cli(['claim', 'T-002'], root);
  const later = commit(root, 'shared.txt', 'edit shared', 'edited\n');
  cli(['set', 'T-002', 'status=done'], root);
  const undo = undoOf(root, 'T-001');
  assert.equal(undo[2], `risk:   T-002 (done) depends on T-001 · same files changed later: ${later} (T-002)`);
});

test('undo, merged PR with a merge commit: git revert -m 1; before is the first parent', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  sh(['switch', '-q', '-c', 'feat'], root);
  cli(['claim', 'T-001'], root);
  commit(root, 'a.txt');
  commit(root, 'b.txt');
  cli(['set', 'T-001', 'status=done'], root);
  sh(['switch', '-q', 'main'], root);
  const mainBefore = head(root);
  sh(['merge', '-q', '--no-ff', '-m', 'Merge PR #7', 'feat'], root);
  const merge = sh(['rev-parse', 'HEAD'], root);
  cli(['set', 'T-001', 'pr=https://github.com/o/r/pull/7'], root);
  const opts = forge(root, {
    'repos/o/r/pulls/7': { html_url: 'https://github.com/o/r/pull/7', state: 'closed', merged_at: '2026-09-16T10:00:00Z', merge_commit_sha: merge, commits: 2, user: { login: 'aziz' } },
  });
  const undo = undoOf(root, 'T-001', opts);
  assert.deepEqual(undo, [
    `revert: git revert --no-edit -m 1 ${merge.slice(0, 12)}   (merge commit of the MR/PR)`,
    `before: git switch -c before/T-001 ${mainBefore}   (the state before the task)`,
  ]);
  run(root, undo[0]);
  assert.deepEqual(files(root), ['README.md']);
});

test('undo, squash-merged MR: plain revert of the squash; a one-parent SHA of a multi-commit GitHub PR is flagged', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  sh(['switch', '-q', '-c', 'feat'], root);
  cli(['claim', 'T-001'], root);
  commit(root, 'a.txt');
  commit(root, 'b.txt');
  cli(['set', 'T-001', 'status=done'], root);
  sh(['switch', '-q', 'main'], root);
  sh(['merge', '-q', '--squash', 'feat'], root);
  sh(['commit', '-q', '-m', 'Squash MR !3'], root);
  const squash = sh(['rev-parse', 'HEAD'], root);
  const merged = { state: 'closed', merged_at: '2026-09-16T10:00:00Z', user: { login: 'aziz' } };
  const opts = forge(root, {
    'projects/ats%2Fapp/merge_requests/3': { web_url: 'https://gitlab.corp.io/ats/app/-/merge_requests/3', state: 'merged', merged_at: '2026-09-16T10:00:00Z', merge_commit_sha: null, squash_commit_sha: squash, author: { username: 'aziz' } },
    'repos/o/r/pulls/8': { html_url: 'https://github.com/o/r/pull/8', ...merged, merge_commit_sha: squash, commits: 2 },
  });
  cli(['set', 'T-001', 'pr=https://gitlab.corp.io/ats/app/-/merge_requests/3'], root);
  const undo = undoOf(root, 'T-001', opts);
  assert.equal(undo[0], `revert: git revert --no-edit ${squash.slice(0, 12)}   (squash commit of the MR/PR)`);
  cli(['set', 'T-001', 'pr=https://github.com/o/r/pull/8'], root);
  assert.match(undoOf(root, 'T-001', opts)[0], /\(one-parent merge of a 2-commit PR: a squash is reverted whole, a rebase merge only in its last commit — check first\)$/);
  run(root, undo[0]);
  assert.deepEqual(files(root), ['README.md']);
});

test('undo does not depend on the stored order, the cwd or the file names; an unknown PR commit count warns', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'order'], root);
  cli(['task', 'new', '--title', 'pr'], root);
  const init = head(root);
  cli(['claim', 'T-001'], root);
  const older = commit(root, 'док/отчёт.txt'); // non-ASCII: quoted and escaped by git unless core.quotePath=false
  const newer = commit(root, 'b.txt');
  cli(['set', 'T-001', 'status=done'], root);
  cli(['set', 'T-001', `commits=${newer},${older}`], root); // stored in the wrong order on purpose
  cli(['claim', 'T-002'], root);
  const later = commit(root, 'док/отчёт.txt', 'edit report', 'edited\n');
  cli(['set', 'T-002', 'status=done'], root);
  const sub = path.join(root, 'док');
  for (const cwd of [root, sub]) {
    assert.deepEqual(undoOf(cwd, 'T-001'), [
      `revert: git revert --no-edit ${newer} ${older}   (the task's commits, newest first)`,
      `before: git switch -c before/T-001 ${init}   (the state before the task)`,
      `risk:   same files changed later: ${later} (T-002)`,
    ], `from ${cwd === root ? 'the root' : 'a subdirectory'}`);
  }

  sh(['switch', '-q', '-c', 'feat'], root);
  commit(root, 'c.txt');
  sh(['switch', '-q', 'main'], root);
  sh(['merge', '-q', '--squash', 'feat'], root);
  sh(['commit', '-q', '-m', 'Squash PR'], root);
  const oneParent = sh(['rev-parse', 'HEAD'], root);
  cli(['set', 'T-002', 'pr=https://github.com/o/r/pull/11'], root);
  const opts = forge(root, { // a PR found by number, but the payload carries no commit count
    'repos/o/r/pulls/11': { html_url: 'https://github.com/o/r/pull/11', state: 'closed', merged_at: '2026-09-16T10:00:00Z', merge_commit_sha: oneParent, user: { login: 'a' } },
  });
  assert.match(undoOf(root, 'T-002', opts)[0], /\(one-parent merge of the MR\/PR: a squash is reverted whole/);
});

test('undo notes: code not in this branch, merged commit not fetched, rewritten commits, a partial revert; nothing to undo prints no block', () => {
  const { root } = setup();
  cli(['init'], root);
  for (const title of ['on-branch', 'rewritten', 'not-fetched', 'partial', 'empty']) cli(['task', 'new', '--title', title], root);
  sh(['switch', '-q', '-c', 'feat'], root);
  cli(['claim', 'T-001'], root);
  commit(root, 'feat.txt');
  cli(['set', 'T-001', 'status=done'], root);
  sh(['switch', '-q', 'main'], root);
  assert.deepEqual(undoOf(root, 'T-001'), ["note:   the task's code is not in the current branch"]);

  cli(['set', 'T-002', 'commits=deadbeefdead'], root);
  assert.deepEqual(undoOf(root, 'T-002'), ['note:   commits were rewritten and no merged MR/PR was found — cannot undo automatically']);

  cli(['set', 'T-003', 'pr=https://github.com/o/r/pull/9'], root);
  const opts = forge(root, {
    'repos/o/r/pulls/9': { html_url: 'https://github.com/o/r/pull/9', state: 'closed', merged_at: '2026-09-16T10:00:00Z', merge_commit_sha: 'f'.repeat(40), user: { login: 'a' } },
  });
  assert.deepEqual(undoOf(root, 'T-003', opts), [`note:   the merged MR/PR commit ${'f'.repeat(12)} is not in this repository — git fetch, then pm show again`]);

  cli(['claim', 'T-004'], root);
  const kept = commit(root, 'kept.txt');
  cli(['set', 'T-004', 'status=done'], root);
  cli(['set', 'T-004', `commits=${kept},deadbeefdead`], root);
  const partial = undoOf(root, 'T-004');
  assert.equal(partial[0], `revert: git revert --no-edit ${kept}   (the task's commits, newest first)`);
  assert.ok(partial.includes('note:   1 of 2 commits are not in the current branch or were rewritten; only the rest is reverted'));

  assert.equal(undoOf(root, 'T-005'), null);
});
