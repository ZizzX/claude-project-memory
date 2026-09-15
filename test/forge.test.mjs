import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp, sh } from './helpers.mjs';
import { parsePrUrl, parseRemote, prRequest, normalizePr, forgeApi, prInfo } from '../scripts/lib/forge.mjs';

function withFixture(responses, fn) {
  const file = path.join(tmp(), 'forge.json');
  fs.writeFileSync(file, JSON.stringify(responses));
  const prev = process.env.PM_FORGE_FIXTURE;
  process.env.PM_FORGE_FIXTURE = file;
  try {
    return fn(file);
  } finally {
    process.env.PM_FORGE_FIXTURE = prev;
  }
}

test('parsePrUrl: GitHub, GitHub Enterprise, gitlab.com, self-hosted GitLab with subgroups; anything else is null', () => {
  assert.deepEqual(parsePrUrl('https://github.com/ZizzX/claude-project-memory/pull/1'), { kind: 'github', host: 'github.com', project: 'ZizzX/claude-project-memory', number: 1 });
  assert.deepEqual(parsePrUrl('https://ghe.corp.io/team/app/pull/42/files'), { kind: 'github', host: 'ghe.corp.io', project: 'team/app', number: 42 });
  assert.deepEqual(parsePrUrl('https://gitlab.com/g/p/-/merge_requests/5'), { kind: 'gitlab', host: 'gitlab.com', project: 'g/p', number: 5 });
  assert.deepEqual(parsePrUrl('https://git.corp.io/ats/front/app/-/merge_requests/412#note_1'), { kind: 'gitlab', host: 'git.corp.io', project: 'ats/front/app', number: 412 });
  assert.equal(parsePrUrl('https://github.com/o/r/issues/3'), null);
  assert.equal(parsePrUrl('not a url'), null);
});

test('parseRemote: https, ssh and scp-like origins', () => {
  assert.deepEqual(parseRemote('https://github.com/ZizzX/claude-project-memory.git'), { kind: 'github', host: 'github.com', project: 'ZizzX/claude-project-memory' });
  assert.deepEqual(parseRemote('git@gitlab.corp.io:ats/front/app.git'), { kind: 'gitlab', host: 'gitlab.corp.io', project: 'ats/front/app' });
  assert.deepEqual(parseRemote('ssh://git@git.corp.io:2222/ats/app.git'), { kind: 'gitlab', host: 'git.corp.io', project: 'ats/app' });
  assert.equal(parseRemote(''), null);
});

test('prRequest builds the API path for one PR or a branch lookup', () => {
  assert.deepEqual(prRequest({ kind: 'github', host: 'github.com', project: 'o/r', number: 7 }), { cli: 'gh', host: 'github.com', path: 'repos/o/r/pulls/7' });
  assert.deepEqual(prRequest({ kind: 'github', host: 'github.com', project: 'o/r' }, 'feat/x'), { cli: 'gh', host: 'github.com', path: 'repos/o/r/pulls?head=o%3Afeat%2Fx&state=all' });
  assert.deepEqual(prRequest({ kind: 'gitlab', host: 'git.corp.io', project: 'ats/front/app', number: 412 }), { cli: 'glab', host: 'git.corp.io', path: 'projects/ats%2Ffront%2Fapp/merge_requests/412' });
  assert.deepEqual(prRequest({ kind: 'gitlab', host: 'git.corp.io', project: 'ats/app' }, 'feat/ATS-1'), { cli: 'glab', host: 'git.corp.io', path: 'projects/ats%2Fapp/merge_requests?source_branch=feat%2FATS-1&state=all' });
});

test('normalizePr: GitHub merged and open, GitLab merged with squash, bad shapes', () => {
  assert.deepEqual(
    normalizePr('github', { html_url: 'u', state: 'closed', merged_at: '2026-09-12T23:55:12Z', merge_commit_sha: 'abc', user: { login: 'ZizzX' } }),
    { url: 'u', state: 'merged', mergedAt: Date.parse('2026-09-12T23:55:12Z') / 1000, mergeSha: 'abc', squashSha: null, author: 'ZizzX' },
  );
  assert.equal(normalizePr('github', { html_url: 'u', state: 'open', merged_at: null, merge_commit_sha: 'test-merge', user: { login: 'a' } }).mergeSha, null, 'an open PR only has a test merge');
  assert.deepEqual(
    normalizePr('gitlab', { web_url: 'w', state: 'merged', merged_at: '2026-09-10T09:02:00.000Z', merge_commit_sha: null, squash_commit_sha: 'sq', author: { username: 'aziz' } }),
    { url: 'w', state: 'merged', mergedAt: Date.parse('2026-09-10T09:02:00.000Z') / 1000, mergeSha: null, squashSha: 'sq', author: 'aziz' },
  );
  assert.equal(normalizePr('gitlab', { web_url: 'w', state: 'opened' }).state, 'open');
  assert.equal(normalizePr('github', { message: 'Not Found' }), null);
  assert.equal(normalizePr('gitlab', null), null);
});

test('forgeApi reads the fixture instead of spawning; a missing key, file or CLI is null', () => {
  withFixture({ 'repos/o/r/pulls/7': { html_url: 'u' } }, () => {
    assert.deepEqual(forgeApi({ cli: 'gh', host: 'github.com', path: 'repos/o/r/pulls/7' }), { html_url: 'u' });
    assert.equal(forgeApi({ cli: 'gh', host: 'github.com', path: 'repos/o/r/pulls/8' }), null);
  });
  const prev = process.env.PM_FORGE_FIXTURE;
  try {
    delete process.env.PM_FORGE_FIXTURE; // the real exec path, with a CLI that does not exist: no network
    assert.equal(forgeApi({ cli: 'pm-no-such-cli', host: 'git.corp.io', path: 'x' }), null);
  } finally {
    process.env.PM_FORGE_FIXTURE = prev;
  }
});

test('prInfo: pr URL with data, without data, unknown shape; lookup by branch skips the default branch', () => {
  const { root } = setup();
  sh(['remote', 'add', 'origin', 'git@gitlab.corp.io:ats/app.git'], root);
  withFixture({
    'repos/o/r/pulls/7': { html_url: 'https://github.com/o/r/pull/7', state: 'open', merged_at: null, user: { login: 'a' } },
    'projects/ats%2Fapp/merge_requests?source_branch=feat%2Fx&state=all': [
      { web_url: 'https://gitlab.corp.io/ats/app/-/merge_requests/3', state: 'merged', merged_at: '2026-09-10T09:02:00Z', merge_commit_sha: 'm1', squash_commit_sha: 's1', author: { username: 'aziz' } },
    ],
    'projects/ats%2Fapp/merge_requests?source_branch=main&state=all': [{ web_url: 'main-mr', state: 'opened' }],
    'projects/ats%2Fapp/merge_requests?source_branch=feat%2Fnone&state=all': [],
  }, () => {
    assert.equal(prInfo({ pr: 'https://github.com/o/r/pull/7' }, root).state, 'open');
    assert.deepEqual(prInfo({ pr: 'https://github.com/o/r/pull/8' }, root), { url: 'https://github.com/o/r/pull/8', unavailable: 'no data from gh' });
    assert.deepEqual(prInfo({ pr: 'https://example.com/whatever' }, root), { url: 'https://example.com/whatever', unavailable: 'unknown PR URL' });
    const byBranch = prInfo({ branch: 'feat/x' }, root);
    assert.equal(byBranch.foundByBranch, true);
    assert.equal(byBranch.mergeSha, 'm1');
    assert.equal(prInfo({ branch: 'main' }, root), null, 'no origin/HEAD: main and master are never looked up');
    assert.equal(prInfo({ branch: 'feat/none' }, root), null);
    assert.equal(prInfo({}, root), null);
    sh(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], root);
    assert.equal(prInfo({ branch: 'trunk' }, root), null, 'origin/HEAD names the default branch');
    assert.equal(prInfo({ branch: 'main' }, root).url, 'main-mr');
  });
});
