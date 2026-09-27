import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, tmp, sh } from './helpers.mjs';
import { subjectIds, sinceDate, subjectHits, originHeadHint, problem, mergeCandidates } from '../scripts/lib/merged.mjs';

function mk(id, data = {}, body = '## Log\n') {
  return { id, file: `${id}.md`, body, data: { id, status: 'in_progress', updated: '2026-09-01', depends_on: [], worktrees: [], ...data } };
}

// A commit on the current branch with a fixed committer date; returns its SHA.
function commit(root, subject, date, body = '') {
  fs.appendFileSync(path.join(root, 'README.md'), `${subject}\n`);
  sh(['add', '-A'], root);
  const env = { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  execFileSync('git', ['commit', '-q', '-m', subject, ...(body ? ['-m', body] : [])], { cwd: root, env });
  return sh(['rev-parse', 'HEAD'], root);
}

const publish = (root, branch = 'master') => sh(['update-ref', `refs/remotes/origin/${branch}`, 'HEAD'], root);

test('subjectIds: conventional scope and brackets, nothing else', () => {
  assert.deepEqual([...subjectIds('feat(T-038): pm alias (#10)')], ['T-038']);
  assert.deepEqual([...subjectIds('fix(PM-056)!: board')], ['PM-056']);
  assert.deepEqual([...subjectIds('[T-041] keep scroll [PM-060]')].sort(), ['PM-060', 'T-041']);
  assert.deepEqual([...subjectIds('docs: after T-041 lands')], []);
  assert.deepEqual([...subjectIds('feat(board): T-041 mention')], []);
});

test('sinceDate: the first Log date, else updated; the oldest wins', () => {
  assert.equal(sinceDate([mk('T-001', { updated: '2026-09-20' }, '## Log\n- 2026-09-10 · w · did: a · next: b\n- 2026-09-15 · w · did: c · next: d\n'), mk('T-002', { updated: '2026-09-12' })]), '2026-09-10');
  assert.equal(sinceDate([]), null);
});

test('mergeCandidates: open statuses including review, never done or dropped', () => {
  const ts = ['todo', 'in_progress', 'waiting', 'review', 'done', 'dropped'].map((s, i) => mk(`T-00${i + 1}`, { status: s }));
  assert.deepEqual(mergeCandidates(ts).map((t) => t.id), ['T-001', 'T-002', 'T-003', 'T-004']);
});

test('subjectHits: the newest subject per open task, body ignored, mixed prefixes, bounded by --since', () => {
  const { root } = setup();
  commit(root, 'feat(T-005): too old to count', '2026-08-01T10:00:00');
  const first = commit(root, 'feat(T-038): first part (#9)', '2026-09-10T10:00:00');
  const latest = commit(root, 'feat(T-038): second part (#10)', '2026-09-12T10:00:00');
  commit(root, 'docs: notes', '2026-09-12T11:00:00', 'follows T-041');
  const pm56 = commit(root, '[PM-056] board design', '2026-09-13T10:00:00');
  commit(root, 'feat(T-099): done task', '2026-09-13T11:00:00');
  publish(root);
  const tasks = [
    mk('T-005', { status: 'todo', updated: '2026-09-02' }),
    mk('T-038', { status: 'review' }),
    mk('T-041'),
    mk('PM-056', { status: 'waiting' }),
    mk('T-099', { status: 'done' }),
  ];
  const { branch, hits, notChecked } = subjectHits(root, tasks);
  assert.equal(notChecked, null);
  assert.equal(branch.ref, 'origin/master');
  assert.deepEqual([...hits.keys()].sort(), ['PM-056', 'T-038']);
  assert.deepEqual(hits.get('T-038'), { how: 'subject', sha: latest, at: Date.parse('2026-09-12T10:00:00') / 1000, pr: '#10' });
  assert.notEqual(hits.get('T-038').sha, first);
  assert.deepEqual(hits.get('PM-056'), { how: 'subject', sha: pm56, at: Date.parse('2026-09-13T10:00:00') / 1000, pr: null });
});

test('subjectHits: no default branch ref → not checked with a fix, no exception', () => {
  const { root } = setup();
  const { hits, notChecked } = subjectHits(root, [mk('T-001')]);
  assert.equal(hits.size, 0);
  assert.match(notChecked, /^Merge not checked — .+ — fix: git fetch origin, then pm reconcile$/);
});

test('originHeadHint: printed once per repo, only when main/master was guessed', () => {
  const pm = tmp();
  assert.equal(originHeadHint(pm, { ref: 'origin/trunk', guessed: false }), null);
  assert.match(originHeadHint(pm, { ref: 'origin/master', guessed: true }), /fix: git remote set-head origin -a$/);
  assert.equal(originHeadHint(pm, { ref: 'origin/master', guessed: true }), null);
});

test('problem: what — why — fix', () => {
  assert.equal(problem('Merge not checked: T-041', 'gh is not installed', 'install gh, then pm reconcile'), 'Merge not checked: T-041 — gh is not installed — fix: install gh, then pm reconcile');
});
