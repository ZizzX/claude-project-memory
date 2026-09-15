# T-031 Forge lookup (MR/PR data) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `pm show` turns the task's `pr` URL — or, without one, its branch on origin's forge — into state, merge time, merge/squash SHA and author, through `gh api` / `glab api`, and never fails because of the forge.

**Architecture:** A new `scripts/lib/forge.mjs` with pure parsers (`parsePrUrl`, `parseRemote`, `prRequest`, `normalizePr`), one exec function (`forgeApi`, with the `PM_FORGE_FIXTURE` test seam) and `prInfo`, which T-032 reuses for the undo block. `show.mjs` formats the result as the `pr:` line.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, git CLI, optional `gh` / `glab`; no dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-task-git-link-design.md` — section 4 (Forge lookup), section 3 (`pr` line), section 7 ("Forge" bullet).

## Global Constraints

- No new dependencies; the forge is reached only through `gh` / `glab` if installed.
- Exec timeout 10 s; any forge failure prints the URL with a note and exit code stays 0.
- Tests never touch the network: `test/helpers.mjs` points `PM_FORGE_FIXTURE` at a file that does not exist.
- `pm show` stays read-only: a PR found by branch is printed, not written into the task.
- SHAs print as 12 characters.
- Run `node --test` after every task; baseline: 95 tests, all passing.
- One commit after the author reviews the diff; no version bump (T-034).

## Verified before planning (2026-09-16)

- `gh api repos/ZizzX/claude-project-memory/pulls/1` → `state: "closed"`, `merged_at: "2026-09-12T23:55:12Z"`, `merge_commit_sha: "6f18174d…"` (a commit present locally), `user.login`, `html_url`.
- `gh api "repos/ZizzX/claude-project-memory/pulls?head=ZizzX%3Aai-agent-memory-system&state=all"` → 1 item (an encoded `owner:branch` works); a branch with no PR → `[]`.
- `gh api repos/x/y/pulls/1` → exit code 1 (404 is an exec failure → `null`).
- A missing CLI throws `ENOENT` from `execFileSync` → caught → `null`.
- `glab` is not installed on this machine: GitLab is covered by fixtures; `glab api --hostname` on a self-hosted host is checked live in T-034 (spec section 4, known risk).
- GitHub returns a test `merge_commit_sha` for open PRs, so a SHA is taken only when `merged_at` is set.

## Deviation from the spec

The note for a PR without data reads `(no data from gh)` instead of `(no data: gh/glab unavailable)`: the same note covers a 404 or a missing login, where "unavailable" would mislead. Task 2 updates the spec line.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/lib/forge.mjs` | create | URL/remote parsing, API request, response normalization, exec with fixture seam, `prInfo` |
| `scripts/lib/show.mjs` | modify | `pr:` line from `prInfo` |
| `test/helpers.mjs` | modify | hermetic `PM_FORGE_FIXTURE` |
| `test/forge.test.mjs` | create | parsers, normalization, exec seam, `prInfo` |
| `test/show.test.mjs` | modify | `pr:` line end to end |
| `docs/superpowers/specs/2026-09-14-task-git-link-design.md` | modify | the note wording |

---

### Task 1: forge.mjs

**Files:**
- Create: `scripts/lib/forge.mjs`
- Modify: `test/helpers.mjs:11-17`
- Test: `test/forge.test.mjs`

**Interfaces:**
- Consumes: `tryGit` from `paths.mjs`
- Produces (T-032 relies on `prInfo`):
  - `parsePrUrl(url: string): { kind: 'github'|'gitlab', host: string, project: string, number: number } | null`
  - `parseRemote(url: string): { kind, host, project } | null`
  - `prRequest(target: { kind, host, project, number? }, branch?: string): { cli: 'gh'|'glab', host: string, path: string }`
  - `normalizePr(kind, json): { url, state: 'open'|'merged'|'closed'|string, mergedAt: number|null, mergeSha: string|null, squashSha: string|null, author: string } | null`
  - `forgeApi(request): object | array | null`
  - `prInfo(data: { pr?, branch? }, cwd: string): (normalized PR & { foundByBranch?: true }) | { url, unavailable: string } | null`

- [ ] **Step 1: Make tests hermetic**

In `test/helpers.mjs`, add to the `Object.assign(process.env, { … })` literal:

```js
  PM_FORGE_FIXTURE: fileURLToPath(new URL('./no-forge-fixture.json', import.meta.url)), // missing on purpose: no network in tests
```

- [ ] **Step 2: Write the failing tests**

Create `test/forge.test.mjs`:

```js
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/forge.test.mjs`
Expected: FAIL — `Cannot find module …/scripts/lib/forge.mjs`.

- [ ] **Step 4: Implement forge.mjs**

Create `scripts/lib/forge.mjs`:

```js
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tryGit } from './paths.mjs';

const TIMEOUT_MS = 10_000;

// https://github.com/<owner>/<repo>/pull/<n> (or a GitHub Enterprise host), https://<host>/<group/…/project>/-/merge_requests/<iid>.
export function parsePrUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const gitlab = u.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (gitlab) return { kind: 'gitlab', host: u.host, project: gitlab[1], number: Number(gitlab[2]) };
  const github = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (github) return { kind: 'github', host: u.host, project: `${github[1]}/${github[2]}`, number: Number(github[3]) };
  return null;
}

// origin as https://host/path(.git), ssh://git@host[:port]/path(.git) or git@host:path(.git).
// ponytail: a host containing "github" is GitHub, anything else GitLab; add a git config key if a GHE host breaks it.
export function parseRemote(url) {
  const m = String(url).match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
  return m ? { kind: /github/i.test(m[1]) ? 'github' : 'gitlab', host: m[1], project: m[2] } : null;
}

// One PR by number, or the PRs of a branch (newest first — the forges' default order).
export function prRequest({ kind, host, project, number }, branch) {
  if (kind === 'github') {
    const owner = project.split('/')[0];
    const path = number ? `repos/${project}/pulls/${number}` : `repos/${project}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all`;
    return { cli: 'gh', host, path };
  }
  const base = `projects/${encodeURIComponent(project)}/merge_requests`;
  return { cli: 'glab', host, path: number ? `${base}/${number}` : `${base}?source_branch=${encodeURIComponent(branch)}&state=all` };
}

const unix = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

export function normalizePr(kind, json) {
  if (!json || typeof json !== 'object') return null;
  if (kind === 'github') {
    if (!json.html_url) return null;
    const merged = Boolean(json.merged_at); // an open PR carries a test merge_commit_sha: not a real merge
    return {
      url: json.html_url,
      state: merged ? 'merged' : json.state,
      mergedAt: unix(json.merged_at),
      mergeSha: merged ? json.merge_commit_sha ?? null : null,
      squashSha: null,
      author: json.user?.login ?? '',
    };
  }
  if (!json.web_url) return null;
  return {
    url: json.web_url,
    state: json.state === 'opened' ? 'open' : json.state,
    mergedAt: unix(json.merged_at),
    mergeSha: json.merge_commit_sha ?? null,
    squashSha: json.squash_commit_sha ?? null,
    author: json.author?.username ?? '',
  };
}

// One API call through the forge's own CLI. Any failure — no CLI, not logged in, offline, 404, bad JSON — is null.
export function forgeApi({ cli, host, path }) {
  try {
    const fixture = process.env.PM_FORGE_FIXTURE;
    if (fixture) return JSON.parse(fs.readFileSync(fixture, 'utf8'))[path] ?? null; // test seam: nothing is spawned
    const hostArgs = cli === 'gh' && host === 'github.com' ? [] : ['--hostname', host];
    const out = execFileSync(cli, ['api', ...hostArgs, path], { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function isDefaultBranch(cwd, branch) {
  const head = tryGit(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], cwd); // e.g. origin/master
  return head ? head === `origin/${branch}` : ['main', 'master'].includes(branch);
}

// The task's MR/PR with forge data: its `pr` URL, or else its branch looked up on origin's forge.
// null when there is nothing to show; { url, unavailable } when a known URL got no data.
export function prInfo(data, cwd) {
  if (data.pr) {
    const target = parsePrUrl(data.pr);
    if (!target) return { url: data.pr, unavailable: 'unknown PR URL' };
    const request = prRequest(target);
    const pr = normalizePr(target.kind, forgeApi(request));
    return pr ? { ...pr, url: data.pr } : { url: data.pr, unavailable: `no data from ${request.cli}` };
  }
  if (!data.branch || isDefaultBranch(cwd, data.branch)) return null;
  const remote = parseRemote(tryGit(['remote', 'get-url', 'origin'], cwd) ?? '');
  if (!remote) return null;
  const list = forgeApi(prRequest(remote, data.branch));
  const pr = Array.isArray(list) ? normalizePr(remote.kind, list[0]) : null;
  return pr ? { ...pr, foundByBranch: true } : null;
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test`
Expected: PASS, 101 tests (95 + 6).

---

### Task 2: the `pr:` line in `pm show`

**Files:**
- Modify: `scripts/lib/show.mjs` (import, `prLine`, one line in `showTask`)
- Modify: `test/show.test.mjs` (first end-to-end test, one new test)
- Modify: `docs/superpowers/specs/2026-09-14-task-git-link-design.md` (section 4, Degradation)

**Interfaces:**
- Consumes: `prInfo(data, cwd)` (Task 1)
- Produces: the `pr:` line —
  `pr: <url>[ (found by branch)] · <merged YYYY-MM-DD HH:MM | open | closed> [· merge <sha12> | · squash <sha12>] [· @author]`,
  or `pr: <url> (<no data from gh|glab | unknown PR URL>)`

- [ ] **Step 1: Write the failing tests**

In `test/show.test.mjs`, in the first end-to-end test (`pm show: header, branch, pr, …`), replace
`const r = cli(['show', 'T-001'], root);` with:

```js
  const fixture = path.join(root, '..', `${path.basename(root)}-forge.json`);
  fs.writeFileSync(fixture, JSON.stringify({
    'repos/o/r/pulls/7': { html_url: 'https://github.com/o/r/pull/7', state: 'closed', merged_at: '2026-09-10T09:02:00Z', merge_commit_sha: 'a1b2c3d4e5f6a7b8c9d0', user: { login: 'aziz' } },
  }));
  const r = cli(['show', 'T-001'], root, { env: { PM_FORGE_FIXTURE: fixture } });
```

and replace the `lines[2]` assertion with:

```js
  assert.match(lines[2], new RegExp(`^pr: https://github\\.com/o/r/pull/7 · merged ${STAMP} · merge a1b2c3d4e5f6 · @aziz$`));
```

Append a new test:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/show.test.mjs`
Expected: FAIL — the first end-to-end test (`pr:` line still the bare URL) and the new test (no `pr:` line for T-001, no note for T-002).

- [ ] **Step 3: Implement the `pr:` line**

In `scripts/lib/show.mjs`, add to the imports:

```js
import { prInfo } from './forge.mjs';
```

After the `stamp` constant add:

```js
function prLine(pr) {
  if (pr.unavailable) return `pr: ${pr.url} (${pr.unavailable})`;
  const parts = [`pr: ${pr.url}${pr.foundByBranch ? ' (found by branch)' : ''}`];
  parts.push(pr.state === 'merged' && pr.mergedAt ? `merged ${stamp(pr.mergedAt)}` : pr.state);
  if (pr.mergeSha) parts.push(`merge ${pr.mergeSha.slice(0, 12)}`);
  else if (pr.squashSha) parts.push(`squash ${pr.squashSha.slice(0, 12)}`);
  if (pr.author) parts.push(`@${pr.author}`);
  return parts.join(' · ');
}
```

In `showTask`, replace `if (data.pr) lines.push(`pr: ${data.pr}`);` with:

```js
  const pr = prInfo(data, cwd);
  if (pr) lines.push(prLine(pr));
```

- [ ] **Step 4: Update the spec wording**

In `docs/superpowers/specs/2026-09-14-task-git-link-design.md`, section 4, replace
``print the URL with `(no data: gh/glab unavailable)` and continue.`` with
``print the URL with `(no data from gh)` / `(no data from glab)` — or `(unknown PR URL)` — and continue.``

- [ ] **Step 5: Run the tests**

Run: `node --test`
Expected: PASS, 102 tests (101 + 1).

- [ ] **Step 6: Try it live**

From this worktree:

```bash
node scripts/pm.mjs show T-031
```

T-031 has `branch: ZizzX/git` and origin is github.com, so a real `gh api …pulls?head=ZizzX%3AZizzX%2Fgit…` runs.
Expected: no PR exists for this branch → no `pr:` line, output otherwise unchanged, command returns in well under 10 s.
Then check a real merged PR without touching the board, using a throwaway copy of the task data in a Node one-liner:

```bash
node -e "import('./scripts/lib/forge.mjs').then(f => console.log(f.prInfo({ pr: 'https://github.com/ZizzX/claude-project-memory/pull/1' }, process.cwd())))"
```

Expected: `state: 'merged'`, `mergedAt` ≈ 2026-09-12T23:55:12Z, `mergeSha: '6f18174d0421…'`, `author: 'ZizzX'`. Report both outputs.

- [ ] **Step 7: Review checkpoint**

`git add -N scripts/lib/forge.mjs test/forge.test.mjs && git diff --stat`; show the diff. Commit only after the author's OK, one commit with the plan:
`feat: pm show reads MR/PR state, merge SHA and author through gh/glab`.

---

## After both tasks (board, main agent only)

- `pm log T-031 …`; leftovers → `pm task new … --epic git --deps T-031`. Known leftover to check: the live `glab api --hostname` run belongs to T-034 — confirm its title mentions it, or add it.
- `pm set T-031 status=done` after the OK and a green `node --test`.
