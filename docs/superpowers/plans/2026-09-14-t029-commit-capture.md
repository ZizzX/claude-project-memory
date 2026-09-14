# T-029 Commit capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A task in progress learns its branch at `pm claim` and collects the SHAs of every commit created in its worktree (by the agent or by hand) into a `commits` frontmatter field.

**Architecture:** A new `scripts/lib/gitlink.mjs` reads the worktree's HEAD reflog file from a byte-offset cursor kept in `.state/`, keeps only commit-creating entries, and appends short SHAs to the single in-progress task of that worktree. `pm claim`, `pm set status=…`, the Stop hook and PreCompact/SessionEnd call it. Automatic task-file writes are recorded in `.state/auto-mtime.json` so the Stop nudge still sees a stale board.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, git CLI; no dependencies.

**Spec:** `docs/superpowers/specs/2026-09-14-task-git-link-design.md` — sections 1 (Data model), 2 (Commit capture), 6 (Compatibility), 7 (Testing, "Capture" bullet).

## Global Constraints

- No new dependencies; stdlib + git CLI only (repo convention).
- Code, comments, test names in English; board free text in Russian.
- Hooks never break a session: `captureCommits` never throws.
- Tasks without `branch` / `commits` / `pr` serialize exactly as before — the fields are written only when set.
- SHAs are stored as the first 12 characters.
- Run `node --test` after every task; baseline before this plan: 75 tests, all passing.
- Never commit without the author's explicit OK: each task ends with a diff for review, not a commit (memory: workflow rules for the plugin repo).
- No version bump in this plan (that is T-034, D-009).

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `scripts/lib/store.mjs` | modify | gains `readState` / `writeState` (moved from `hooks.mjs`) and `autoWrite` / `manualMtime` — local `.state/` bookkeeping of the board |
| `scripts/lib/tasks.mjs` | modify | `commits` list field, optional `branch` in `claim` |
| `scripts/lib/gitlink.mjs` | create | reflog reading, capture cursor, `captureCommits`, `currentBranch` |
| `scripts/lib/hooks.mjs` | modify | uses store state helpers; capture in `onStop` / `onSafetyNote`; `lastBoardUpdate` via `manualMtime` |
| `scripts/pm.mjs` | modify | capture + cursor reset in `claim` and `set` |
| `test/board-store.test.mjs` | modify | `autoWrite` / `manualMtime` |
| `test/tasks.test.mjs` | modify | `claim` branch, `commits` list |
| `test/gitlink.test.mjs` | create | reflog parsing and end-to-end capture through the CLI and hooks |

---

### Task 1: Board bookkeeping — state helpers, automatic writes, task fields

**Files:**
- Modify: `scripts/lib/store.mjs` (append after `persist`, before `initBoard`)
- Modify: `scripts/lib/hooks.mjs:23-34` (remove local state helpers), `:5` (import)
- Modify: `scripts/lib/tasks.mjs:8`, `:20-33`, `:112-116`
- Test: `test/board-store.test.mjs`, `test/tasks.test.mjs`

**Interfaces:**
- Produces (store.mjs):
  - `readState(pm: string, name: string): object` — `{}` when missing or unreadable
  - `writeState(pm: string, name: string, value: object): void`
  - `autoWrite(pm: string, file: string, write: () => void): void` — runs `write`, records `{ before, after }` mtimes under `path.basename(file)` in state `auto-mtime`
  - `manualMtime(pm: string, file: string): number` — `before` while the file's mtimeMs equals the recorded `after`, else the real mtimeMs
- Produces (tasks.mjs):
  - `claim(pm, id, worktree, date, branch = '')` — writes `branch` only when non-empty
  - `task.data.commits: string[]` — present only when the file has a `commits:` line; `setFields(pm, id, { commits: 'a,b' })` normalizes to a list

- [ ] **Step 1: Write the failing store test**

Add to the import line of `test/board-store.test.mjs`:

```js
import { initBoard, hasBoard, commitPm, isSyncOn, autoWrite, manualMtime } from '../scripts/lib/store.mjs';
```

Append at the end of the file:

```js
test('manualMtime sees past automatic writes but not past a later manual one', () => {
  const pm = tmp();
  const file = path.join(pm, 'T-001.md');
  fs.writeFileSync(file, 'a');
  const past = new Date(Date.now() - 3_600_000);
  fs.utimesSync(file, past, past);
  const original = fs.statSync(file).mtimeMs;
  autoWrite(pm, file, () => fs.writeFileSync(file, 'ab'));
  autoWrite(pm, file, () => fs.writeFileSync(file, 'abc')); // a second automatic write keeps the first "before"
  assert.equal(manualMtime(pm, file), original);
  fs.writeFileSync(file, 'manual');
  const later = new Date(Date.now() + 5_000); // explicit, so a coarse-mtime filesystem cannot tie with "after"
  fs.utimesSync(file, later, later);
  assert.equal(manualMtime(pm, file), fs.statSync(file).mtimeMs);
  assert.equal(manualMtime(tmp(), file), fs.statSync(file).mtimeMs, 'no record: the real mtime');
});
```

- [ ] **Step 2: Write the failing tasks test**

Append at the end of `test/tasks.test.mjs`:

```js
test('claim writes the branch only when there is one; commits is an optional list', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  newTask(pm, { title: 'y', date: D });
  claim(pm, 'T-001', 'wt-a', D, 'feat/x');
  claim(pm, 'T-002', 'wt-a', D); // detached HEAD: no branch
  assert.equal(readTask(pm, 'T-001').data.branch, 'feat/x');
  const plain = fs.readFileSync(path.join(pm, 'tasks', 'T-002.md'), 'utf8');
  assert.doesNotMatch(plain, /^(branch|commits|pr):/m, 'unset fields never appear in the file');
  assert.equal(readTask(pm, 'T-002').data.commits, undefined);
  setFields(pm, 'T-002', { commits: 'aaaaaaaaaaaa, bbbbbbbbbbbb' }, D);
  assert.deepEqual(readTask(pm, 'T-002').data.commits, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb']);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-002.md'), 'utf8'), /\ncommits: \[aaaaaaaaaaaa, bbbbbbbbbbbb\]\n/);
});
```

- [ ] **Step 3: Run both tests to verify they fail**

Run: `node --test test/board-store.test.mjs test/tasks.test.mjs`
Expected: FAIL — `autoWrite` is not exported (SyntaxError on import), and the tasks test fails on `data.branch` being `undefined`.

- [ ] **Step 4: Move the state helpers into store.mjs and add the automatic-write record**

In `scripts/lib/store.mjs`, insert after the `persist` function (before `export function initBoard`):

```js
const stateFile = (pm, name) => path.join(pm, '.state', `${String(name).replace(/[^\w.-]/g, '_')}.json`);

export function readState(pm, name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(pm, name), 'utf8'));
  } catch {
    return {};
  }
}

export function writeState(pm, name, value) {
  fs.mkdirSync(path.join(pm, '.state'), { recursive: true });
  fs.writeFileSync(stateFile(pm, name), JSON.stringify(value));
}

// The Stop nudge compares board-file mtimes. An automatic write (commit capture) records the mtime it replaced,
// so the nudge keeps seeing the last manual update. Restoring the old mtime instead would hide the change from
// git's index when the size is unchanged.
const AUTO_MTIME = 'auto-mtime';

export function autoWrite(pm, file, write) {
  const auto = readState(pm, AUTO_MTIME);
  const name = path.basename(file);
  const current = fs.statSync(file).mtimeMs;
  const before = auto[name]?.after === current ? auto[name].before : current;
  write();
  auto[name] = { before, after: fs.statSync(file).mtimeMs };
  writeState(pm, AUTO_MTIME, auto);
}

export function manualMtime(pm, file) {
  const mtime = fs.statSync(file).mtimeMs;
  const auto = readState(pm, AUTO_MTIME)[path.basename(file)];
  return auto?.after === mtime ? auto.before : mtime;
}
```

In `scripts/lib/hooks.mjs`, delete lines 23-34 (`const stateFile = …`, `function readState …`, `function writeState …`) and change the store import on line 5 to:

```js
import { hasBoard, commitPm, isSyncOn, persist, readState, writeState } from './store.mjs';
```

- [ ] **Step 5: Add the task fields**

In `scripts/lib/tasks.mjs`, line 8:

```js
const LIST_FIELDS = ['depends_on', 'worktrees', 'links', 'commits'];
```

In `readTaskFile`, after the `const data = { … };` literal and before `return`:

```js
  // Optional fields stay absent when unset, so files written before them never grow new lines.
  if (raw.commits !== undefined) data.commits = toArray(raw.commits);
```

Replace `claim` (lines 112-116):

```js
export function claim(pm, id, worktree, date, branch = '') {
  const task = readTask(pm, id);
  const worktrees = [...new Set([...task.data.worktrees, worktree])];
  return setFields(pm, id, { status: 'in_progress', worktrees, ...(branch && { branch }) }, date);
}
```

- [ ] **Step 6: Run the whole suite**

Run: `node --test`
Expected: PASS, 77 tests (75 existing + 2 new).

- [ ] **Step 7: Review checkpoint**

Run: `git diff --stat` and `git diff scripts/lib/store.mjs scripts/lib/hooks.mjs scripts/lib/tasks.mjs`
Show the diff to the author. Do not commit without an explicit OK; if approved, the message is
`refactor: state helpers in store, auto-write record, task branch and commits fields`.

---

### Task 2: Capture commits from the reflog and wire it into claim, set and hooks

**Files:**
- Create: `scripts/lib/gitlink.mjs`
- Modify: `scripts/pm.mjs:9` (imports), `:89-109` (`set`, `claim`)
- Modify: `scripts/lib/hooks.mjs` (imports, `lastBoardUpdate`, `onStop`, `onSafetyNote`)
- Test: `test/gitlink.test.mjs`

**Interfaces:**
- Consumes: `readState`, `writeState`, `autoWrite`, `manualMtime` from `store.mjs`; `claim(pm, id, worktree, date, branch)`, `readTask`, `writeTask`, `appendLogLine`, `listTasks` from `tasks.mjs` (Task 1)
- Produces (gitlink.mjs, used by T-030…T-032):
  - `currentBranch(cwd: string): string` — `''` on detached HEAD or outside git
  - `reflogSince(file: string, offset: number): { entries: { old: string, sha: string, subject: string }[], offset: number }`
  - `startCapture(pm: string, cwd: string): void` — cursor := end of this worktree's reflog
  - `captureCommits(pm: string, cwd: string, tasks?: Task[]): void` — never throws

- [ ] **Step 1: Write the failing tests**

Create `test/gitlink.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, addWorktree, tmp, sh, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';
import { readTask } from '../scripts/lib/tasks.mjs';
import { onStop, onSafetyNote } from '../scripts/lib/hooks.mjs';
import { reflogSince } from '../scripts/lib/gitlink.mjs';

const MIN = 60_000;

function commit(cwd, name, message = name) {
  fs.writeFileSync(path.join(cwd, name), `${name}\n`);
  sh(['add', '-A'], cwd);
  sh(['commit', '-q', '-m', message], cwd);
  return head(cwd);
}
const head = (cwd) => sh(['rev-parse', 'HEAD'], cwd).slice(0, 12);
const commitsOf = (root, id) => readTask(pmDir(root), id).data.commits ?? [];

function boardWithTask(root, ...titles) {
  cli(['init'], root);
  for (const title of titles.length ? titles : ['x']) cli(['task', 'new', '--title', title], root);
}

test('reflogSince reads complete lines only and restarts on a shrunken file', () => {
  const file = path.join(tmp(), 'HEAD');
  const line = (old, sha, subject) => `${old} ${sha} t <t@e> 1789410128 +0500\t${subject}\n`;
  const [z, a, b] = ['0', 'a', 'b'].map((c) => c.repeat(40));
  const whole = line(z, a, 'commit (initial): init') + line(a, b, 'commit (amend): two');
  fs.writeFileSync(file, `${whole}${b} ${'c'.repeat(40)} t <t@e> 17894`); // git is still writing the last line
  const first = reflogSince(file, 0);
  assert.deepEqual(first.entries, [
    { old: z, sha: a, subject: 'commit (initial): init' },
    { old: a, sha: b, subject: 'commit (amend): two' },
  ]);
  assert.equal(first.offset, Buffer.byteLength(whole));
  assert.deepEqual(reflogSince(file, first.offset).entries, []);
  assert.deepEqual(reflogSince(file, 5).entries.map((e) => e.subject), ['commit (amend): two'], 'a cut line is dropped, not misread');
  assert.deepEqual(reflogSince(file, 10_000), { entries: [], offset: fs.statSync(file).size });
  assert.deepEqual(reflogSince(path.join(tmp(), 'missing'), 50), { entries: [], offset: 0 });
});

test('claim records the branch; only commits after the claim are linked and committed with the board', () => {
  const { root } = setup();
  boardWithTask(root);
  commit(root, 'before.txt');
  cli(['claim', 'T-001'], root);
  const a = commit(root, 'a.txt');
  onStop({}, root);
  const t = readTask(pmDir(root), 'T-001');
  assert.equal(t.data.branch, 'main');
  assert.deepEqual(t.data.commits, [a]);
  assert.equal(sh(['status', '--porcelain'], pmDir(root)), '');
  assert.equal(sh(['log', '-1', '--format=%s'], pmDir(root)), 'pm: stop');
});

test('amend replaces the SHA, a repeated Stop adds nothing, and the same-size edit is still committed', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  commit(root, 'a.txt');
  onStop({}, root);
  sh(['commit', '-q', '--amend', '-m', 'a amended'], root);
  const amended = head(root);
  onStop({}, root);
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [amended]);
  const pm = pmDir(root);
  assert.equal(sh(['status', '--porcelain'], pm), '');
  assert.match(sh(['show', 'HEAD:tasks/T-001.md'], pm), new RegExp(`\\ncommits: \\[${amended}\\]\\n`));
});

test('fast-forward and merge commits and resets are skipped; cherry-pick and revert are linked', () => {
  const { root } = setup();
  const other = addWorktree(root, 'other');
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  commit(other, 'o1.txt');
  sh(['merge', '-q', '--ff-only', 'other'], root);
  commit(other, 'o2.txt');
  sh(['merge', '-q', '--no-ff', '-m', 'merge o2', 'other'], root);
  sh(['reset', '-q', '--hard', 'HEAD~1'], root);
  sh(['cherry-pick', 'other'], root);
  const picked = head(root);
  sh(['revert', '--no-edit', 'HEAD'], root);
  const reverted = head(root);
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [picked, reverted]);
});

test('each worktree links only its own commits, made with plain git between pm calls', () => {
  const { root } = setup();
  const b = addWorktree(root, 'b');
  boardWithTask(root, 'a', 'b');
  cli(['claim', 'T-001'], root);
  cli(['claim', 'T-002'], b);
  const inB = commit(b, 'b.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  onSafetyNote({ session_id: 's' }, b, 'session-end');
  assert.deepEqual(commitsOf(root, 'T-002'), [inB]);
  assert.equal(readTask(pmDir(root), 'T-002').data.branch, 'b');
});

test('two tasks in progress in one worktree: commits are logged as not attributed', () => {
  const { root } = setup();
  boardWithTask(root, 'a', 'b');
  cli(['claim', 'T-001'], root);
  cli(['claim', 'T-002'], root);
  const sha = commit(root, 'a.txt');
  onStop({}, root);
  for (const id of ['T-001', 'T-002']) {
    const t = readTask(pmDir(root), id);
    assert.equal(t.data.commits, undefined);
    assert.match(t.body, new RegExp(`auto: commits not attributed \\(2 tasks in progress\\): ${sha} — pm set T-NNN commits=`));
  }
});

test('commits made while the task is not in progress are never linked; a status change flushes the last ones', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  cli(['set', 'T-001', 'status=waiting', 'waiting_on=review'], root);
  commit(root, 'while-waiting.txt');
  cli(['set', 'T-001', 'status=in_progress'], root);
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  const last = commit(root, 'last.txt');
  cli(['set', 'T-001', 'status=done'], root);
  assert.deepEqual(commitsOf(root, 'T-001'), [last]);
});

test('a task claimed before capture existed starts its cursor without backfill', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  fs.rmSync(path.join(pmDir(root), '.state', `capture-${path.basename(root)}.json`));
  commit(root, 'unseen.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  const seen = commit(root, 'seen.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [seen]);
});

test('a missing reflog neither throws nor links; the cursor restarts', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  commit(root, 'a.txt');
  fs.rmSync(sh(['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'], root));
  commit(root, 'b.txt'); // git starts a new, shorter reflog
  assert.doesNotThrow(() => onStop({}, root));
  assert.deepEqual(commitsOf(root, 'T-001'), []);
  const c = commit(root, 'c.txt');
  onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [c]);
});

test('capture does not hide a stale board from the Stop nudge', () => {
  const { root } = setup();
  boardWithTask(root);
  cli(['claim', 'T-001'], root);
  const pm = pmDir(root);
  const past = new Date(Date.now() - 120 * MIN);
  for (const f of ['PLAN.md', 'decisions.md', path.join('tasks', 'T-001.md')]) fs.utimesSync(path.join(pm, f), past, past);
  const sha = commit(root, 'a.txt');
  const out = onStop({}, root);
  assert.deepEqual(commitsOf(root, 'T-001'), [sha], 'the commit was linked');
  assert.equal(JSON.parse(out).decision, 'block', 'and the nudge still fired');
});

test('tasks without a branch or commits keep their file shape', () => {
  const { root } = setup();
  boardWithTask(root, 'x', 'y');
  cli(['set', 'T-001', 'status=done'], root);
  sh(['checkout', '-q', '--detach'], root);
  cli(['claim', 'T-002'], root);
  onStop({}, root);
  for (const id of ['T-001', 'T-002']) {
    assert.doesNotMatch(fs.readFileSync(path.join(pmDir(root), 'tasks', `${id}.md`), 'utf8'), /^(branch|commits|pr):/m);
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `node --test test/gitlink.test.mjs`
Expected: FAIL — `Cannot find module '…/scripts/lib/gitlink.mjs'`.

- [ ] **Step 3: Create gitlink.mjs**

Create `scripts/lib/gitlink.mjs`:

```js
import fs from 'node:fs';
import { tryGit, worktreeName, today } from './paths.mjs';
import { readState, writeState, autoWrite } from './store.mjs';
import { listTasks, readTask, writeTask, appendLogLine } from './tasks.mjs';

// Reflog subjects of commits created in this worktree. Merges, pulls, resets, checkouts and rebases are skipped:
// they move HEAD to commits made — and captured — somewhere else.
const TAKEN = /^(commit|commit \(initial\)|commit \(amend\)|cherry-pick|revert): /;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // SHA-1 or SHA-256
const short = (sha) => sha.slice(0, 12);
const cursorName = (worktree) => `capture-${worktree}`;

export function currentBranch(cwd) {
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch && branch !== 'HEAD' ? branch : '';
}

// ponytail: reads the files-backend reflog; a reftable repository has no logs/HEAD and captures nothing.
function reflogFile(cwd) {
  return tryGit(['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'], cwd);
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Complete lines after byte `offset`: "<old> <new> <name> <email> <time> <tz>\t<subject>" (git update-ref).
// A file shorter than the offset (expired reflog) yields nothing and restarts the cursor at its size.
// ponytail: a reflog rewritten by gc that grew past the offset again is read from a cut line; that line fails
// the OID check and is dropped. Store the last consumed line in the cursor if this ever loses real commits.
export function reflogSince(file, offset) {
  const size = sizeOf(file);
  if (size <= offset) return { entries: [], offset: size };
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a) + 1; // a line git is still writing waits for the next capture
  const entries = buf.subarray(0, end).toString('utf8').split('\n').map((line) => {
    const [old = '', sha = ''] = line.split(' ', 2);
    const tab = line.indexOf('\t');
    return { old, sha, subject: tab === -1 ? '' : line.slice(tab + 1) };
  }).filter((e) => OID.test(e.old) && OID.test(e.sha));
  return { entries, offset: offset + end };
}

export function startCapture(pm, cwd) {
  const worktree = worktreeName(cwd);
  const file = worktree && reflogFile(cwd);
  if (file) writeState(pm, cursorName(worktree), { offset: sizeOf(file) });
}

// Links commits created in this worktree since the last capture to its one task in progress.
// Never throws: a failed capture only means nothing was linked this time.
export function captureCommits(pm, cwd, tasks) {
  try {
    const worktree = worktreeName(cwd);
    const open = (tasks ?? listTasks(pm)).filter((t) => t.data.status === 'in_progress' && t.data.worktrees.includes(worktree));
    if (!open.length) return;
    const file = reflogFile(cwd);
    if (!file) return;
    const cursor = readState(pm, cursorName(worktree));
    if (typeof cursor.offset !== 'number') {
      startCapture(pm, cwd); // claimed before capture existed: start now, no backfill
      return;
    }
    const { entries, offset } = reflogSince(file, cursor.offset);
    writeState(pm, cursorName(worktree), { offset });
    const taken = entries.filter((e) => TAKEN.test(e.subject));
    if (!taken.length) return;
    if (open.length > 1) {
      const shas = taken.map((e) => short(e.sha)).join(', ');
      const line = `- ${today()} · ${worktree} · auto: commits not attributed (${open.length} tasks in progress): ${shas} — pm set T-NNN commits=…`;
      for (const t of open) autoWrite(pm, t.file, () => appendLogLine(pm, t.id, line, today()));
      return;
    }
    const task = readTask(pm, open[0].id); // fresh read: the caller's list may predate edits made this turn
    const before = task.data.commits ?? [];
    const commits = [...before];
    for (const e of taken) {
      const amended = e.subject.startsWith('commit (amend)') ? commits.indexOf(short(e.old)) : -1;
      if (amended !== -1) commits.splice(amended, 1);
      if (!commits.includes(short(e.sha))) commits.push(short(e.sha));
    }
    if (commits.join() === before.join()) return;
    task.data.commits = commits;
    autoWrite(pm, task.file, () => writeTask(task));
  } catch (e) {
    if (process.env.PM_DEBUG) console.error(e);
  }
}
```

- [ ] **Step 4: Wire the CLI**

In `scripts/pm.mjs`, add after the tasks import (line 9):

```js
import { captureCommits, startCapture, currentBranch } from './lib/gitlink.mjs';
```

In `set`, replace the two lines `const pm = requireBoard(cwd);` / `setFields(pm, id, fields, today());` with:

```js
    const pm = requireBoard(cwd);
    const statusChange = 'status' in fields;
    if (statusChange) captureCommits(pm, cwd); // the last commits land while the task is still in progress
    setFields(pm, id, fields, today());
    if (statusChange) startCapture(pm, cwd); // commits made in another status are never linked later
```

Replace the body of `claim` after `const wt = worktreeName(cwd);` so it reads:

```js
  claim(cwd, [id]) {
    if (!id) fail('usage: pm claim <id>');
    const pm = requireBoard(cwd);
    const wt = worktreeName(cwd);
    captureCommits(pm, cwd); // commits so far belong to the tasks already in progress here
    claim(pm, id, wt, today(), currentBranch(cwd));
    startCapture(pm, cwd);
    persist(pm, `pm: claim ${id}`);
    return `${id} claimed by ${wt}`;
  },
```

- [ ] **Step 5: Wire the hooks**

In `scripts/lib/hooks.mjs`:

Imports — the store line becomes, and a gitlink import is added:

```js
import { hasBoard, commitPm, isSyncOn, persist, readState, writeState, manualMtime } from './store.mjs';
import { captureCommits } from './gitlink.mjs';
```

In `lastBoardUpdate`, replace the return line with:

```js
  return Math.max(0, ...files.filter((f) => fs.existsSync(f)).map((f) => manualMtime(pm, f)));
```

In `onStop`, replace `const tasks = listTasks(pm);` with:

```js
  const tasks = listTasks(pm);
  captureCommits(pm, cwd, tasks); // before the commit below, so linked commits land in "pm: stop"
```

In `onSafetyNote`, right after `if (!pm || !hasBoard(cwd)) return '';` add:

```js
  captureCommits(pm, cwd);
```

- [ ] **Step 6: Run the new tests**

Run: `node --test test/gitlink.test.mjs`
Expected: PASS, 11 tests.

- [ ] **Step 7: Run the whole suite**

Run: `node --test`
Expected: PASS, 88 tests (77 after Task 1 + 11).

- [ ] **Step 8: Try it on this repository's live board**

The installed runtime (0.2.1) is not updated by this plan and keeps unknown frontmatter fields on its own writes
(`readTaskFile` spreads the raw frontmatter), so the live board is safe to use. Run the checkout's CLI from this
worktree:

```bash
node scripts/pm.mjs claim T-029
```

Expected: T-029 gains `branch: ZizzX/git` and a cursor file `.state/capture-anhinga.json` appears in the board.
After the next commit in this worktree (the author-approved Task 1 commit), run `node scripts/pm.mjs claim T-029`
again: `commits:` in `tasks/T-029.md` lists that commit's 12-char SHA. Report what was seen.

- [ ] **Step 9: Review checkpoint**

Run: `git diff --stat` and `git diff`
Show the diff to the author. Do not commit without an explicit OK; if approved, the message is
`feat: link commits to the task in progress via the worktree reflog`.

---

## After both tasks (board, main agent only)

- `pm log T-029 --did "…" --next "…"`; checklist in T-029 closed only after the author approved both diffs.
- Leftovers found during implementation → `pm task new … --epic git --deps T-029`.
- `pm set T-029 status=done` only after the author's OK and a green `node --test`.
