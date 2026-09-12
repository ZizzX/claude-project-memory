# project-memory (`/pm`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin that gives every git repo a persistent plan, task board, decision log and session handoff, shared by all worktrees on a machine, local by default, with opt-in sync across machines.

**Architecture:** A zero-dependency Node CLI (`scripts/pm.mjs` + `scripts/lib/*.mjs`) owns all deterministic work on a small git repo at `<claude-home>/projects/<repo-key>/pm/`. Plugin hooks call the CLI (`pm hook <event>`) to inject a session summary, nudge after plan edits, guard against a stale board, and write automatic safety notes. A `/pm` skill describes the protocol the agent follows.

**Tech Stack:** Node ≥ 20 (ESM `.mjs`, standard library only), git, `node:test`, Claude Code plugin format (`.claude-plugin/`, `hooks/hooks.json`, `skills/`), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-12-project-memory-design.md`

## Global Constraints

- Node ≥ 20, standard library only — no npm dependencies, no `package.json` needed.
- Works on Windows, macOS and Linux: git is invoked via `child_process.execFileSync('git', …)`, never through a shell; paths via `node:path`.
- Every hook exits 0 on every path, including internal errors: the plugin must never break a session.
- Local by default: no command pushes, fetches or clones unless the user ran `pm sync on --yes` for that project.
- Session summary: hard limit 40 lines (`MAX_LINES = 40`), rules digest always present.
- `STALE_MINUTES = 20` is the single Stop-guard knob.
- Board location: `<claude-home>/projects/<repo-key>/pm/`; `<claude-home>` = `$CLAUDE_CONFIG_DIR` or `~/.claude`; `<repo-key>` = main worktree root with every char outside `[A-Za-z0-9]` replaced by `-`.
- Task files are `tasks/T-NNN.md` (3-digit minimum); decisions are `D-NNN`; statuses are exactly `todo | in_progress | waiting | done | dropped`.
- Code, comments, docs and commit messages in English.
- Tests: `node:test` + `node:assert/strict`, run with `node --test` from the repo root.
- Every commit message ends with this trailer block (a separate paragraph):
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_017pEuy7j9YZbW23BybgJKAH
  ```
  Commit steps below show only the subject line; always append the trailers, e.g.
  `git commit -m "feat: x" -m "Co-Authored-By: … " ` with both trailer lines in the second `-m`.

## File Structure

| File | Responsibility |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.claude-plugin/marketplace.json` | This repo as a one-plugin marketplace |
| `.gitattributes` | LF line endings for the plugin repo |
| `hooks/hooks.json` | Five hooks → `node "${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs" hook <event>` |
| `skills/pm/SKILL.md` | Agent protocol |
| `scripts/pm.mjs` | CLI + hook entry point (argument parsing, dispatch, error → exit code) |
| `scripts/lib/paths.mjs` | git helpers, claude home, repo key, pm/memory dir, worktree name, today |
| `scripts/lib/frontmatter.mjs` | Restricted frontmatter parse/serialize |
| `scripts/lib/tasks.mjs` | Task files: create (atomic id), read, list, set, claim, log, ready queue, validate |
| `scripts/lib/decisions.mjs` | Append-only decision log |
| `scripts/lib/plan.mjs` | `PLAN.md` template, project name, current focus |
| `scripts/lib/board.mjs` | Columns, `BOARD.md`, `board.html` |
| `scripts/lib/store.mjs` | Board repo: init, commit, persist, sync-on check, background push |
| `scripts/lib/summary.mjs` | Session summary text |
| `scripts/lib/scan.mjs` | Find plan files from other tools |
| `scripts/lib/sync.mjs` | Sync on/off, pull, push, conflicts, shared-board hint, memory link |
| `scripts/lib/hooks.mjs` | Hook handlers |
| `test/helpers.mjs` | Temp repos, CLI runner, git identity for tests |
| `test/*.test.mjs` | One suite per module |
| `.github/workflows/test.yml` | CI matrix |
| `README.md`, `LICENSE` | Public release |
| `docs/spike-findings.md` | Results of Task 1 |

---

### Task 1: Plugin skeleton and platform spike

Proves the riskiest assumptions before any real code. Not TDD: the deliverable is a working plugin skeleton plus recorded findings.

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.gitattributes`, `hooks/hooks.json`, `scripts/pm.mjs` (spike version, replaced in Task 9), `docs/spike-findings.md`

**Interfaces:**
- Produces: the hook command form used by Task 13 (`node "${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs" hook <event>` unless the spike proves otherwise) and the PostToolUse output form used by Task 13.

- [ ] **Step 1: Create the manifests**

`.claude-plugin/plugin.json`:
```json
{
  "name": "project-memory",
  "version": "0.1.0",
  "description": "Per-project plan, task board, decision log and session handoff for Claude Code. Local by default, optional sync across machines.",
  "author": { "name": "ZizzX" },
  "repository": "https://github.com/ZizzX/claude-project-memory",
  "license": "MIT",
  "keywords": ["memory", "tasks", "kanban", "handoff", "planning"]
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "project-memory",
  "owner": { "name": "ZizzX" },
  "plugins": [
    {
      "name": "project-memory",
      "source": "./",
      "description": "Per-project plan, task board, decision log and session handoff for Claude Code."
    }
  ]
}
```

`.gitattributes`:
```
* text=auto eol=lf
```

- [ ] **Step 2: Create the spike hooks and script**

`hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook session-start", "timeout": 15 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|ExitPlanMode",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook post-tool-use", "timeout": 10 }]
      }
    ]
  }
}
```

`scripts/pm.mjs`:
```js
#!/usr/bin/env node
// Spike version: proves plugin hooks can run this script. Replaced in Task 9.
import fs from 'node:fs';

const [cmd, event] = process.argv.slice(2);
if (cmd === 'hook') {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    // no stdin
  }
  if (event === 'session-start') {
    process.stdout.write(`[pm] spike ok on ${process.platform}\n`);
  } else if (event === 'post-tool-use') {
    const file = String(input.tool_input?.file_path ?? '');
    const additionalContext = `[pm] plan updated: ${file}`;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } })}\n`);
  }
}
process.exit(0);
```

- [ ] **Step 3: Spike A — does a plugin SessionStart hook run on this OS?**

Run (bash; on Windows use Git Bash), with `PLUGIN` set to the absolute path of this repo:
```bash
PLUGIN="$(git rev-parse --show-toplevel)"
SPIKE="$(mktemp -d)" && cd "$SPIKE" && git init -q && git commit -q --allow-empty -m init
claude -p 'Print verbatim every line in your context that starts with "[pm]". If there is none, print NONE.' --plugin-dir "$PLUGIN"
```
Expected: a line `[pm] spike ok on win32` (or `darwin`/`linux`).
If `NONE`: retry with `--debug` to see the hook error, then try these command forms in `hooks/hooks.json` one at a time until one works: `node ${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs hook session-start` (unquoted), `node "$CLAUDE_PLUGIN_ROOT/scripts/pm.mjs" hook session-start`. Record the working form. If none works, STOP and report to the owner.

- [ ] **Step 4: Spike B — does PostToolUse `additionalContext` reach the model?**

```bash
cd "$SPIKE"
claude -p 'Create the file docs/superpowers/plans/spike.md containing "# spike". Then print verbatim every line you received that starts with "[pm] plan updated". If none, print NONE.' --plugin-dir "$PLUGIN" --allowedTools Write
```
Expected: `[pm] plan updated: …spike.md`.
If `NONE`: change the post-tool-use branch of the spike script to print `JSON.stringify({ decision: 'block', reason: additionalContext })`, rerun, and record which form works (Task 13 must emit that form).

- [ ] **Step 5: Spike C — does our repo key match Claude Code's folder name (including non-ASCII)?**

```bash
KEYDIR="$(mktemp -d)/проект spike" && mkdir -p "$KEYDIR" && cd "$KEYDIR" && git init -q && git commit -q --allow-empty -m init
claude -p 'Reply OK'
node -e "
const cp=require('child_process'),path=require('path'),os=require('os'),fs=require('fs');
const common=cp.execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim();
const key=path.resolve(path.dirname(common)).replace(/[^A-Za-z0-9]/g,'-');
const dir=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'projects',key);
console.log(key, fs.existsSync(dir)?'MATCH':'NO MATCH');"
```
Expected: `MATCH`. If `NO MATCH`: list `~/.claude/projects` entries containing `spike`, record the actual naming rule, and STOP — report to the owner (Tasks 2 and 12 must change). On macOS, a temp dir under `/var` may resolve to `/private/var`; if that is the only difference, repeat in a folder under `~` before concluding.

- [ ] **Step 6: Spike D — does Claude Code read and write auto-memory through a junction/symlink?**

```bash
MEMDIR="$(mktemp -d)" && cd "$MEMDIR" && git init -q && git commit -q --allow-empty -m init
node -e "
const cp=require('child_process'),path=require('path'),os=require('os'),fs=require('fs');
const root=path.resolve(path.dirname(cp.execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim()));
const proj=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(os.homedir(),'.claude'),'projects',root.replace(/[^A-Za-z0-9]/g,'-'));
const target=fs.mkdtempSync(path.join(os.tmpdir(),'pm-mem-'));
fs.writeFileSync(path.join(target,'MEMORY.md'),'- The spike codeword is PLUM-42\n');
fs.mkdirSync(proj,{recursive:true});
fs.symlinkSync(target,path.join(proj,'memory'),'junction');
console.log('project folder:',proj,'target:',target);"
claude -p 'What is the spike codeword stored in your memory? Reply with just the codeword, or NONE.'
claude -p 'Save to your auto-memory: the spike color is TEAL.' --allowedTools Write Edit
```
Then check the printed target folder: `grep -ri TEAL "<target>"`.
Expected: first answer `PLUM-42`; the target folder contains a file mentioning `TEAL`.
If either fails: STOP and report to the owner — Task 12 switches to the `autoMemoryDirectory` setting.
Clean up: delete the printed project folder with `node -e "require('fs').rmSync('<project folder>',{recursive:true,force:true})"` (removes the link, not the target) and the temp dirs.

- [ ] **Step 7: Spike E — does Claude Code cleanup touch unknown folders under `projects/`?**

Fetch `https://code.claude.com/docs/en/settings` and read what `cleanupPeriodDays` deletes. Expected: only session transcripts/tasks. If the docs say whole project folders can be removed, record it: Task 2's `projectDir` must then return `<claude-home>/pm/<repo-key>` for the board (memory linking unchanged) — report to the owner before continuing.

- [ ] **Step 8: Record findings**

Create `docs/spike-findings.md`:
```markdown
# Spike findings (Task 1)

Date: <YYYY-MM-DD> · OS: <win32|darwin|linux> · Claude Code: <`claude --version`>

| Question | Result | Consequence |
|---|---|---|
| A. Plugin SessionStart hook runs `node` with `${CLAUDE_PLUGIN_ROOT}` | <works with form …> | Task 13 uses this command form |
| B. PostToolUse `additionalContext` reaches the model | <yes / no, `decision: block` works> | Task 13 output form |
| C. Repo key matches Claude Code's folder name (non-ASCII too) | <MATCH / rule …> | Task 2 unchanged / changed |
| D. Auto-memory read + write through a junction/symlink | <yes / no> | Task 12 link / `autoMemoryDirectory` |
| E. `cleanupPeriodDays` scope | <transcripts only / …> | board location unchanged / changed |
```
Fill every `<…>` with the actual observation.

- [ ] **Step 9: Commit**

```bash
git add .claude-plugin .gitattributes hooks scripts/pm.mjs docs/spike-findings.md
git commit -m "chore: plugin skeleton and platform spike findings"
```

---

### Task 2: Paths and test helpers

**Files:**
- Create: `scripts/lib/paths.mjs`, `test/helpers.mjs`, `test/paths.test.mjs`

**Interfaces:**
- Produces:
  - `git(args: string[], cwd: string, opts?: object): string` — stdout with trailing whitespace trimmed; throws on non-zero exit.
  - `tryGit(args, cwd, opts?): string | null` — like `git`, `null` on failure.
  - `claudeHome(): string`, `repoKey(absPath: string): string`, `mainRoot(cwd): string | null`, `worktreeName(cwd): string | null`, `projectDir(cwd): string | null`, `pmDir(cwd): string | null`, `memoryDir(cwd): string | null`, `today(): string` (`YYYY-MM-DD`, local time).
  - test helpers: `PM` (abs path of `scripts/pm.mjs`), `tmp(prefix?)`, `sh(args, cwd)`, `setup(): { home, root }` (fresh `CLAUDE_CONFIG_DIR` + repo on branch `main` with one commit), `addWorktree(root, name): string`, `cli(args, cwd, { input?, env? }?): { code, out, err }`, `pmOf(home, root): string`.

- [ ] **Step 1: Write the test helpers**

`test/helpers.mjs`:
```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pmDir } from '../scripts/lib/paths.mjs';

export const PM = fileURLToPath(new URL('../scripts/pm.mjs', import.meta.url));

// Hermetic git identity; background pushes off so temp dirs are never touched after a test.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  PM_NO_BACKGROUND: '1',
});

export function tmp(prefix = 'pm-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A fresh CLAUDE_CONFIG_DIR plus a git repo with one commit on branch main.
export function setup() {
  const home = tmp('pm-home-');
  process.env.CLAUDE_CONFIG_DIR = home;
  const root = tmp('pm-repo-');
  sh(['init', '-q', '-b', 'main'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return { home, root };
}

export function addWorktree(root, name) {
  const dir = path.join(path.dirname(root), `${path.basename(root)}-${name}`);
  sh(['worktree', 'add', '-q', '-b', name, dir], root);
  return fs.realpathSync(dir);
}

export function cli(args, cwd, { input, env } = {}) {
  const r = spawnSync(process.execPath, [PM, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// pm dir of `root` as seen by a machine whose claude home is `home`.
export function pmOf(home, root) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    return pmDir(root);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
  }
}
```

- [ ] **Step 2: Write the failing tests**

`test/paths.test.mjs`:
```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test test/paths.test.mjs`
Expected: FAIL — `Cannot find module '…/scripts/lib/paths.mjs'`.

- [ ] **Step 4: Implement**

`scripts/lib/paths.mjs`:
```js
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function git(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  }).trimEnd();
}

export function tryGit(args, cwd, opts = {}) {
  try {
    return git(args, cwd, opts);
  } catch {
    return null;
  }
}

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Same rule Claude Code uses to name folders under <claude-home>/projects.
export function repoKey(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

// Root of the main worktree; identical for every linked worktree of the repo.
export function mainRoot(cwd) {
  const common = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return common ? path.resolve(path.dirname(common)) : null;
}

export function worktreeName(cwd) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  return top ? path.basename(top) : null;
}

export function projectDir(cwd) {
  const root = mainRoot(cwd);
  return root ? path.join(claudeHome(), 'projects', repoKey(root)) : null;
}

export function pmDir(cwd) {
  const dir = projectDir(cwd);
  return dir ? path.join(dir, 'pm') : null;
}

export function memoryDir(cwd) {
  const dir = projectDir(cwd);
  return dir ? path.join(dir, 'memory') : null;
}

export function today() {
  return new Date().toLocaleDateString('sv-SE');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/paths.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/paths.mjs test/helpers.mjs test/paths.test.mjs
git commit -m "feat: resolve board and memory folders per repo"
```

---

### Task 3: Frontmatter

**Files:**
- Create: `scripts/lib/frontmatter.mjs`, `test/frontmatter.test.mjs`

**Interfaces:**
- Produces: `parse(text: string): { data: Record<string, string | string[]>, body: string }`, `serialize(data: Record<string, unknown>, body: string): string`. Arrays are `[a, b]`; empty string is `""`; values containing `:` or `#`, starting with whitespace, `[` or `"`, or ending with whitespace are JSON-quoted.

- [ ] **Step 1: Write the failing tests**

`test/frontmatter.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../scripts/lib/frontmatter.mjs';

test('parse and serialize round-trip', () => {
  const text = '---\nid: T-001\ntitle: "Fix: login"\ndepends_on: [T-002, T-003]\nwaiting_on: ""\norder: 2\n---\n## Goal\n';
  const { data, body } = parse(text);
  assert.deepEqual(data, { id: 'T-001', title: 'Fix: login', depends_on: ['T-002', 'T-003'], waiting_on: '', order: '2' });
  assert.equal(body, '## Goal\n');
  assert.equal(serialize(data, body), text);
});

test('CRLF input is normalized and empty lists parse as []', () => {
  const { data, body } = parse('---\r\nlinks: []\r\ntitle: x\r\n---\r\nbody\r\n');
  assert.deepEqual(data, { links: [], title: 'x' });
  assert.equal(body, 'body\n');
});

test('text without frontmatter is all body', () => {
  assert.deepEqual(parse('# hi\n'), { data: {}, body: '# hi\n' });
});

test('values that would be misread are quoted', () => {
  assert.equal(serialize({ a: '[not a list]', b: ' lead', c: 'ok' }, ''), '---\na: "[not a list]"\nb: " lead"\nc: ok\n---\n');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/frontmatter.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/frontmatter.mjs`:
```js
// Restricted frontmatter: `key: value`, `key: [a, b]`, `key: ""`. Nothing else.

export function parse(text) {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---\n', 3);
  if (end === -1) return { data: {}, body: src };
  const data = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) data[m[1]] = parseValue(m[2].trim());
  }
  return { data, body: src.slice(end + 5) };
}

function parseValue(v) {
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

export function serialize(data, body) {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function formatValue(v) {
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  const s = String(v);
  return s === '' || /^[\s["]|[:#]|\s$/.test(s) ? JSON.stringify(s) : s;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/frontmatter.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/frontmatter.mjs test/frontmatter.test.mjs
git commit -m "feat: restricted frontmatter parser"
```

---

### Task 4: Task files — create, read, update, claim, log

**Files:**
- Create: `scripts/lib/tasks.mjs`, `test/tasks.test.mjs`

**Interfaces:**
- Consumes: `parse`, `serialize` from `frontmatter.mjs`.
- Produces (task object = `{ file: string, id: string, data: object, body: string }`; `data.order` is a number; `depends_on`, `worktrees`, `links` are arrays; `waiting_on`, `milestone` are strings):
  - `STATUSES: string[]`, `tasksDir(pm): string`
  - `listTasks(pm): Task[]` — sorted by `order`, then id
  - `readTask(pm, id): Task` — throws `unknown task <id>`
  - `writeTask(task): void`
  - `newTask(pm, { title, order?, deps?, milestone?, links?, date }): Task`
  - `setFields(pm, id, fields: Record<string, string | string[]>, date): Task`
  - `claim(pm, id, worktree, date): Task`
  - `appendLogLine(pm, id, line, date): Task`, `appendLog(pm, id, { worktree, did, next, date }): Task`
  - `lastNext(task): { date, who, next } | null`

- [ ] **Step 1: Write the failing tests**

`test/tasks.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp } from './helpers.mjs';
import { newTask, listTasks, readTask, setFields, claim, appendLog, appendLogLine, lastNext } from '../scripts/lib/tasks.mjs';

const D = '2026-09-12';

test('newTask creates sequential ids from the template', () => {
  const pm = tmp();
  assert.equal(newTask(pm, { title: 'First', date: D }).id, 'T-001');
  assert.equal(newTask(pm, { title: 'Second: with colon', deps: ['T-001'], date: D }).id, 'T-002');
  assert.ok(fs.existsSync(path.join(pm, 'tasks', 'T-002.md')));
  const t = readTask(pm, 'T-002');
  assert.equal(t.data.title, 'Second: with colon');
  assert.equal(t.data.status, 'todo');
  assert.equal(t.data.order, 2);
  assert.deepEqual(t.data.depends_on, ['T-001']);
  assert.equal(t.data.updated, D);
  assert.match(t.body, /^## Goal\n\n## Understanding\n\n## Checklist\n\n## Log\n$/);
  assert.deepEqual(listTasks(pm).map((x) => x.id), ['T-001', 'T-002']);
});

test('newTask skips ids that already exist', () => {
  const pm = tmp();
  fs.mkdirSync(path.join(pm, 'tasks'));
  fs.writeFileSync(path.join(pm, 'tasks', 'T-005.md'), '---\nid: T-005\ntitle: x\nstatus: todo\norder: 5\n---\n');
  assert.equal(newTask(pm, { title: 'next', date: D }).id, 'T-006');
});

test('setFields validates and normalizes', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  assert.throws(() => setFields(pm, 'T-001', { status: 'doing' }, D), /bad status/);
  assert.throws(() => setFields(pm, 'T-001', { status: 'waiting' }, D), /waiting_on/);
  assert.throws(() => setFields(pm, 'T-001', { order: 'abc' }, D), /order/);
  assert.throws(() => setFields(pm, 'T-001', { id: 'T-002' }, D), /id cannot/);
  assert.throws(() => readTask(pm, 'T-404'), /unknown task T-404/);
  const t = setFields(pm, 'T-001', { status: 'waiting', waiting_on: 'answer about dates', depends_on: 'T-009, T-010', order: '7' }, '2026-09-13');
  assert.deepEqual(t.data.depends_on, ['T-009', 'T-010']);
  assert.equal(t.data.order, 7);
  assert.equal(t.data.updated, '2026-09-13');
  assert.equal(setFields(pm, 'T-001', { status: 'todo' }, D).data.waiting_on, '');
});

test('claim adds the worktree once and starts the task', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  claim(pm, 'T-001', 'wt-a', D);
  const t = claim(pm, 'T-001', 'wt-a', D);
  claim(pm, 'T-001', 'wt-b', D);
  assert.equal(t.data.status, 'in_progress');
  assert.deepEqual(readTask(pm, 'T-001').data.worktrees, ['wt-a', 'wt-b']);
});

test('appendLog adds signed entries and lastNext reads the latest model entry', () => {
  const pm = tmp();
  newTask(pm, { title: 'x', date: D });
  assert.equal(lastNext(readTask(pm, 'T-001')), null);
  appendLog(pm, 'T-001', { worktree: 'wt-a', did: 'parser', next: 'empty rows', date: D });
  appendLogLine(pm, 'T-001', '- 2026-09-13 · wt-a · auto: changed files: a.js · last commit: abc x', '2026-09-13');
  appendLog(pm, 'T-001', { worktree: 'wt-b', did: 'tests', next: 'handle BOM · then docs', date: '2026-09-14' });
  const t = readTask(pm, 'T-001');
  assert.match(t.body, /## Log\n- 2026-09-12 · wt-a · did: parser · next: empty rows\n- 2026-09-13 · wt-a · auto:/);
  assert.deepEqual(lastNext(t), { date: '2026-09-14', who: 'wt-b', next: 'handle BOM · then docs' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/tasks.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/tasks.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { parse, serialize } from './frontmatter.mjs';

export const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'dropped'];
const ID_RE = /^T-(\d+)\.md$/;
const TEMPLATE_BODY = '## Goal\n\n## Understanding\n\n## Checklist\n\n## Log\n';
const LIST_FIELDS = ['depends_on', 'worktrees', 'links'];

export const tasksDir = (pm) => path.join(pm, 'tasks');
const idOf = (n) => `T-${String(n).padStart(3, '0')}`;
const toArray = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function readTaskFile(file) {
  const { data: raw, body } = parse(fs.readFileSync(file, 'utf8'));
  const data = {
    ...raw,
    order: Number(raw.order ?? 0),
    depends_on: toArray(raw.depends_on),
    worktrees: toArray(raw.worktrees),
    links: toArray(raw.links),
    waiting_on: raw.waiting_on ?? '',
    milestone: raw.milestone ?? '',
  };
  return { file, id: path.basename(file, '.md'), data, body };
}

export function listTasks(pm) {
  const dir = tasksDir(pm);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => ID_RE.test(f))
    .map((f) => readTaskFile(path.join(dir, f)))
    .sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
}

export function readTask(pm, id) {
  const file = path.join(tasksDir(pm), `${id}.md`);
  if (!fs.existsSync(file)) throw new Error(`unknown task ${id}`);
  return readTaskFile(file);
}

export function writeTask(task) {
  fs.writeFileSync(task.file, serialize(task.data, task.body));
}

// The id is reserved by creating T-NNN.md exclusively, so concurrent processes never share an id.
export function newTask(pm, { title, order, deps = [], milestone = '', links = [], date }) {
  const dir = tasksDir(pm);
  fs.mkdirSync(dir, { recursive: true });
  let n = Math.max(0, ...fs.readdirSync(dir).map((f) => Number(f.match(ID_RE)?.[1] ?? 0))) + 1;
  for (;;) {
    const id = idOf(n);
    const file = path.join(dir, `${id}.md`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      n += 1;
      continue;
    }
    const data = {
      id,
      title,
      status: 'todo',
      order: order ?? n,
      depends_on: deps,
      waiting_on: '',
      worktrees: [],
      milestone,
      links,
      updated: date,
    };
    fs.writeSync(fd, serialize(data, TEMPLATE_BODY));
    fs.closeSync(fd);
    return { file, id, data, body: TEMPLATE_BODY };
  }
}

export function setFields(pm, id, fields, date) {
  const task = readTask(pm, id);
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id') throw new Error('id cannot be changed');
    if (k === 'status' && !STATUSES.includes(v)) throw new Error(`bad status "${v}"; use ${STATUSES.join(' | ')}`);
    if (k === 'order') {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error(`order must be a number, got "${v}"`);
      task.data.order = n;
    } else if (LIST_FIELDS.includes(k)) {
      task.data[k] = toArray(v);
    } else {
      task.data[k] = v;
    }
  }
  if ('status' in fields && fields.status !== 'waiting' && !('waiting_on' in fields)) task.data.waiting_on = '';
  if (task.data.status === 'waiting' && !task.data.waiting_on) {
    throw new Error('status waiting needs waiting_on="<what we are waiting for>"');
  }
  task.data.updated = date;
  writeTask(task);
  return task;
}

export function claim(pm, id, worktree, date) {
  const task = readTask(pm, id);
  const worktrees = [...new Set([...task.data.worktrees, worktree])];
  return setFields(pm, id, { status: 'in_progress', worktrees }, date);
}

// Log is the last section of a task file, so entries are appended at the end of the body.
export function appendLogLine(pm, id, line, date) {
  const task = readTask(pm, id);
  task.body = `${task.body.replace(/\n*$/, '\n')}${line}\n`;
  task.data.updated = date;
  writeTask(task);
  return task;
}

export function appendLog(pm, id, { worktree, did, next, date }) {
  return appendLogLine(pm, id, `- ${date} · ${worktree} · did: ${did} · next: ${next}`, date);
}

export function lastNext(task) {
  const last = task.body.split('\n').filter((l) => l.includes(' · next: ')).at(-1);
  if (!last) return null;
  const [date, who] = last.replace(/^- /, '').split(' · ');
  return { date, who, next: last.slice(last.indexOf(' · next: ') + ' · next: '.length) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/tasks.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/tasks.mjs test/tasks.test.mjs
git commit -m "feat: task files with atomic ids, fields, claim and log"
```

---

### Task 5: Ready queue and validation

**Files:**
- Modify: `scripts/lib/tasks.mjs` (append two exports)
- Create: `test/queue.test.mjs`

**Interfaces:**
- Produces: `readyQueue(tasks: Task[]): Task[]` — `todo` tasks whose every dependency exists and is `done` or `dropped`, sorted by order then id; `validate(tasks: Task[]): string[]` — messages in exactly these formats: `T-003: depends on unknown T-404`, `T-004: waiting without waiting_on`, `T-005: bad status "doing"`, `T-007: depends on dropped T-006`, `T-008: frontmatter id is T-009`, `cycle: T-001 -> T-002 -> T-001`.

- [ ] **Step 1: Write the failing tests**

`test/queue.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readyQueue, validate } from '../scripts/lib/tasks.mjs';

function mk(id, data = {}) {
  return {
    id,
    file: `${id}.md`,
    body: '',
    data: { id, title: id, status: 'todo', order: Number(id.slice(2)), depends_on: [], worktrees: [], links: [], waiting_on: '', milestone: '', ...data },
  };
}

test('ready = todo whose deps are done or dropped, in order', () => {
  const tasks = [
    mk('T-001', { status: 'done' }),
    mk('T-002', { status: 'dropped' }),
    mk('T-003', { depends_on: ['T-001', 'T-002'], order: 9 }),
    mk('T-004', { depends_on: ['T-005'] }),
    mk('T-005', { status: 'in_progress' }),
    mk('T-006', { status: 'waiting', waiting_on: 'x' }),
    mk('T-007', { order: 1 }),
    mk('T-008', { depends_on: ['T-404'] }),
  ];
  assert.deepEqual(readyQueue(tasks).map((t) => t.id), ['T-007', 'T-003']);
});

test('validate reports every kind of problem', () => {
  const bad = mk('T-008');
  bad.data.id = 'T-009';
  const problems = validate([
    mk('T-001', { depends_on: ['T-002'] }),
    mk('T-002', { depends_on: ['T-001'] }),
    mk('T-003', { depends_on: ['T-404'] }),
    mk('T-004', { status: 'waiting' }),
    mk('T-005', { status: 'doing' }),
    mk('T-006', { status: 'dropped' }),
    mk('T-007', { depends_on: ['T-006'] }),
    bad,
  ]);
  assert.deepEqual(problems.sort(), [
    'T-003: depends on unknown T-404',
    'T-004: waiting without waiting_on',
    'T-005: bad status "doing"',
    'T-007: depends on dropped T-006',
    'T-008: frontmatter id is T-009',
    'cycle: T-001 -> T-002 -> T-001',
  ].sort());
});

test('a healthy board has no problems', () => {
  assert.deepEqual(validate([mk('T-001'), mk('T-002', { depends_on: ['T-001'] })]), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/queue.test.mjs`
Expected: FAIL — `readyQueue` is not exported.

- [ ] **Step 3: Implement** — append to `scripts/lib/tasks.mjs`:

```js
export function readyQueue(tasks) {
  const status = new Map(tasks.map((t) => [t.id, t.data.status]));
  return tasks
    .filter((t) => t.data.status === 'todo' && t.data.depends_on.every((d) => ['done', 'dropped'].includes(status.get(d))))
    .sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
}

export function validate(tasks) {
  const problems = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    if (t.data.id !== t.id) problems.push(`${t.id}: frontmatter id is ${t.data.id}`);
    if (!STATUSES.includes(t.data.status)) problems.push(`${t.id}: bad status "${t.data.status}"`);
    if (t.data.status === 'waiting' && !t.data.waiting_on) problems.push(`${t.id}: waiting without waiting_on`);
    for (const d of t.data.depends_on) {
      if (!byId.has(d)) problems.push(`${t.id}: depends on unknown ${d}`);
      else if (byId.get(d).data.status === 'dropped') problems.push(`${t.id}: depends on dropped ${d}`);
    }
  }
  const state = new Map(); // 1 = on the current path, 2 = finished
  const visit = (id, trail) => {
    if (!byId.has(id) || state.get(id) === 2) return;
    if (state.get(id) === 1) {
      problems.push(`cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    for (const d of byId.get(id).data.depends_on) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return problems;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/queue.test.mjs test/tasks.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/tasks.mjs test/queue.test.mjs
git commit -m "feat: ready queue and board validation"
```

---

### Task 6: Decisions and plan

**Files:**
- Create: `scripts/lib/decisions.mjs`, `scripts/lib/plan.mjs`, `test/decisions-plan.test.mjs`

**Interfaces:**
- Produces:
  - `decisionsFile(pm): string`, `appendDecision(pm, { title, why, rejected, tasks?, date }): string` (returns `D-NNN`), `recentDecisions(pm, n = 3): { id, date, title }[]` newest first.
  - `planFile(pm): string`, `planTemplate(name, date): string`, `projectName(pm): string`, `currentFocus(pm): string` (first non-heading line under `## Current focus`, or `''`).

- [ ] **Step 1: Write the failing tests**

`test/decisions-plan.test.mjs`:
```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/decisions-plan.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/decisions.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';

export const decisionsFile = (pm) => path.join(pm, 'decisions.md');
const HEAD_RE = /^## (D-\d+) · ([^·\n]+) · (.+)$/gm;

function entries(pm) {
  const file = decisionsFile(pm);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return [...text.matchAll(HEAD_RE)].map((m) => ({ id: m[1], date: m[2].trim(), title: m[3].trim() }));
}

// One append per decision: the log is append-only and merges by union across machines.
export function appendDecision(pm, { title, why, rejected, tasks = [], date }) {
  const n = Math.max(0, ...entries(pm).map((e) => Number(e.id.slice(2)))) + 1;
  const id = `D-${String(n).padStart(3, '0')}`;
  const lines = [`## ${id} · ${date} · ${title}`, `- why: ${why}`, `- rejected: ${rejected}`];
  if (tasks.length) lines.push(`- tasks: ${tasks.join(', ')}`);
  fs.appendFileSync(decisionsFile(pm), `\n${lines.join('\n')}\n`);
  return id;
}

export function recentDecisions(pm, n = 3) {
  return entries(pm).slice(-n).reverse();
}
```

`scripts/lib/plan.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';

export const planFile = (pm) => path.join(pm, 'PLAN.md');

export function planTemplate(name, date) {
  return `# ${name}\n\n## Goal\n\n## Milestones\n\n## Current focus\n\n## Changelog\n- ${date} · board created\n`;
}

function read(pm) {
  const file = planFile(pm);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
}

export function projectName(pm) {
  return read(pm).match(/^# (.+)$/m)?.[1].trim() ?? '';
}

export function currentFocus(pm) {
  return read(pm).match(/^## Current focus\n+([^\n#][^\n]*)/m)?.[1].trim() ?? '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/decisions-plan.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/decisions.mjs scripts/lib/plan.mjs test/decisions-plan.test.mjs
git commit -m "feat: decision log and plan helpers"
```

---

### Task 7: Board rendering and the board repository

**Files:**
- Create: `scripts/lib/board.mjs`, `scripts/lib/store.mjs`, `test/board-store.test.mjs`

**Interfaces:**
- Consumes: `listTasks`, `readyQueue`, `lastNext` (tasks); `projectName`, `currentFocus`, `planTemplate` (plan); `git`, `tryGit`, `pmDir`, `mainRoot` (paths).
- Produces:
  - `COLUMNS: [key, label][]` with keys `todo, ready, in_progress, waiting, done`; `columns(tasks): Record<key, Task[]>` (dropped and unknown statuses omitted); `renderBoardMd(pm): string`; `renderBoardHtml(pm): string`; `writeBoard(pm): void` (writes `BOARD.md` and `board.html`).
  - `hasBoard(cwd): boolean`, `initBoard(cwd, date): { pm, created }`, `identityArgs(pm): string[]`, `commitPm(pm, message): boolean` (never throws), `isSyncOn(pm): boolean`, `backgroundPush(pm): void` (spawns `pm.mjs _push <pm>` detached; no-op when `PM_NO_BACKGROUND` is set), `persist(pm, message): void` (write board → commit → background push if sync is on).

- [ ] **Step 1: Write the failing tests**

`test/board-store.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, setup, sh } from './helpers.mjs';
import { newTask, setFields, claim, appendLog, listTasks } from '../scripts/lib/tasks.mjs';
import { planFile, planTemplate } from '../scripts/lib/plan.mjs';
import { columns, writeBoard } from '../scripts/lib/board.mjs';
import { initBoard, hasBoard, commitPm, isSyncOn } from '../scripts/lib/store.mjs';

const D = '2026-09-12';

test('board puts every non-dropped task in its column', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'done one', date: D });
  setFields(pm, 'T-001', { status: 'done' }, D);
  newTask(pm, { title: 'ready one', deps: ['T-001'], date: D });
  newTask(pm, { title: 'blocked one', deps: ['T-004'], date: D });
  newTask(pm, { title: 'active <one>', date: D });
  claim(pm, 'T-004', 'wt-a', D);
  appendLog(pm, 'T-004', { worktree: 'wt-a', did: 'a', next: 'b', date: D });
  newTask(pm, { title: 'waiting one', date: D });
  setFields(pm, 'T-005', { status: 'waiting', waiting_on: 'user' }, D);
  newTask(pm, { title: 'dropped one', date: D });
  setFields(pm, 'T-006', { status: 'dropped' }, D);

  const ids = Object.fromEntries(Object.entries(columns(listTasks(pm))).map(([k, v]) => [k, v.map((t) => t.id)]));
  assert.deepEqual(ids, { todo: ['T-003'], ready: ['T-002'], in_progress: ['T-004'], waiting: ['T-005'], done: ['T-001'] });

  writeBoard(pm);
  const md = fs.readFileSync(path.join(pm, 'BOARD.md'), 'utf8');
  assert.match(md, /## Ready \(1\)\n- \*\*T-002\*\* ready one · after T-001/);
  assert.match(md, /- \*\*T-004\*\* active <one> · @ wt-a · next: b/);
  assert.match(md, /waiting: user/);
  assert.doesNotMatch(md, /T-006/);
  const html = fs.readFileSync(path.join(pm, 'board.html'), 'utf8');
  assert.match(html, /active &lt;one&gt;/);
  assert.match(html, /http-equiv="refresh"/);
  assert.doesNotMatch(html, /dropped one/);
});

test('initBoard creates a committed local board with no remote', () => {
  const { root } = setup();
  const { pm, created } = initBoard(root, D);
  assert.equal(created, true);
  for (const f of ['PLAN.md', 'decisions.md', '.gitignore', '.gitattributes', 'tasks/.gitkeep', 'BOARD.md', 'board.html']) {
    assert.ok(fs.existsSync(path.join(pm, f)), f);
  }
  assert.equal(sh(['branch', '--show-current'], pm), 'pm');
  assert.equal(sh(['log', '--format=%s'], pm), 'pm: init');
  assert.equal(sh(['remote'], pm), '');
  assert.equal(sh(['status', '--porcelain'], pm), '', 'generated files are ignored');
  assert.equal(hasBoard(root), true);
  assert.equal(isSyncOn(pm), false);
  assert.equal(initBoard(root, D).created, false);
});

test('commitPm commits only when something changed', () => {
  const { root } = setup();
  const { pm } = initBoard(root, D);
  assert.equal(commitPm(pm, 'noop'), false);
  fs.appendFileSync(path.join(pm, 'decisions.md'), 'x\n');
  assert.equal(commitPm(pm, 'pm: edit'), true);
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: edit');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/board-store.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the board**

`scripts/lib/board.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { listTasks, readyQueue, lastNext } from './tasks.mjs';
import { projectName, currentFocus } from './plan.mjs';

export const COLUMNS = [
  ['todo', 'Todo'],
  ['ready', 'Ready'],
  ['in_progress', 'In progress'],
  ['waiting', 'Waiting'],
  ['done', 'Done'],
];

export function columns(tasks) {
  const ready = new Set(readyQueue(tasks).map((t) => t.id));
  const cols = Object.fromEntries(COLUMNS.map(([k]) => [k, []]));
  for (const t of tasks) {
    const s = t.data.status;
    if (s === 'todo') cols[ready.has(t.id) ? 'ready' : 'todo'].push(t);
    else if (s !== 'dropped' && cols[s]) cols[s].push(t);
  }
  return cols;
}

const nextOf = (t) => (t.data.status === 'done' ? null : lastNext(t));

function cardLine(t) {
  const bits = [`**${t.id}** ${t.data.title}`];
  if (t.data.milestone) bits.push(t.data.milestone);
  if (t.data.depends_on.length) bits.push(`after ${t.data.depends_on.join(', ')}`);
  if (t.data.worktrees.length) bits.push(`@ ${t.data.worktrees.join(', ')}`);
  if (t.data.waiting_on) bits.push(`waiting: ${t.data.waiting_on}`);
  const next = nextOf(t);
  if (next) bits.push(`next: ${next.next}`);
  return `- ${bits.join(' · ')}`;
}

export function renderBoardMd(pm) {
  const cols = columns(listTasks(pm));
  const out = [`# Board — ${projectName(pm)}`, '', `Focus: ${currentFocus(pm) || '—'}`, '', '<!-- generated by pm; do not edit -->'];
  for (const [k, label] of COLUMNS) out.push('', `## ${label} (${cols[k].length})`, ...cols[k].map(cardLine));
  return `${out.join('\n')}\n`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function card(t) {
  const next = nextOf(t);
  const meta = [
    t.data.milestone && `<span class="tag">${esc(t.data.milestone)}</span>`,
    t.data.depends_on.length && `<span>after ${esc(t.data.depends_on.join(', '))}</span>`,
    t.data.worktrees.length && `<span>@ ${esc(t.data.worktrees.join(', '))}</span>`,
  ].filter(Boolean).join(' ');
  return `<article class="card"><b>${esc(t.id)}</b> ${esc(t.data.title)}`
    + (meta ? `<div class="meta">${meta}</div>` : '')
    + (t.data.waiting_on ? `<div class="wait">waiting: ${esc(t.data.waiting_on)}</div>` : '')
    + (next ? `<div class="next">next: ${esc(next.next)}</div>` : '')
    + '</article>';
}

export function renderBoardHtml(pm) {
  const cols = columns(listTasks(pm));
  const name = esc(projectName(pm));
  const sections = COLUMNS.map(([k, label]) => `<section class="col"><h2>${label} · ${cols[k].length}</h2>${cols[k].map(card).join('')}</section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · board</title>
<style>
:root{--bg:#f6f6f4;--col:#ecebe7;--card:#fff;--fg:#1d1d1b;--muted:#6b6a65;--line:#d9d8d2;--accent:#3a5bd9;--warn:#a25400}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--col:#1f1f1c;--card:#2a2a26;--fg:#ecebe7;--muted:#a3a29b;--line:#3a3a35;--accent:#8ea5ff;--warn:#f0a35e}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}.focus{color:var(--muted);margin:0 0 16px}
.board{display:grid;grid-template-columns:repeat(5,minmax(200px,1fr));gap:12px;overflow-x:auto}
.col{background:var(--col);border-radius:8px;padding:8px}
.col h2{font-size:12px;margin:4px 4px 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px}
.meta,.next,.wait{font-size:12px;color:var(--muted);margin-top:4px}.tag{color:var(--accent)}.wait{color:var(--warn)}
</style></head><body>
<h1>${name}</h1><p class="focus">Focus: ${esc(currentFocus(pm) || '—')}</p>
<main class="board">${sections}</main>
</body></html>
`;
}

export function writeBoard(pm) {
  fs.writeFileSync(path.join(pm, 'BOARD.md'), renderBoardMd(pm));
  fs.writeFileSync(path.join(pm, 'board.html'), renderBoardHtml(pm));
}
```

- [ ] **Step 4: Implement the store**

`scripts/lib/store.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, tryGit, pmDir, mainRoot } from './paths.mjs';
import { planTemplate } from './plan.mjs';
import { writeBoard } from './board.mjs';

const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const GITIGNORE = '.state/\nBOARD.md\nboard.html\n';
const GITATTRIBUTES = 'decisions.md merge=union\nmemory/MEMORY.md merge=union\n';

export function hasBoard(cwd) {
  const pm = pmDir(cwd);
  return Boolean(pm && fs.existsSync(path.join(pm, '.git')));
}

// Commits work even on machines without a configured git identity.
export function identityArgs(pm) {
  return tryGit(['config', 'user.email'], pm) ? [] : ['-c', 'user.name=pm', '-c', 'user.email=pm@localhost'];
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function commitPm(pm, message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      git(['add', '-A'], pm);
      if (tryGit(['diff', '--cached', '--quiet'], pm) !== null) return false; // nothing staged
      git([...identityArgs(pm), 'commit', '-q', '-m', message], pm);
      return true;
    } catch {
      sleep(300); // usually index.lock held by a concurrent pm process
    }
  }
  return false;
}

export const isSyncOn = (pm) => tryGit(['remote', 'get-url', 'origin'], pm) !== null;

export function backgroundPush(pm) {
  if (process.env.PM_NO_BACKGROUND) return; // test seam
  spawn(process.execPath, [PM_SCRIPT, '_push', pm], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function persist(pm, message) {
  writeBoard(pm);
  if (commitPm(pm, message) && isSyncOn(pm)) backgroundPush(pm);
}

export function initBoard(cwd, date) {
  const pm = pmDir(cwd);
  if (!pm) throw new Error('not inside a git repository');
  if (fs.existsSync(path.join(pm, '.git'))) return { pm, created: false };
  fs.mkdirSync(path.join(pm, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(pm, '.gitignore'), GITIGNORE);
  fs.writeFileSync(path.join(pm, '.gitattributes'), GITATTRIBUTES);
  fs.writeFileSync(path.join(pm, 'tasks', '.gitkeep'), '');
  fs.writeFileSync(path.join(pm, 'PLAN.md'), planTemplate(path.basename(mainRoot(cwd)), date));
  fs.writeFileSync(path.join(pm, 'decisions.md'), '# Decisions\n');
  git(['init', '-q', '-b', 'pm'], pm);
  writeBoard(pm);
  commitPm(pm, 'pm: init');
  return { pm, created: true };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/board-store.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/board.mjs scripts/lib/store.mjs test/board-store.test.mjs
git commit -m "feat: board rendering and local board repository"
```

---

### Task 8: Session summary

**Files:**
- Create: `scripts/lib/summary.mjs`, `test/summary.test.mjs`

**Interfaces:**
- Consumes: `listTasks`, `readyQueue`, `lastNext`; `recentDecisions`; `projectName`, `currentFocus`.
- Produces: `MAX_LINES = 40`, `RULES: string[]` (2 lines, first starts with `Rules:`), `buildSummary({ pm, worktree, scriptPath, statusLine? }): string`.

- [ ] **Step 1: Write the failing tests**

`test/summary.test.mjs`:
```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/summary.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/summary.mjs`:
```js
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listTasks, readyQueue, lastNext } from './tasks.mjs';
import { recentDecisions } from './decisions.mjs';
import { projectName, currentFocus } from './plan.mjs';

export const MAX_LINES = 40;
export const RULES = [
  'Rules: keep tasks, statuses, log and decisions current yourself via the CLI · end every turn that changed the board with a one-line board diff',
  '  only the main agent writes pm/ · before calling a task done, ask "what\'s left?" and file leftovers as tasks · protocol: /pm',
];

const OPEN = (t) => !['done', 'dropped'].includes(t.data.status);

export function buildSummary({ pm, worktree, scriptPath, statusLine = '' }) {
  const tasks = listTasks(pm);
  const mine = tasks.filter((t) => OPEN(t) && t.data.worktrees.includes(worktree));
  const elsewhere = tasks.filter((t) => t.data.status === 'in_progress' && !t.data.worktrees.includes(worktree)).slice(0, 5);
  const ready = readyQueue(tasks).slice(0, 3);
  const waiting = tasks.filter((t) => t.data.status === 'waiting').slice(0, 5);
  const decisions = recentDecisions(pm, 3);

  const lines = [`[pm] ${projectName(pm)} · focus: ${currentFocus(pm) || '—'} · board: ${pathToFileURL(path.join(pm, 'board.html')).href}`];
  if (statusLine) lines.push(statusLine);
  lines.push(`Your worktree (${worktree}):`);
  if (!mine.length) lines.push('  no active task — take one from Ready, or say what to work on');
  for (const t of mine) {
    const n = lastNext(t);
    lines.push(`  ${t.id} ${t.data.title} [${t.data.status}]${n ? ` → next: ${n.next} (${n.date}, ${n.who})` : ''}`);
  }
  if (elsewhere.length) lines.push(`Elsewhere: ${elsewhere.map((t) => `${t.id} ${t.data.title} @ ${t.data.worktrees.join(', ')}`).join(' · ')}`);
  lines.push(`Ready: ${ready.map((t) => `${t.id} ${t.data.title}`).join(' · ') || '—'}`);
  if (waiting.length) lines.push(`Waiting: ${waiting.map((t) => `${t.id} ← ${t.data.waiting_on}`).join(' · ')}`);
  if (decisions.length) lines.push(`Decisions: ${decisions.map((d) => `${d.id} ${d.title}`).join(' · ')}`);

  const tail = [`CLI: node "${scriptPath}" <command>`, ...RULES];
  const room = MAX_LINES - tail.length;
  if (lines.length > room) {
    const cut = lines.length - room + 1;
    lines.splice(room - 1, cut, `  … ${cut} more lines — see BOARD.md`);
  }
  return [...lines, ...tail].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/summary.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/summary.mjs test/summary.test.mjs
git commit -m "feat: session summary capped at 40 lines"
```

---

### Task 9: CLI for local board commands

Replaces the spike `scripts/pm.mjs` entirely. Hook handling returns in Task 13.

**Files:**
- Replace: `scripts/pm.mjs`
- Create: `test/cli.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 2–8.
- Produces: commands `init`, `task new`, `set`, `claim`, `log`, `decision`, `ready`, `validate`, `board`, `summary`. A `commands` object keyed by command name — later tasks add `scan`, `sync`, `_push`, `hook` to it. Output goes to stdout; usage/validation errors go to stderr with exit code 1; `validate` exits 1 when problems exist.

- [ ] **Step 1: Write the failing tests**

`test/cli.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setup, cli, sh, PM } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

test('cli: the full local workflow', () => {
  const { root } = setup();
  assert.match(cli(['init'], root).out, /^created: /);
  assert.match(cli(['init'], root).out, /^exists: /);
  assert.match(cli(['task', 'new', '--title', 'Parser', '--milestone', 'M1'], root).out, /^T-001 created/);
  assert.match(cli(['task', 'new', '--title', 'Docs', '--deps', 'T-001'], root).out, /^T-002 created/);
  assert.equal(cli(['ready'], root).out, 'T-001 Parser');
  assert.match(cli(['claim', 'T-001'], root).out, new RegExp(`claimed by ${path.basename(root)}`));
  assert.equal(cli(['log', 'T-001', '--did', 'tokenizer', '--next', 'edge cases'], root).code, 0);
  assert.equal(cli(['set', 'T-001', 'status=done'], root).code, 0);
  assert.equal(cli(['ready'], root).out, 'T-002 Docs');
  assert.match(cli(['decision', '--title', 'Use CSV', '--why', 'simple', '--rejected', 'JSON', '--tasks', 'T-001'], root).out, /^D-001 recorded/);
  assert.equal(cli(['validate'], root).out, 'ok');
  assert.match(cli(['board'], root).out, /board\.html$/);
  assert.match(cli(['summary'], root).out, /Ready: T-002 Docs/);
  const log = sh(['log', '--format=%s'], pmDir(root));
  for (const s of ['pm: init', 'pm: task new T-001', 'pm: claim T-001', 'pm: log T-001', 'pm: set T-001 status=done', 'pm: decision D-001']) {
    assert.match(log, new RegExp(s));
  }
});

test('cli: errors exit 1 with a message', () => {
  const { root } = setup();
  const noBoard = cli(['ready'], root);
  assert.equal(noBoard.code, 1);
  assert.match(noBoard.err, /no board here/);
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  const bad = cli(['set', 'T-001', 'status=doing'], root);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /bad status/);
  assert.equal(cli(['task', 'new'], root).code, 1);
  assert.equal(cli(['nope'], root).code, 1);
  cli(['set', 'T-001', 'depends_on=T-404'], root);
  const v = cli(['validate'], root);
  assert.equal(v.code, 1);
  assert.match(v.out, /depends on unknown T-404/);
});

test('cli: concurrent task creation never reuses an id', async () => {
  const { root } = setup();
  cli(['init'], root);
  const run = (title) => new Promise((resolve) => {
    spawn(process.execPath, [PM, 'task', 'new', '--title', title], { cwd: root, env: process.env }).on('exit', resolve);
  });
  await Promise.all(Array.from({ length: 6 }, (_, i) => run(`t${i}`)));
  const files = fs.readdirSync(path.join(pmDir(root), 'tasks')).filter((f) => f.startsWith('T-'));
  assert.equal(files.length, 6);
  assert.equal(cli(['validate'], root).out, 'ok');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/cli.test.mjs`
Expected: FAIL — the spike `pm.mjs` prints nothing for `init`.

- [ ] **Step 3: Implement** — replace `scripts/pm.mjs` with:

```js
#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pmDir, worktreeName, today } from './lib/paths.mjs';
import { hasBoard, initBoard, persist } from './lib/store.mjs';
import { listTasks, newTask, setFields, claim, appendLog, readyQueue, validate } from './lib/tasks.mjs';
import { appendDecision } from './lib/decisions.mjs';
import { writeBoard } from './lib/board.mjs';
import { buildSummary } from './lib/summary.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const USAGE = `usage: pm <command>
  init                                         create the local board for this repo
  task new --title T [--order N] [--deps T-001,T-002] [--milestone M1] [--links a,b]
  set <id> key=value ...                       update task fields (status, order, depends_on, waiting_on, ...)
  claim <id>                                   attach this worktree and set in_progress
  log <id> --did "..." --next "..."            append a work log entry
  decision --title T --why W --rejected R [--tasks T-001,T-002]
  ready | validate | board | summary | scan
  sync [on [--remote url] [--yes] | off]       opt-in sync of board and memory across machines
  hook <event>                                 hook entry point (used by the plugin)`;

class UsageError extends Error {}
const fail = (msg) => {
  throw new UsageError(msg);
};
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const strings = (args, names) => parseArgs({ args, options: Object.fromEntries(names.map((n) => [n, { type: 'string' }])) }).values;

function requireBoard(cwd) {
  if (!hasBoard(cwd)) fail('no board here — run: pm init');
  return pmDir(cwd);
}

const commands = {
  init(cwd) {
    const { pm, created } = initBoard(cwd, today());
    return `${created ? 'created' : 'exists'}: ${pm}`;
  },

  task(cwd, [sub, ...args]) {
    if (sub !== 'new') fail(USAGE);
    const v = strings(args, ['title', 'order', 'deps', 'milestone', 'links']);
    if (!v.title) fail('--title is required');
    const pm = requireBoard(cwd);
    const t = newTask(pm, {
      title: v.title,
      order: v.order === undefined ? undefined : Number(v.order),
      deps: list(v.deps),
      milestone: v.milestone ?? '',
      links: list(v.links),
      date: today(),
    });
    persist(pm, `pm: task new ${t.id}`);
    return `${t.id} created: ${t.file}`;
  },

  set(cwd, [id, ...pairs]) {
    if (!id || !pairs.length) fail('usage: pm set <id> key=value ...');
    const fields = Object.fromEntries(pairs.map((p) => {
      const i = p.indexOf('=');
      if (i < 1) fail(`bad field "${p}", use key=value`);
      return [p.slice(0, i), p.slice(i + 1)];
    }));
    const pm = requireBoard(cwd);
    setFields(pm, id, fields, today());
    persist(pm, `pm: set ${id} ${pairs.join(' ')}`);
    return `${id} updated`;
  },

  claim(cwd, [id]) {
    if (!id) fail('usage: pm claim <id>');
    const pm = requireBoard(cwd);
    const wt = worktreeName(cwd);
    claim(pm, id, wt, today());
    persist(pm, `pm: claim ${id}`);
    return `${id} claimed by ${wt}`;
  },

  log(cwd, [id, ...args]) {
    const v = strings(args, ['did', 'next']);
    if (!id || !v.did || !v.next) fail('usage: pm log <id> --did "..." --next "..."');
    const pm = requireBoard(cwd);
    appendLog(pm, id, { worktree: worktreeName(cwd), did: v.did, next: v.next, date: today() });
    persist(pm, `pm: log ${id}`);
    return `${id} logged`;
  },

  decision(cwd, args) {
    const v = strings(args, ['title', 'why', 'rejected', 'tasks']);
    if (!v.title || !v.why || !v.rejected) fail('usage: pm decision --title T --why W --rejected R [--tasks T-001]');
    const pm = requireBoard(cwd);
    const id = appendDecision(pm, { title: v.title, why: v.why, rejected: v.rejected, tasks: list(v.tasks), date: today() });
    persist(pm, `pm: decision ${id}`);
    return `${id} recorded`;
  },

  ready(cwd) {
    return readyQueue(listTasks(requireBoard(cwd))).map((t) => `${t.id} ${t.data.title}`).join('\n') || '(nothing ready)';
  },

  validate(cwd) {
    const problems = validate(listTasks(requireBoard(cwd)));
    if (!problems.length) return 'ok';
    process.exitCode = 1;
    return problems.join('\n');
  },

  board(cwd) {
    const pm = requireBoard(cwd);
    writeBoard(pm);
    return path.join(pm, 'board.html');
  },

  summary(cwd) {
    return buildSummary({ pm: requireBoard(cwd), worktree: worktreeName(cwd), scriptPath: SCRIPT });
  },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const run = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
  if (!run) fail(USAGE);
  const out = await run(process.cwd(), args);
  if (out) console.log(out);
}

main().catch((e) => {
  console.error(e instanceof UsageError ? e.message : `pm: ${e.message}`);
  process.exit(1);
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test`
Expected: PASS — all suites so far.

- [ ] **Step 5: Commit**

```bash
git add scripts/pm.mjs test/cli.test.mjs
git commit -m "feat: pm CLI for local board commands"
```

---

### Task 10: Scan plans from other tools

**Files:**
- Create: `scripts/lib/scan.mjs`, `test/scan.test.mjs`
- Modify: `scripts/pm.mjs` (import + `scan` command)

**Interfaces:**
- Produces: `REPO_PLAN_DIRS: string[]`, `scanPlans(cwd): { path: string, done: number, total: number }[]` — repo-relative plan folders in the current worktree, plus `~/.gstack/projects/<slug containing repo name>/ceo-plans/*.md`.

- [ ] **Step 1: Write the failing tests**

`test/scan.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, cli } from './helpers.mjs';
import { scanPlans } from '../scripts/lib/scan.mjs';

test('scanPlans finds plan files with checkbox counts', () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'superpowers', 'plans', '2026-09-12-x.md'), '# x\n- [x] a\n- [ ] b\n  - [X] c\n');
  fs.mkdirSync(path.join(root, 'docs', 'designs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'designs', 'y.md'), '# y\n');
  fs.writeFileSync(path.join(root, 'docs', 'designs', 'z.txt'), 'ignored');
  const found = scanPlans(root).map((p) => [path.basename(p.path), p.done, p.total]);
  assert.deepEqual(found, [['2026-09-12-x.md', 2, 3], ['y.md', 0, 0]]);
  cli(['init'], root);
  assert.match(cli(['scan'], root).out, /2\/3 .*2026-09-12-x\.md/);
});

test('scan reports when nothing is found', () => {
  const { root } = setup();
  cli(['init'], root);
  assert.equal(cli(['scan'], root).out, '(no plans found)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/scan.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`scripts/lib/scan.mjs`:
```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainRoot, tryGit } from './paths.mjs';

export const REPO_PLAN_DIRS = ['docs/superpowers/plans', 'docs/superpowers/specs', 'docs/designs', '.dev-cycle/tasks'];

const mdFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f)) : []);

export function scanPlans(cwd) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return [];
  const files = REPO_PLAN_DIRS.flatMap((d) => mdFiles(path.join(top, d)));
  const repoName = path.basename(mainRoot(cwd)).toLowerCase();
  const gstack = path.join(os.homedir(), '.gstack', 'projects');
  if (fs.existsSync(gstack)) {
    for (const slug of fs.readdirSync(gstack)) {
      if (slug.toLowerCase().includes(repoName)) files.push(...mdFiles(path.join(gstack, slug, 'ceo-plans')));
    }
  }
  return files.map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return {
      path: file,
      done: (text.match(/^\s*- \[[xX]\]/gm) ?? []).length,
      total: (text.match(/^\s*- \[[ xX]\]/gm) ?? []).length,
    };
  });
}
```

In `scripts/pm.mjs`, add after `import { buildSummary } from './lib/summary.mjs';`:
```js
import { scanPlans } from './lib/scan.mjs';
```
and add this entry to `commands`, directly before `summary(cwd) {`:
```js
  scan(cwd) {
    requireBoard(cwd);
    return scanPlans(cwd).map((p) => `${p.done}/${p.total}  ${p.path}`).join('\n') || '(no plans found)';
  },

```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/scan.test.mjs test/cli.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/scan.mjs scripts/pm.mjs test/scan.test.mjs
git commit -m "feat: scan plan files written by other tools"
```

---

### Task 11: Opt-in sync across machines

**Files:**
- Create: `scripts/lib/sync.mjs`, `test/sync.test.mjs`
- Modify: `scripts/pm.mjs` (imports + `sync`, `_push` commands)

**Interfaces:**
- Consumes: `git`, `tryGit`, `pmDir`, `today`; `hasBoard`, `initBoard`, `identityArgs`, `isSyncOn`, `commitPm`; `writeBoard`.
- Produces: `syncTarget(cwd, remote?): string | null`, `sharedBoardHint(cwd): boolean`, `syncOn(cwd, url): { pm, mode: 'cloned' | 'pushed' | 'merged', conflict: boolean }`, `syncOff(pm): void`, `pull(pm, timeoutMs = 5000): 'ok' | 'offline' | 'conflict'`, `pushNow(pm): 'ok' | 'offline' | 'conflict'`, `conflictFiles(pm): string[] | null`, `unpushedOverDay(pm, now = Date.now()): number`.

- [ ] **Step 1: Write the failing tests**

`test/sync.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp, sh, cli, pmOf } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

// Machine 1: a project with an origin remote (a local bare repo).
function project() {
  const { home, root } = setup();
  const remote = tmp('pm-remote-');
  sh(['init', '-q', '--bare', '-b', 'main'], remote);
  sh(['remote', 'add', 'origin', remote], root);
  sh(['push', '-q', 'origin', 'main'], root);
  return { home, root, remote };
}

// Machine 2: its own claude home and its own clone of the project.
function machine2(remote) {
  const home = tmp('pm-home2-');
  const root = path.join(tmp('pm-m2-'), 'repo');
  sh(['clone', '-q', remote, root], path.dirname(root));
  return { home, root, env: { env: { CLAUDE_CONFIG_DIR: home } } };
}

const remoteHasPm = (remote) => sh(['branch', '--list', 'pm'], remote) !== '';

test('local by default: nothing is pushed until sync on --yes', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  assert.equal(remoteHasPm(remote), false);
  const dry = cli(['sync', 'on'], root);
  assert.match(dry.out, /will be pushed to .* \(branch pm\)[\s\S]*--yes/);
  assert.equal(remoteHasPm(remote), false);
  assert.match(cli(['sync', 'on', '--yes'], root).out, /sync on \(pushed\)/);
  assert.equal(remoteHasPm(remote), true);
  assert.match(cli(['sync', 'off'], root).out, /sync off/);
  assert.equal(sh(['remote'], pmDir(root)), '');
  assert.ok(fs.existsSync(path.join(pmDir(root), 'tasks', 'T-001.md')));
  assert.equal(cli(['sync'], root).code, 1);
});

test('another machine clones the shared board only on sync on', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'shared task'], root);
  cli(['sync', 'on', '--yes'], root);
  const m2 = machine2(remote);
  assert.equal(cli(['summary'], m2.root, m2.env).code, 1, 'no board until the user connects');
  assert.match(cli(['sync', 'on', '--yes'], m2.root, m2.env).out, /sync on \(cloned\)/);
  assert.match(cli(['summary'], m2.root, m2.env).out, /T-001 shared task/);
});

test('an existing local board merges with the remote board', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  const m2 = machine2(remote);
  cli(['init'], m2.root, m2.env);
  const r = cli(['sync', 'on', '--yes'], m2.root, m2.env);
  assert.equal(r.code, 0);
  assert.match(r.out, /sync conflict in: .*PLAN\.md|sync on \(merged\)/);
});

test('decisions merge by union; a conflicting task edit is flagged without data loss', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'base'], root);
  cli(['sync', 'on', '--yes'], root);
  const m2 = machine2(remote);
  cli(['sync', 'on', '--yes'], m2.root, m2.env);

  cli(['decision', '--title', 'from m1', '--why', 'a', '--rejected', 'b'], root);
  assert.equal(cli(['sync'], root).out, 'synced');
  cli(['decision', '--title', 'from m2', '--why', 'c', '--rejected', 'd'], m2.root, m2.env);
  assert.equal(cli(['sync'], m2.root, m2.env).out, 'synced');
  const decisions = fs.readFileSync(path.join(pmOf(m2.home, m2.root), 'decisions.md'), 'utf8');
  assert.match(decisions, /from m1/);
  assert.match(decisions, /from m2/);

  cli(['sync'], root);
  cli(['set', 'T-001', 'title=title from m1'], root);
  cli(['sync'], root);
  cli(['set', 'T-001', 'title=title from m2'], m2.root, m2.env);
  const r = cli(['sync'], m2.root, m2.env);
  assert.equal(r.code, 0);
  assert.match(r.out, /sync conflict in: tasks\/T-001\.md/);
  const task = fs.readFileSync(path.join(pmOf(m2.home, m2.root), 'tasks', 'T-001.md'), 'utf8');
  assert.match(task, /title from m2/);
});

test('offline remote: sync reports offline, exits 0, keeps local commits', () => {
  const { root } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  sh(['remote', 'set-url', 'origin', path.join(tmp(), 'missing.git')], pmDir(root));
  cli(['task', 'new', '--title', 'offline work'], root);
  const r = cli(['sync'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /offline/);
  assert.equal(sh(['log', '-1', '--format=%s'], pmDir(root)), 'pm: task new T-001');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/sync.test.mjs`
Expected: FAIL — `sync` is not a command (usage printed, exit 1).

- [ ] **Step 3: Implement the module**

`scripts/lib/sync.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { git, tryGit, pmDir, today } from './paths.mjs';
import { hasBoard, initBoard, identityArgs } from './store.mjs';
import { writeBoard } from './board.mjs';

const NET = { timeout: 60_000 };
const conflictPath = (pm) => path.join(pm, '.state', 'conflict');

export const syncTarget = (cwd, remote) => remote || tryGit(['remote', 'get-url', 'origin'], cwd);

// Local-only check: a normal `git fetch` of the project brings refs/remotes/origin/pm.
export const sharedBoardHint = (cwd) => tryGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pm'], cwd) !== null;

function recordConflict(pm, op) {
  const files = tryGit(['diff', '--name-only', '--diff-filter=U'], pm) ?? '';
  tryGit([op, '--abort'], pm); // keep local commits; nothing is discarded
  fs.mkdirSync(path.dirname(conflictPath(pm)), { recursive: true });
  fs.writeFileSync(conflictPath(pm), files);
}

export function conflictFiles(pm) {
  const file = conflictPath(pm);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : null;
}

export function syncOn(cwd, url) {
  const pm = pmDir(cwd);
  const remoteHasBoard = Boolean(git(['ls-remote', '--heads', url, 'pm'], cwd, NET));
  if (!hasBoard(cwd) && remoteHasBoard) {
    fs.mkdirSync(path.dirname(pm), { recursive: true });
    git(['clone', '-q', '--single-branch', '--branch', 'pm', url, pm], path.dirname(pm), NET);
    writeBoard(pm);
    return { pm, mode: 'cloned', conflict: false };
  }
  if (!hasBoard(cwd)) initBoard(cwd, today());
  tryGit(['remote', 'remove', 'origin'], pm);
  git(['remote', 'add', 'origin', url], pm);
  if (remoteHasBoard) {
    git(['fetch', '-q', 'origin', 'pm'], pm, NET);
    try {
      git([...identityArgs(pm), 'merge', '-q', '--allow-unrelated-histories', '-m', 'pm: merge shared board', 'origin/pm'], pm);
    } catch {
      recordConflict(pm, 'merge');
      return { pm, mode: 'merged', conflict: true };
    }
  }
  git(['push', '-q', '-u', 'origin', 'pm'], pm, NET);
  writeBoard(pm);
  return { pm, mode: remoteHasBoard ? 'merged' : 'pushed', conflict: false };
}

export function syncOff(pm) {
  tryGit(['remote', 'remove', 'origin'], pm);
  fs.rmSync(conflictPath(pm), { force: true });
}

export function pull(pm, timeout = 5000) {
  try {
    git([...identityArgs(pm), 'pull', '-q', '--rebase', '--autostash', 'origin', 'pm'], pm, { timeout });
    fs.rmSync(conflictPath(pm), { force: true });
    return 'ok';
  } catch {
    const dotgit = path.join(pm, '.git');
    if (fs.existsSync(path.join(dotgit, 'rebase-merge')) || fs.existsSync(path.join(dotgit, 'rebase-apply'))) {
      recordConflict(pm, 'rebase');
      return 'conflict';
    }
    return 'offline';
  }
}

export function pushNow(pm) {
  const r = pull(pm, NET.timeout);
  if (r !== 'ok') return r;
  return tryGit(['push', '-q', 'origin', 'pm'], pm, NET) === null ? 'offline' : 'ok';
}

// Number of unpushed commits when the oldest of them is more than a day old, else 0.
export function unpushedOverDay(pm, now = Date.now()) {
  const out = tryGit(['log', 'origin/pm..pm', '--format=%ct'], pm);
  if (!out) return 0;
  const stamps = out.split('\n').map(Number);
  return now - Math.min(...stamps) * 1000 > 86_400_000 ? stamps.length : 0;
}
```

- [ ] **Step 4: Wire the CLI**

In `scripts/pm.mjs`:
1. Change the store import line to:
```js
import { hasBoard, initBoard, persist, commitPm, isSyncOn } from './lib/store.mjs';
```
2. Add after `import { scanPlans } from './lib/scan.mjs';`:
```js
import { syncTarget, syncOn, syncOff, pushNow, conflictFiles } from './lib/sync.mjs';
```
3. Add after the `requireBoard` function:
```js
const conflictHelp = (pm) => `sync conflict in: ${(conflictFiles(pm) ?? []).join(', ') || 'unknown files'}
nothing was discarded. To resolve: cd "${pm}" && git pull --rebase origin pm (first sync: git merge origin/pm),
fix the listed files, git add -A, then git rebase --continue (or git commit), then run: pm sync`;
```
4. Add these entries to `commands`, directly before `summary(cwd) {`:
```js
  sync(cwd, [sub, ...args]) {
    if (sub === 'on') {
      const v = parseArgs({ args, options: { remote: { type: 'string' }, yes: { type: 'boolean' } } }).values;
      const url = syncTarget(cwd, v.remote);
      if (!url) fail('this project has no origin remote; pass --remote <url>');
      if (!v.yes) {
        return `The board (and auto-memory, unless git config pm.syncMemory false) will be pushed to ${url} (branch pm).
If that repository is public, they become public; use --remote <private-url> instead.
Re-run with --yes to proceed.`;
      }
      if (hasBoard(cwd)) commitPm(pmDir(cwd), 'pm: before sync on');
      const r = syncOn(cwd, url);
      return r.conflict ? conflictHelp(r.pm) : `sync on (${r.mode}): ${url} branch pm`;
    }
    if (sub === 'off') {
      syncOff(requireBoard(cwd));
      return 'sync off; the local board is kept. To delete the remote branch: git push <remote> --delete pm';
    }
    if (sub) fail('usage: pm sync [on [--remote url] [--yes] | off]');
    const pm = requireBoard(cwd);
    if (!isSyncOn(pm)) fail('sync is off for this project — run: pm sync on');
    commitPm(pm, 'pm: sync');
    const r = pushNow(pm);
    writeBoard(pm);
    if (r === 'conflict') return conflictHelp(pm);
    return r === 'ok' ? 'synced' : 'offline — changes are committed locally and will be pushed later';
  },

  _push(cwd, [pm]) {
    pushNow(pm);
    return '';
  },

```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/sync.mjs scripts/pm.mjs test/sync.test.mjs
git commit -m "feat: opt-in board sync via orphan branch pm"
```

---

### Task 12: Memory sync through a link

If Task 1 Spike D failed, STOP: this task must be redesigned around `autoMemoryDirectory` with the owner.

**Files:**
- Modify: `scripts/lib/sync.mjs` (append), `scripts/pm.mjs` (sync on)
- Create: `test/memory.test.mjs`

**Interfaces:**
- Consumes: `memoryDir` (paths), `tryGit`.
- Produces: `memorySyncEnabled(cwd): boolean`, `linkMemory(cwd, pm): { linked: boolean, moved: string[], clashes: string[] }`, `isLink(p): boolean`.

- [ ] **Step 1: Write the failing tests**

`test/memory.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, tmp, sh, cli } from './helpers.mjs';
import { pmDir, memoryDir } from '../scripts/lib/paths.mjs';
import { linkMemory, isLink } from '../scripts/lib/sync.mjs';

function project() {
  const { root } = setup();
  const remote = tmp('pm-remote-');
  sh(['init', '-q', '--bare', '-b', 'main'], remote);
  sh(['remote', 'add', 'origin', remote], root);
  return root;
}

test('sync on moves existing memory into the board and links it', () => {
  const root = project();
  const mem = memoryDir(root);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [a](a.md)\n');
  fs.writeFileSync(path.join(mem, 'a.md'), 'local a\n');
  cli(['init'], root);
  const pm = pmDir(root);
  fs.mkdirSync(path.join(pm, 'memory'));
  fs.writeFileSync(path.join(pm, 'memory', 'a.md'), 'board a\n');

  const out = cli(['sync', 'on', '--yes'], root).out;
  assert.match(out, /memory linked/);
  assert.match(out, /clashes kept as .*a\.md/);
  assert.equal(isLink(mem), true);
  assert.equal(fs.realpathSync(mem), fs.realpathSync(path.join(pm, 'memory')));
  assert.deepEqual(fs.readdirSync(path.join(pm, 'memory')).sort(), ['MEMORY.md', 'a.md', `a.${os.hostname()}.md`].sort());
  assert.equal(fs.readFileSync(path.join(pm, 'memory', 'a.md'), 'utf8'), 'board a\n');
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: link memory');
});

test('pm.syncMemory=false leaves memory untouched', () => {
  const root = project();
  const mem = memoryDir(root);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'x\n');
  sh(['config', 'pm.syncMemory', 'false'], root);
  cli(['init'], root);
  assert.doesNotMatch(cli(['sync', 'on', '--yes'], root).out, /memory linked/);
  assert.equal(isLink(mem), false);
});

test('linkMemory is idempotent and creates a missing link', () => {
  const root = project();
  cli(['init'], root);
  const pm = pmDir(root);
  assert.equal(linkMemory(root, pm).linked, true);
  assert.deepEqual(linkMemory(root, pm), { linked: true, moved: [], clashes: [] });
  assert.equal(isLink(memoryDir(root)), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/memory.test.mjs`
Expected: FAIL — `linkMemory` is not exported.

- [ ] **Step 3: Implement** — in `scripts/lib/sync.mjs` change the first imports to:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, tryGit, pmDir, memoryDir, today } from './paths.mjs';
```
and append:
```js
// readlink succeeds for symlinks and for Windows directory junctions.
export function isLink(p) {
  try {
    fs.readlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

export const memorySyncEnabled = (cwd) => tryGit(['config', '--get', 'pm.syncMemory'], cwd) !== 'false';

// Moves Claude Code's auto-memory into pm/memory and leaves a link in its place. Never deletes data.
export function linkMemory(cwd, pm) {
  const link = memoryDir(cwd);
  const target = path.join(pm, 'memory');
  fs.mkdirSync(target, { recursive: true });
  const result = { linked: false, moved: [], clashes: [] };
  if (isLink(link)) {
    result.linked = fs.realpathSync(link) === fs.realpathSync(target); // a link elsewhere is left alone
    return result;
  }
  if (fs.existsSync(link)) {
    for (const name of fs.readdirSync(link)) {
      const from = path.join(link, name);
      let to = path.join(target, name);
      if (fs.existsSync(to)) {
        if (fs.statSync(from).isFile() && fs.readFileSync(from).equals(fs.readFileSync(to))) continue;
        const ext = path.extname(name);
        to = path.join(target, `${path.basename(name, ext)}.${os.hostname()}${ext}`);
        result.clashes.push(name);
      }
      fs.cpSync(from, to, { recursive: true });
      result.moved.push(name);
    }
    fs.rmSync(link, { recursive: true }); // only after every entry was copied
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
  result.linked = true;
  return result;
}
```

- [ ] **Step 4: Link memory on `sync on`**

In `scripts/pm.mjs` change the sync import to:
```js
import { syncTarget, syncOn, syncOff, pushNow, conflictFiles, linkMemory, memorySyncEnabled } from './lib/sync.mjs';
```
and replace these two lines inside `sync(…)`:
```js
      const r = syncOn(cwd, url);
      return r.conflict ? conflictHelp(r.pm) : `sync on (${r.mode}): ${url} branch pm`;
```
with:
```js
      const r = syncOn(cwd, url);
      let mem = '';
      if (memorySyncEnabled(cwd)) {
        const m = linkMemory(cwd, r.pm);
        persist(r.pm, 'pm: link memory');
        mem = `\nmemory linked${m.moved.length ? ` (moved: ${m.moved.join(', ')})` : ''}`
          + `${m.clashes.length ? `; clashes kept as <name>.${os.hostname()}.md: ${m.clashes.join(', ')}` : ''}`;
      }
      return (r.conflict ? conflictHelp(r.pm) : `sync on (${r.mode}): ${url} branch pm`) + mem;
```
and add `import os from 'node:os';` as the second import line of `scripts/pm.mjs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS — all suites.

- [ ] **Step 6: Commit**

```bash
git add scripts/lib/sync.mjs scripts/pm.mjs test/memory.test.mjs
git commit -m "feat: sync auto-memory through a link into the board"
```

---

### Task 13: Hooks

**Files:**
- Create: `scripts/lib/hooks.mjs`, `test/hooks.test.mjs`
- Modify: `scripts/pm.mjs` (import + `hook` command), `hooks/hooks.json` (all five events)

**Interfaces:**
- Consumes: paths, store (`hasBoard`, `commitPm`, `isSyncOn`, `persist`), tasks (`listTasks`, `appendLogLine`, `validate`), `writeBoard`, `buildSummary`, sync (`pull`, `conflictFiles`, `unpushedOverDay`, `sharedBoardHint`, `linkMemory`, `memorySyncEnabled`).
- Produces: `STALE_MINUTES = 20`, `PLAN_PATTERNS: RegExp[]`, `onSessionStart(input, cwd): string`, `onPostToolUse(input, cwd): string`, `onStop(input, cwd, now = Date.now()): string`, `onSafetyNote(input, cwd, event): string`. Every handler returns the exact stdout to print (possibly `''`).

If Task 1 Spike B showed that `additionalContext` does not reach the model, emit `JSON.stringify({ decision: 'block', reason: text })` in `onPostToolUse` instead of the `hookSpecificOutput` form, and adjust the two post-tool-use assertions accordingly. If Spike A found a different command form, use it in `hooks/hooks.json`.

- [ ] **Step 1: Write the failing tests**

`test/hooks.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp, sh, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';
import { onSessionStart, onPostToolUse, onStop, onSafetyNote, STALE_MINUTES } from '../scripts/lib/hooks.mjs';

const MIN = 60_000;

test('no board: hooks are silent; shared-board hint when origin/pm exists', () => {
  const { root } = setup();
  assert.equal(onSessionStart({ session_id: 's' }, root), '');
  assert.equal(onStop({}, root), '');
  assert.equal(onPostToolUse({ tool_name: 'ExitPlanMode' }, root), '');
  assert.equal(onSafetyNote({ session_id: 's' }, root, 'session-end'), '');
  sh(['update-ref', 'refs/remotes/origin/pm', 'HEAD'], root);
  assert.match(onSessionStart({ session_id: 's' }, root), /shared board/);
  assert.equal(onSessionStart({}, tmp()), '');
});

test('session start prints the summary, records state, surfaces problems', () => {
  const { root } = setup();
  cli(['init'], root);
  const out = onSessionStart({ session_id: 'abc' }, root);
  assert.match(out, /^\[pm\] /);
  assert.match(out, /\nRules:/);
  assert.ok(fs.existsSync(path.join(pmDir(root), '.state', 'session-abc.json')));
  cli(['task', 'new', '--title', 'x'], root);
  cli(['set', 'T-001', 'depends_on=T-404'], root);
  assert.match(onSessionStart({ session_id: 'abc' }, root), /board problems: T-001: depends on unknown T-404/);
});

test('post-tool-use: plan files nudge, pm files rebuild the board, others are ignored', () => {
  const { root } = setup();
  cli(['init'], root);
  const pm = pmDir(root);
  const plan = path.join(root, 'docs', 'superpowers', 'plans', 'x.md');
  const nudge = JSON.parse(onPostToolUse({ tool_name: 'Write', tool_input: { file_path: plan } }, root));
  assert.match(nudge.hookSpecificOutput.additionalContext, /plan updated: .*x\.md — reconcile with the board/);
  const mode = JSON.parse(onPostToolUse({ tool_name: 'ExitPlanMode', tool_input: {} }, root));
  assert.match(mode.hookSpecificOutput.additionalContext, /plan mode/);
  fs.rmSync(path.join(pm, 'board.html'));
  assert.equal(onPostToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(pm, 'tasks', 'T-001.md') } }, root), '');
  assert.ok(fs.existsSync(path.join(pm, 'board.html')));
  assert.equal(onPostToolUse({ tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.js') } }, root), '');
});

test('stop: blocks once when code changed and the board is stale', () => {
  const { root } = setup();
  cli(['init'], root);
  const later = Date.now() + 120 * MIN;
  assert.equal(onStop({}, root, later), '', 'stale board but no code change');
  const f = path.join(root, 'new.js');
  fs.writeFileSync(f, 'x');
  fs.utimesSync(f, new Date(later - MIN), new Date(later - MIN));
  const block = JSON.parse(onStop({}, root, later));
  assert.equal(block.decision, 'block');
  assert.match(block.reason, /board/);
  assert.equal(onStop({}, root, later + 1000), '', 'throttled');
  const afterWindow = later + 2 * STALE_MINUTES * MIN;
  assert.equal(onStop({ stop_hook_active: true }, root, afterWindow), '');
  assert.notEqual(onStop({}, root, afterWindow), '');
});

test('stop: silent while the board is fresh', () => {
  const { root } = setup();
  cli(['init'], root);
  fs.writeFileSync(path.join(root, 'new.js'), 'x');
  assert.equal(onStop({}, root), '');
});

test('pre-compact appends an auto note to in-progress tasks of this worktree only', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'mine'], root);
  cli(['claim', 'T-001'], root);
  cli(['task', 'new', '--title', 'other'], root);
  cli(['set', 'T-002', 'status=in_progress', 'worktrees=other-wt'], root);
  onSessionStart({ session_id: 's1' }, root);
  const f = path.join(root, 'feature.js');
  fs.writeFileSync(f, 'x');
  const future = new Date(Date.now() + MIN);
  fs.utimesSync(f, future, future);
  assert.equal(onSafetyNote({ session_id: 's1' }, root, 'pre-compact'), '');
  const pm = pmDir(root);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), /auto: changed files: feature\.js · last commit: \w+ init/);
  assert.doesNotMatch(fs.readFileSync(path.join(pm, 'tasks', 'T-002.md'), 'utf8'), /auto:/);
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: auto pre-compact');
});

test('hook entry point always exits 0', () => {
  const { root } = setup();
  const input = JSON.stringify({ session_id: 'x', cwd: root });
  assert.equal(cli(['hook', 'session-start'], root, { input }).code, 0);
  assert.equal(cli(['hook', 'no-such-event'], root, { input: '{}' }).code, 0);
  assert.equal(cli(['hook', 'stop'], root, { input: 'not json' }).code, 0);
  cli(['init'], root);
  const r = cli(['hook', 'session-start'], root, { input });
  assert.equal(r.code, 0);
  assert.match(r.out, /^\[pm\]/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/hooks.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the handlers**

`scripts/lib/hooks.mjs`:
```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryGit, pmDir, worktreeName, today } from './paths.mjs';
import { hasBoard, commitPm, isSyncOn, persist } from './store.mjs';
import { listTasks, appendLogLine, validate } from './tasks.mjs';
import { writeBoard } from './board.mjs';
import { buildSummary } from './summary.mjs';
import { pull, conflictFiles, unpushedOverDay, sharedBoardHint, linkMemory, memorySyncEnabled } from './sync.mjs';

// ponytail: one global threshold; per-project config only if users ask for it.
export const STALE_MINUTES = 20;
export const PLAN_PATTERNS = [
  /\/docs\/superpowers\/(plans|specs)\//,
  /\/docs\/designs\//,
  /\/\.claude\/plans\//,
  /\/\.gstack\/projects\/[^/]+\/ceo-plans\//,
  /\/\.dev-cycle\/tasks\//,
];
const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const HINT = '[pm] this repo has a shared board (branch pm) — say "connect the board" to use it';

const stateFile = (pm, name) => path.join(pm, '.state', `${String(name).replace(/[^\w.-]/g, '_')}.json`);
function readState(pm, name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(pm, name), 'utf8'));
  } catch {
    return {};
  }
}
function writeState(pm, name, value) {
  fs.mkdirSync(path.join(pm, '.state'), { recursive: true });
  fs.writeFileSync(stateFile(pm, name), JSON.stringify(value));
}

const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (file, dir) => norm(file).startsWith(norm(dir) + path.sep);

function dirtyFilesSince(cwd, since) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  const entries = (tryGit(['status', '--porcelain', '-z'], cwd) ?? '').split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry[0] === 'R' || entry[0] === 'C') i += 1; // next entry is the rename/copy source
    const rel = entry.slice(3);
    try {
      if (fs.statSync(path.join(top, rel)).mtimeMs > since) files.push(rel);
    } catch {
      // deleted file: no mtime to compare
    }
  }
  return files;
}

function committedSince(cwd, head) {
  if (!head) return [];
  return (tryGit(['diff', '--name-only', `${head}..HEAD`], cwd) ?? '').split('\n').filter(Boolean);
}

function lastBoardUpdate(pm, worktree) {
  const files = [
    path.join(pm, 'PLAN.md'),
    path.join(pm, 'decisions.md'),
    ...listTasks(pm).filter((t) => t.data.worktrees.includes(worktree)).map((t) => t.file),
  ];
  return Math.max(0, ...files.filter((f) => fs.existsSync(f)).map((f) => fs.statSync(f).mtimeMs));
}

function codeChangedSince(cwd, since) {
  const headTime = Number(tryGit(['log', '-1', '--format=%ct'], cwd) || 0) * 1000;
  return headTime > since || dirtyFilesSince(cwd, since).length > 0;
}

export function onSessionStart(input, cwd) {
  const pm = pmDir(cwd);
  if (!pm) return '';
  if (!hasBoard(cwd)) return sharedBoardHint(cwd) ? HINT : '';
  let status = '';
  if (isSyncOn(pm)) {
    commitPm(pm, 'pm: session start');
    if (pull(pm) === 'conflict') status = `[pm] sync conflict in ${(conflictFiles(pm) ?? []).join(', ')} — run: pm sync`;
    if (memorySyncEnabled(cwd)) linkMemory(cwd, pm);
    const unpushed = unpushedOverDay(pm);
    if (!status && unpushed) status = `[pm] ${unpushed} board commits not pushed for over a day — run: pm sync`;
  }
  writeBoard(pm);
  const problems = validate(listTasks(pm));
  if (!status && problems.length) status = `[pm] board problems: ${problems.slice(0, 3).join('; ')} — run: pm validate`;
  writeState(pm, `session-${input.session_id}`, { start: Date.now(), head: tryGit(['rev-parse', 'HEAD'], cwd) });
  return buildSummary({ pm, worktree: worktreeName(cwd), scriptPath: PM_SCRIPT, statusLine: status });
}

export function onPostToolUse(input, cwd) {
  const pm = pmDir(cwd);
  if (!pm || !hasBoard(cwd)) return '';
  const file = String(input.tool_input?.file_path ?? '');
  if (file && inside(file, pm)) {
    writeBoard(pm);
    return '';
  }
  const slashed = file.replace(/\\/g, '/');
  if (input.tool_name !== 'ExitPlanMode' && !PLAN_PATTERNS.some((re) => re.test(slashed))) return '';
  const additionalContext = `[pm] plan updated: ${file || 'plan mode'} — reconcile with the board (coarse items + link).`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } });
}

export function onStop(input, cwd, now = Date.now()) {
  const pm = pmDir(cwd);
  if (!pm || !hasBoard(cwd)) return '';
  persist(pm, 'pm: stop');
  if (input.stop_hook_active) return '';
  const worktree = worktreeName(cwd);
  const updated = lastBoardUpdate(pm, worktree);
  const stateName = `stop-${worktree}`;
  const { lastBlock = 0 } = readState(pm, stateName);
  const windowMs = STALE_MINUTES * 60_000;
  if (now - updated < windowMs || now - lastBlock < windowMs || !codeChangedSince(cwd, updated)) return '';
  writeState(pm, stateName, { lastBlock: now });
  return JSON.stringify({
    decision: 'block',
    reason: `[pm] Code changed but the board was not updated for ${STALE_MINUTES}+ minutes. Append a Log entry (did/next) to this worktree's in-progress task, or create/claim a task for this work, or reply that there is nothing to track.`,
  });
}

export function onSafetyNote(input, cwd, event) {
  const pm = pmDir(cwd);
  if (!pm || !hasBoard(cwd)) return '';
  const stateName = `session-${input.session_id}`;
  const { start = Date.now(), head = null } = readState(pm, stateName);
  const worktree = worktreeName(cwd);
  const files = [...new Set([...committedSince(cwd, head), ...dirtyFilesSince(cwd, start)])];
  if (files.length) {
    const shown = files.slice(0, 10).join(', ') + (files.length > 10 ? ` (+${files.length - 10} more)` : '');
    const last = tryGit(['log', '-1', '--format=%h %s'], cwd) ?? 'none';
    const line = `- ${today()} · ${worktree} · auto: changed files: ${shown} · last commit: ${last}`;
    for (const t of listTasks(pm)) {
      if (t.data.status === 'in_progress' && t.data.worktrees.includes(worktree)) appendLogLine(pm, t.id, line, today());
    }
    writeState(pm, stateName, { start: Date.now(), head: tryGit(['rev-parse', 'HEAD'], cwd) }); // next note covers only new changes
  }
  persist(pm, `pm: auto ${event}`);
  return '';
}
```

- [ ] **Step 4: Add the `hook` command**

In `scripts/pm.mjs`:
1. Add `import fs from 'node:fs';` as the first import line.
2. Add after the sync import line:
```js
import { onSessionStart, onPostToolUse, onStop, onSafetyNote } from './lib/hooks.mjs';
```
3. Add this entry to `commands`, directly before `summary(cwd) {`:
```js
  // Hooks must never break a session: every path returns normally, errors are swallowed.
  hook(cwd, [event]) {
    let input = {};
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
      // no or malformed stdin
    }
    const at = input.cwd || cwd;
    const handlers = {
      'session-start': () => onSessionStart(input, at),
      'post-tool-use': () => onPostToolUse(input, at),
      stop: () => onStop(input, at),
      'pre-compact': () => onSafetyNote(input, at, 'pre-compact'),
      'session-end': () => onSafetyNote(input, at, 'session-end'),
    };
    try {
      return handlers[event]?.() ?? '';
    } catch (e) {
      if (process.env.PM_DEBUG) console.error(e);
      return '';
    }
  },

```

- [ ] **Step 5: Register all hooks** — replace `hooks/hooks.json` with:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear|compact",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook session-start", "timeout": 15 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit|ExitPlanMode",
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook post-tool-use", "timeout": 10 }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook stop", "timeout": 10 }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook pre-compact", "timeout": 10 }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs\" hook session-end", "timeout": 10 }]
      }
    ]
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node --test`
Expected: PASS — all suites.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/hooks.mjs scripts/pm.mjs hooks/hooks.json test/hooks.test.mjs
git commit -m "feat: session, plan, stop and safety-note hooks"
```

---

### Task 14: The `/pm` skill

**Files:**
- Create: `skills/pm/SKILL.md`

**Interfaces:**
- Consumes: CLI commands and formats from Tasks 9–13; summary rules from Task 8.

- [ ] **Step 1: Write the skill**

`skills/pm/SKILL.md`:
````markdown
---
name: pm
description: Project memory for this repo — accepted plan, task board (statuses, order, dependencies), decision log and session handoff that survive across sessions and worktrees. Use when starting or resuming work; when the user says "what's next", "take the next one", "break it down", "remember …", "we're done", "continue in a new session", "the plan changes", "waiting for …", "undo T-007", "enable board sync", "connect the board" (Russian: "что дальше", "бери следующую", "разбей", "запомни", "закончили", "продолжим в новой сессии", "план меняется", "ждём", "откати", "включи синхронизацию доски", "подключи доску"); when a task is finished or partially finished; and when a plan from another tool was just written.
---

# pm — project memory

The board lives outside the repo's branches, shared by every worktree of this repo on this machine:
`<claude-home>/projects/<repo-key>/pm/`. The session summary injected at session start shows the exact
command to run the CLI; below it is written as `pm`. Run it from inside the project.

## What is where

| File | Content | How to change it |
|---|---|---|
| `PLAN.md` | goal, milestones, `## Current focus`, `## Changelog` | edit in place, then append `- <date> · <what changed> · <why> · D-NNN` to Changelog |
| `tasks/T-NNN.md` | frontmatter + `## Goal`, `## Understanding`, `## Checklist`, `## Log` | CLI for frontmatter and Log; edit Goal / Understanding / Checklist directly |
| `decisions.md` | append-only `## D-NNN · date · title` entries | `pm decision` only |
| `memory/` | Claude Code auto-memory (only when sync is on) | as usual |
| `BOARD.md`, `board.html` | generated views | never edit |

Statuses: `todo | in_progress | waiting | done | dropped`. "Waiting on another task" is `depends_on`,
not a status; `waiting` is for external blockers and needs `waiting_on`. Ready = `todo` with all
dependencies `done`/`dropped`. A task fits one branch/PR; fine-grained steps live in a linked plan file.
`## Log` stays the last section of a task file.

## Protocol

| Situation | Do this |
|---|---|
| "what's next?", "take the next one", or a session starts with no active task | `pm ready`; take the first (or the named) task; `pm claim T-NNN`; write `## Understanding` first (how you read the task, open questions). A blocking question → `pm set T-NNN status=waiting waiting_on="…"` and ask it. |
| "break it down", a large request | Create board tasks with `pm task new --title … --order N --deps …`; put detail in a superpowers plan (if installed) and link it with `--links`. |
| During work | Refinements → `## Understanding`. A real decision → `pm decision --title … --why … --rejected …`. |
| You believe the task is done | Definition of done: checklist closed AND verification actually ran (tests, a run of the app). Then ask "what's left?": every leftover becomes `pm task new … --deps T-NNN`. Only then `pm set T-NNN status=done`. If anything is unfinished, say "partially done", keep the status, and `pm log … --next "<exact next step>"`. |
| "we're done", "continue in a new session" | For every in-progress task of this worktree: `pm log T-NNN --did "…" --next "<exact next step>"`. Update `## Current focus` if it moved. Tell the user `/clear` is safe — the next session starts from the summary. |
| "remember …" | Exactly one place: a decision → `pm decision`; a durable fact about the user or project → auto-memory; a detail of a task → that task's `## Understanding`. |
| "the plan changes" | Edit `PLAN.md`, append a Changelog line, record a decision. |
| "waiting for …" | `pm set T-NNN status=waiting waiting_on="…"`. |
| "undo T-007", "undo that" | `git -C <pm dir> log --oneline -5`, then `git -C <pm dir> revert --no-edit <sha>` for the board change in question; `pm board`. |
| A `[pm] plan updated: <path>` line appears | Reconcile: new coarse items → tasks with a link to the plan; items removed from the plan → `status=dropped`. Do not copy the plan's content. |
| No board yet and non-trivial multi-step work starts | `pm init`, fill `PLAN.md` (goal, milestones, focus), `pm scan` and import old plans (all boxes ticked → done, some → in_progress, none → todo). Announce it in the board diff line. |
| "enable board sync" / "connect the board" | Run `pm sync on` (no `--yes`) and show the user where the board and memory will be pushed. Only after the user says yes: `pm sync on --yes`. Never enable sync on your own initiative. |
| "disable board sync" | `pm sync off`. |
| `[pm] sync conflict …` in the summary | Run `pm sync`, follow its instructions, merge the listed markdown files by hand keeping both sides' information, then `pm sync` again. |
| `[pm] Code changed but the board was not updated …` (Stop hook) | Log progress on the active task, or create/claim one, or reply that there is nothing to track. |

## Rules

- End every turn that changed the board with one line in the user's language, for example:
  `board: T-003 → done · new T-007 "data migration" (after T-005) · D-004`.
- Only the main agent writes the board. Subagents return results; you record them.
- Use the CLI for ids, statuses, logs and decisions; edit prose sections directly.
- Write free text (titles, understanding, log, decisions, plan) in the user's language.
- Keep the Log honest: `did:` is what actually happened, `next:` is concrete enough to start without re-reading the whole conversation.

## CLI

```
pm init                                         create the local board
pm task new --title T [--order N] [--deps T-001,T-002] [--milestone M1] [--links a,b]
pm set T-003 key=value ...                      status, order, depends_on, waiting_on, milestone, links, title
pm claim T-003                                  attach this worktree, status in_progress
pm log T-003 --did "..." --next "..."           append a Log entry
pm decision --title T --why W --rejected R [--tasks T-001]
pm ready | pm validate | pm board | pm summary | pm scan
pm sync on [--remote url] [--yes] | pm sync off | pm sync
```
````

- [ ] **Step 2: Verify the skill loads**

Run (bash) from any git repo:
```bash
claude -p 'List the skills available to you whose name is exactly "pm" and quote the first sentence of its description. If none, print NONE.' --plugin-dir "<absolute path of this repo>"
```
Expected: the `pm` skill with its description.

- [ ] **Step 3: Commit**

```bash
git add skills/pm/SKILL.md
git commit -m "feat: /pm skill with the board protocol"
```

---

### Task 15: README, license and CI

**Files:**
- Create: `README.md`, `LICENSE`, `.github/workflows/test.yml`

- [ ] **Step 1: Write the license**

`LICENSE`:
```
MIT License

Copyright (c) 2026 ZizzX

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Write CI**

`.github/workflows/test.yml`:
```yaml
name: test
on:
  push:
  pull_request:
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - run: node --test
```

- [ ] **Step 3: Write the README**

`README.md`:
````markdown
# project-memory

A Claude Code plugin that gives every git repository a memory Claude actually uses:
an accepted **plan**, a **task board** with statuses, order and dependencies, a **decision log**
(what, why, what was rejected) and a **session handoff** — so a new session, in any worktree,
starts knowing where work stopped and what the next step is.

- **Automatic.** Hooks inject a short board summary at every session start, nudge Claude when a
  plan file changes, remind it when code changed but the board did not, and write a safety note
  before context compaction or session end.
- **Autonomous.** Claude creates tasks, moves statuses, logs work and records decisions itself,
  ending each turn that changed the board with a one-line diff.
- **Worktree-friendly.** The board lives outside your branches, one per repo, shared by all
  worktrees on the machine.
- **Local by default.** Nothing leaves your machine unless you enable sync for a project.
- **Zero dependencies.** Node ≥ 20 and git. Windows, macOS, Linux.

## Install

```
/plugin marketplace add ZizzX/claude-project-memory
/plugin install project-memory@project-memory
```

## Use

Just work. In a repo with a board, every session starts with a summary like:

```
[pm] my-app · focus: M1 import pipeline · board: file:///…/pm/board.html
Your worktree (feature-csv):
  T-003 CSV import [in_progress] → next: handle empty rows (2026-09-12, feature-csv)
Ready: T-004 validation · T-006 export
Waiting: T-005 ← answer about date format
Decisions: D-004 Store board outside branches · D-003 Own format
```

Useful phrases: "what's next?", "break it down", "remember …", "we're done",
"continue in a new session", "the plan changes", "undo T-007". Run `/pm` to see the protocol.
Open `board.html` in a browser for a kanban view that refreshes itself.

A board is created the first time you start non-trivial work in a repo (or say "create a board").

## Where things live

```
~/.claude/projects/<repo-key>/pm/     (or $CLAUDE_CONFIG_DIR/projects/…)
  PLAN.md  tasks/T-NNN.md  decisions.md  BOARD.md  board.html
```

It is a small git repository: every board change is a commit, so any change can be reverted.

## Sync across machines (opt-in)

Say "enable board sync" (or run `pm sync on`). Claude shows where the board will be pushed and waits
for your yes. The board is pushed to branch `pm` of the project's own remote, and Claude Code's
auto-memory for the project moves into the board and syncs with it.

On another machine, install the plugin and open the project: the summary says the repo has a shared
board; say "connect the board". Nothing is ever connected automatically.

### Privacy

- Nothing is pushed until you enable sync for that project.
- With sync on, the board **and the project's auto-memory** are pushed to branch `pm` of the project's
  remote. If that repository is public, they become public — use `pm sync on --remote <private-url>`.
- Keep memory local while syncing the board: `git config pm.syncMemory false` before enabling sync.
- `pm sync off` stops syncing and keeps the local board.

## Coexisting with other memory tools

If you use other resume/memory mechanisms (session checkpoints, context-save skills, memory MCP
servers), consider disabling them once `/pm` works for you, so there is a single answer to
"where did we stop?". Plans written by superpowers, gstack, plan mode or dev-cycle are picked up
by the board automatically.

## Development

```
node --test                          # run all tests
claude --plugin-dir .                # try the plugin without installing
```

## License

MIT
````

- [ ] **Step 4: Run the full suite**

Run: `node --test`
Expected: PASS — all suites.

- [ ] **Step 5: Commit**

```bash
git add README.md LICENSE .github/workflows/test.yml
git commit -m "docs: README, MIT license and CI on Windows, macOS, Linux"
```

---

### Task 16: Dogfood, push, CI

Needs the owner for the interactive steps.

**Files:**
- None created in the repo; the board lives in `<claude-home>/projects/<repo-key>/pm/`.

- [ ] **Step 1: Push and check CI**

```bash
git push origin ai-agent-memory-system
gh run list --branch ai-agent-memory-system --limit 1
gh run watch "$(gh run list --branch ai-agent-memory-system --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```
Expected: all 6 matrix jobs green. On a failure: `gh run view --log-failed`, fix with a test-first change, commit, push, repeat.

- [ ] **Step 2: Create this project's own board**

From the worktree:
```bash
node scripts/pm.mjs init
node scripts/pm.mjs decision --title "Board outside branches, one per repo" --why "worktree-per-task workflow" --rejected "in-branch Backlog.md / Beads"
node scripts/pm.mjs decision --title "Local by default, opt-in sync via branch pm" --why "no surprises for collaborators" --rejected "auto sync, personal boards repo, cloud folder"
node scripts/pm.mjs decision --title "Hooks + skill, not a skill alone" --why "a skill depends on the model remembering to invoke it" --rejected "skill only, MCP server"
node scripts/pm.mjs task new --title "Install the plugin on Windows and use it for a week" --milestone M1
node scripts/pm.mjs task new --title "Enable sync for this project and connect the MacBook" --deps T-001 --milestone M1
node scripts/pm.mjs task new --title "Retire overlapping memory mechanisms (spec §11)" --deps T-001 --milestone M1
node scripts/pm.mjs task new --title "Make the GitHub repo public and tag v0.1.0" --deps T-001,T-002 --milestone M2
node scripts/pm.mjs summary
```
Then edit `PLAN.md` in the printed board folder: fill `## Goal`, `## Milestones` (`- M1 dogfood — active`, `- M2 public release — planned`), and `## Current focus` (`M1 dogfood on Windows`).
Expected: the summary lists four tasks, T-001 ready.

- [ ] **Step 3: Owner installs the plugin locally**

Ask the owner to run in Claude Code:
```
/plugin marketplace add C:\Users\USER\orca\workspaces\ai-memory\ai-agent-memory-system
/plugin install project-memory@project-memory
```
then start a new session in this worktree.
Expected: the first context contains the `[pm] …` summary for this project; `/pm` shows the skill.

- [ ] **Step 4: Verify the multi-worktree behaviour**

Ask the owner to open a session in a second worktree of the same repo.
Expected: the same board and tasks appear in the summary, with "Your worktree (…)" naming the second worktree.

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch to decide with the owner how to integrate `ai-agent-memory-system` into `master` (PR on GitHub or local merge). Publishing the repository and tagging `v0.1.0` stay on the board as T-004 and happen only with the owner's explicit approval.
