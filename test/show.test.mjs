import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, sh, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';
import { timelineEvents } from '../scripts/lib/show.mjs';

const STAMP = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}';

test('timelineEvents keeps creation, claims and status changes of this id only, collapsing repeats', () => {
  const lines = [
    '100\tann\tpm: task new T-001',
    '110\tann\tpm: task new T-0011',
    '120\tann\tpm: claim T-001',
    '130\tann\tpm: log T-001',
    '140\tbob\tpm: claim T-001',
    '150\tann\tpm: set T-001 order=3',
    '160\tann\tpm: set T-001 order=3 status=waiting waiting_on=x',
    '170\tann\tpm: set T-0011 status=done',
    '180\tbob\tpm: set T-001 status=done',
  ];
  assert.deepEqual(timelineEvents(lines, 'T-001'), [
    { label: 'created', at: 100, author: 'ann' },
    { label: 'claimed', at: 120, author: 'ann' },
    { label: 'waiting', at: 160, author: 'ann' },
    { label: 'done', at: 180, author: 'bob' },
  ]);
  assert.deepEqual(timelineEvents([], 'T-001'), []);
  // A value can contain anything, including something that looks like a key; `pm set` quotes such values.
  const oneLine = (subject) => timelineEvents([`200\tann\t${subject}`], 'T-001').map((e) => e.label);
  assert.deepEqual(oneLine('pm: set T-001 "waiting_on=ответ, потом status=done" status=waiting'), ['waiting'], 'a key inside a quoted value is not an argument');
  assert.deepEqual(oneLine('pm: set T-001 status=waiting "waiting_on=потом status=done"'), ['waiting'], 'the order of the arguments does not matter');
  assert.deepEqual(oneLine('pm: set T-001 status=todo status=done'), ['done'], 'a repeated key resolves the way the CLI resolves it: the last one');
  assert.deepEqual(oneLine('pm: set T-001 waiting_on=status=done status=waiting'), ['waiting'], 'an unquoted value that contains = is still one token');
});

test('pm show: header, branch, pr, timeline, commits, decisions and dependents; nothing is written', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'export', '--epic', 'ATS-1'], root);
  cli(['task', 'new', '--title', 'import', '--deps', 'T-001'], root); // nothing claimed yet: no epic inherited
  cli(['claim', 'T-001'], root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'feat: csv writer'], root);
  const sha = sh(['rev-parse', 'HEAD'], root).slice(0, 12);
  cli(['decision', '--title', 'stream rows', '--why', 'memory', '--rejected', 'buffer', '--tasks', 'T-001'], root);
  cli(['set', 'T-001', 'pr=https://github.com/o/r/pull/7'], root);
  cli(['set', 'T-001', 'status=done'], root); // flushes the commit into the task
  const pm = pmDir(root);
  const head = sh(['rev-parse', 'HEAD'], pm);
  const fixture = path.join(root, '..', `${path.basename(root)}-forge.json`);
  fs.writeFileSync(fixture, JSON.stringify({
    'repos/o/r/pulls/7': { html_url: 'https://github.com/o/r/pull/7', state: 'closed', merged_at: '2026-09-10T09:02:00Z', merge_commit_sha: 'a1b2c3d4e5f6a7b8c9d0', user: { login: 'aziz' } },
  }));
  const r = cli(['show', 'T-001'], root, { env: { PM_FORGE_FIXTURE: fixture } });
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.equal(lines[0], 'T-001 export · done · epic ATS-1');
  assert.equal(lines[1], 'branch: main');
  assert.match(lines[2], new RegExp(`^pr: https://github\\.com/o/r/pull/7 · merged ${STAMP} · merge a1b2c3d4e5f6 · @aziz$`));
  assert.match(lines[3], new RegExp(`^timeline: created ${STAMP} test · claimed ${STAMP} test · done ${STAMP} test$`));
  assert.equal(lines[4], 'commits (1):');
  assert.match(lines[5], new RegExp(`^  ${sha} ${STAMP} test  feat: csv writer$`));
  assert.equal(lines[6], 'decisions: D-001 stream rows');
  assert.equal(lines[7], 'depended on by: T-002 (todo)');
  assert.equal(lines[8], 'undo:', 'the commit is in HEAD, so an undo block follows');
  assert.equal(sh(['rev-parse', 'HEAD'], pm), head, 'no board commit');
  assert.equal(sh(['status', '--porcelain'], pm), '', 'no board write');
});

test('pm show: a real set with a spacey value keeps the timeline honest', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  const r = cli(['set', 'T-001', 'waiting_on=ответ по датам, потом status=done', 'status=waiting'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(cli(['show', 'T-001'], root).out, new RegExp(`\\ntimeline: created ${STAMP} test · waiting ${STAMP} test$`));
});

test('pm show on a task without git fields prints only what exists', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'plain'], root);
  assert.match(cli(['show', 'T-001'], root).out, new RegExp(`^T-001 plain · todo\\ntimeline: created ${STAMP} test$`));
});

test('pm show: no linked commits yet is explained; a rewritten SHA is marked', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  cli(['claim', 'T-001'], root);
  assert.match(cli(['show', 'T-001'], root).out, /\ncommits: none linked yet — commits made in this worktree after pm claim appear here$/);
  cli(['set', 'T-001', 'commits=deadbeefdead'], root);
  assert.match(cli(['show', 'T-001'], root).out, /\ncommits \(1\):\n {2}deadbeefdead \(rewritten — not in this repository\)\n/);
});

test('pm show: an MR found by branch on a GitLab origin; a PR the forge has no data for says so', () => {
  const { root } = setup();
  sh(['remote', 'add', 'origin', 'git@gitlab.corp.io:ats/app.git'], root);
  sh(['switch', '-q', '-c', 'feat/x'], root);
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['task', 'new', '--title', 'b'], root);
  cli(['claim', 'T-001'], root);
  cli(['set', 'T-002', 'pr=https://github.com/o/r/pull/9'], root);
  const fixture = path.join(root, '..', `${path.basename(root)}-forge.json`);
  fs.writeFileSync(fixture, JSON.stringify({
    'projects/ats%2Fapp/merge_requests?source_branch=feat%2Fx&state=all': [
      { web_url: 'https://gitlab.corp.io/ats/app/-/merge_requests/3', state: 'opened', author: { username: 'aziz' } },
    ],
  }));
  const env = { env: { PM_FORGE_FIXTURE: fixture } };
  assert.match(cli(['show', 'T-001'], root, env).out, /\npr: https:\/\/gitlab\.corp\.io\/ats\/app\/-\/merge_requests\/3 \(found by branch\) · open · @aziz\n/);
  assert.match(cli(['show', 'T-002'], root, env).out, /\npr: https:\/\/github\.com\/o\/r\/pull\/9 \(no data from gh\)\n/);
});

test('pm show: unknown id and missing id are errors', () => {
  const { root } = setup();
  cli(['init'], root);
  const unknown = cli(['show', 'T-404'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown task T-404/);
  const missing = cli(['show'], root);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /usage: pm show <id>/);
});
