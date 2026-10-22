# /close, learnings and audit — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `/close` ritual with a mandatory retro checkpoint and a chosen next task, a per-project `learnings/` store deduplicated on write and surfaced at session start, and a deterministic `pm audit`.

**Architecture:** Two new modules in `scripts/lib/` (`learn.mjs`, `audit.mjs`), small additions to `tasks.mjs` (`next`, `waiting_since`, `startNumber`), `summary.mjs` (three lines), `hooks.mjs` (weekly audit count), new CLI verbs in `pm.mjs`, one new command (`/close`) and one new skill (`retro`). Everything is files in the existing pm git repo.

**Tech Stack:** Node ≥ 20 ESM, no dependencies, `node --test`, existing helpers in `test/helpers.mjs` (`setup`, `cli`, `tmp`, `pmOf`).

**Spec:** `docs/superpowers/specs/2026-10-22-close-learnings-audit-design.md`

## Global Constraints

- Node ≥ 20, zero dependencies; Windows: `normPath`, `\r\n` tolerated on read, `windowsHide: true` on spawns.
- Hooks never throw; new SessionStart work is wrapped in try/catch like `mergeAtStart`.
- Summary stays within `MAX_LINES = 40`; new lines are optional and ≤ 5 items each.
- Frontmatter is the restricted format of `frontmatter.mjs`: `key: value`, `key: [a, b]`, `key: ""`.
- Ids: `L-NNN`; pattern `^[a-z0-9]+(\.[a-z0-9-]+)+$`; statuses `active | promoted | retired`.
- Cap 100 active learnings; promotion threshold `seen ≥ 3 && distinct tasks ≥ 2`.
- Audit thresholds: stuck 14 d, waiting 30 d, next 30 d, state files 7 d, unused learning 90 d, cap warning at 80, retro window 30 d, SessionStart audit every 7 d.
- CLI output: one line per fact, each names the next command when there is one.
- Every CLI verb and every finding has a `node --test` test.

## Review Focus

1. A task file written before this version (no `next`, no `waiting_since`) must read, validate and audit without a new frontmatter line appearing on an untouched save — Task 1 test "old files gain no fields".
2. `pm learn add` run twice in one retro for the same task and pattern must not inflate `seen` — Task 3 test "repeat on the same day is a no-op".
3. A board synced from another machine: `pm audit --fix` must not strip that machine's worktrees — Task 5 test "dead-worktree is list-only when sync is on".
4. A learning body or title in Russian with `:` or `#` in the title must survive serialize/parse — Task 3 test "title with colon round-trips".
5. SessionStart with a corrupt `learnings/` file (no frontmatter) must still print the summary — Task 4 test "a broken learning file does not break the summary".

---

### Task 1: `next`, `waiting_since`, `startNumber` in tasks.mjs

**Files:**
- Modify: `scripts/lib/tasks.mjs` (readConfig/nextNumber, setFields, new `setNext`, `clearNext`)
- Modify: `scripts/pm.mjs` (`prefix --start`, new `next` verb, `claim` clears next)
- Test: `test/next.test.mjs`, `test/tasks.test.mjs`

**Interfaces:**
- Produces: `setNext(pm, id, date) → task` (throws unless status `todo`; clears `next` on other tasks with the same `data.epic`), `clearNext(pm, id?)` (one or all), `nextTask(tasks, epic) → task|undefined`, `nextNumber(pm)` honours `config.startNumber`, `setFields` sets `waiting_since` on entering `waiting` and deletes it on leaving, deletes `next` when status leaves `todo`.

- [ ] **Step 1: Write failing tests in `test/next.test.mjs`**

```js
test('pm next marks one todo task per epic and claim clears it', () => {
  // setup(); cli init; three tasks: T-001 epic A, T-002 epic A, T-003 no epic
  // cli(['next','T-001']) → out matches /T-001 ← next/
  // cli(['next','T-002']) → T-002 has next, T-001 has none
  // cli(['next','T-003']) → both T-002 and T-003 carry next (different epics)
  // cli(['claim','T-002']) → T-002 frontmatter has no `next:` line
  // cli(['next','T-002']) → code 1, err matches /only a todo task/
  // cli(['next','--clear']) → no task has next
});
test('waiting_since follows the waiting status', () => {
  // set status=waiting waiting_on=x → file has waiting_since: <today>
  // set status=todo → no waiting_since line
});
test('pm prefix --start continues numbering', () => {
  // cli(['prefix','PM','--start','61']) → task new → id PM-061; next → PM-062
});
test('old files gain no fields', () => {
  // write a task file by hand with the 0.10 field set, cli(['set','T-001','order=2']) → no next/waiting_since lines
});
```

- [ ] **Step 2: Run `node --test test/next.test.mjs` — expect FAIL (unknown command `next`)**

- [ ] **Step 3: Implement in `tasks.mjs`**: `readConfig` exported as `boardConfig(pm)`, `writeConfig(pm, patch)`; `nextNumber` = `Math.max(startNumber ?? 1, max+1)`; in `setFields`, after the status handling: `if (status !== 'todo') delete task.data.next`; `waiting_since` set when `status === 'waiting' && !task.data.waiting_since`, deleted when status is anything else. Add `setNext`, `clearNext`, `nextTask` (`tasks.find(t => t.data.next && t.data.epic === epic)`).

- [ ] **Step 4: Implement in `pm.mjs`**: `prefix(cwd, args)` parses `--start`; `next(cwd, args)`: `--clear` → `clearNext(pm)`; id → `setNext`, persist `pm: next <id>`, print `<id> ← next (<epic or repo-wide>)`. `claim` already goes through `setFields` with `status in_progress`, so `next` falls off there.

- [ ] **Step 5: Run `node --test test/next.test.mjs test/tasks.test.mjs` — expect PASS**

- [ ] **Step 6: Commit** `feat(PM-062): pm next, waiting_since and prefix --start`

---

### Task 2: summary and `pm ready` show the next task

**Files:**
- Modify: `scripts/lib/summary.mjs`, `scripts/pm.mjs` (`ready`)
- Test: `test/summary.test.mjs`

**Interfaces:**
- Consumes: `nextTask`, `readyQueue`.
- Produces: `Ready:` line begins with `T-00N title ← next` or `← next (after T-003)` when deps are open; `Elsewhere:` prints `@ (no worktree)` for an empty `worktrees`.

- [ ] **Step 1: Tests** — `summary puts the next task first`, `a blocked next task says what it waits for`, `an orphan in_progress task prints (no worktree)`. Assertions: `/Ready: T-002 b ← next · T-001 a/`, `/← next \(after T-001\)/`, `/Elsewhere: T-003 c @ \(no worktree\)/`.
- [ ] **Step 2: Run — expect FAIL**
- [ ] **Step 3: Implement**: in `buildSummary`, `const nx = nextTask(tasks, epic)`; build `ready` as `[nx, ...perEpic(queue).filter(t => t !== nx)].filter(Boolean).slice(0, 3)`; suffix function `nextTag(t)`. In `pm.mjs ready`, print the next task first when it is in the queue.
- [ ] **Step 4: Run `node --test test/summary.test.mjs test/cli.test.mjs` — PASS**
- [ ] **Step 5: Commit** `feat(PM-062): next task first in the summary and pm ready`

---

### Task 3: `learn.mjs` and `pm learn`

**Files:**
- Create: `scripts/lib/learn.mjs`
- Modify: `scripts/pm.mjs` (`learn` verb), `scripts/lib/tasks.mjs` (`appendRetro(pm, id, text, worktree, date)` merges into the same day's `retro:` line)
- Test: `test/learn.test.mjs`

**Interfaces:**
- Produces:
  - `learningsDir(pm)`, `listLearnings(pm) → [{file, id, data, body}]` (frontmatter scan via `parse`; a file that fails to parse is skipped), `readLearning(pm, id)`.
  - `addLearning(pm, {title, pattern, symptom, fix, apply, tasks, worktree, date}) → {id, created, seen, tasks, similar: [ids], promote: bool, note}`; dedupe on active pattern; retired → reactivated; promoted → `{created:false, note:'promoted to …'}` with no write; cap 100.
  - `findLearnings(pm, words) → [learnings]`, `promoteLearning(pm, id, to, date)`, `retireLearning(pm, id, why, date)`, `retroNone(pm, id, worktree, date)`, `checkRetro(pm, ids, date) → missing ids`, `promotable(l) → bool`, `PATTERN_RE`, `CAP = 100`, `PROMOTE = { seen: 3, tasks: 2 }`.
  - `setRetroSince(pm, date)` writes `config.retroSince` when absent (called by `addLearning` and `retroNone`).
  - Log line format: `- <date> · <worktree> · retro: none` / `retro: L-003, L-007`.

- [ ] **Step 1: Tests in `test/learn.test.mjs`** (through `cli` so the verb and output are covered):
  - `learn add creates L-001 with the three sections and a retro line on the task`
  - `learn add with a known pattern bumps seen and unions tasks` → `/L-001 seen 2 \(T-001, T-002\)/`
  - `repeat on the same day is a no-op` → `/already recorded today/`, seen stays
  - `a retired learning is reactivated`, `a promoted one is not written`
  - `bad pattern is refused` → `/pattern must look like area\.symptom/`
  - `similar patterns are hinted` (same `area.` prefix) → `/similar: L-001/`
  - `learn find matches title, pattern and body`
  - `learn none writes the checkpoint; learn check reports missing ids and exits 1`
  - `cap at 100 refuses the 101st`
  - `promotion hint at seen 3 across 2 tasks` → `/promote\?/`
  - `title with colon round-trips`
  - `retroSince is written once`
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement `learn.mjs`** — id reservation with `openSync(file,'wx')` like `newTask`; body template `## Symptom\n${s}\n\n## Fix\n${f}\n\n## Apply\n${a}\n`; near-match = active learning with the same first segment of `pattern`, or sharing a ≥5-letter word with the title (lowercase).
- [ ] **Step 4: `pm.mjs` `learn(cwd, [sub, ...args])`** with subs `add|list|show|find|promote|retire|none|check`; `persist(pm, 'pm: learn <sub> <id>')` for writes; `check` sets `process.exitCode = 1` when ids are missing.
- [ ] **Step 5: Run `node --test test/learn.test.mjs` — PASS**
- [ ] **Step 6: Commit** `feat(PM-063): pm learn — project learnings deduplicated by pattern`

---

### Task 4: learnings in the session summary

**Files:**
- Modify: `scripts/lib/summary.mjs`
- Test: `test/summary.test.mjs`

**Interfaces:**
- Consumes: `listLearnings`, `promotable`.
- Produces: optional `Learnings: L-007 title · …` (≤5; those whose `tasks` intersect the ids of `byEpic(tasks, epic)`, else newest by `last`) and `Promote: L-003 (seen 4 in 3 tasks)` after `Decisions:`.

- [ ] **Step 1: Tests** — `summary lists learnings of my epic first, newest last-date first, at most five`; `summary names promotable learnings`; `a broken learning file does not break the summary` (write `learnings/L-009.md` containing `garbage`, assert summary still has `Rules:`).
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — one `listLearnings(pm)` call, filtered `status === 'active'`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat(PM-063): learnings and promotion candidates in the session summary`

---

### Task 5: `audit.mjs`, `pm audit`, weekly count at session start

**Files:**
- Create: `scripts/lib/audit.mjs`
- Modify: `scripts/pm.mjs` (`audit` verb), `scripts/lib/hooks.mjs` (`onSessionStart` weekly line), `scripts/lib/tasks.mjs` (export `lastManualLogDate(task)` and `lastLogDate(task)`)
- Test: `test/audit.test.mjs`, `test/hooks.test.mjs`

**Interfaces:**
- Produces: `runAudit({pm, cwd, now = Date.now(), fix = false}) → {findings: [{code, id, text, fixable}], fixed: [string]}`; `AUDIT_DAYS = 7`; `auditLine(pm, cwd, now)` → `'[pm] audit: N findings — run: pm audit'` or `''`, recording `.state/audit.json {at}`.
- Codes exactly as the spec table: `stuck, waiting-long, review-no-pr, dead-worktree, orphan, next-stale, state-old, learning-unused, learning-promote, learning-dup, learnings-cap, decision-dropped, retro-missing`.
- Live worktrees: basenames from `git worktree list --porcelain` run in `cwd`; `dead-worktree` fixable only when `!isSyncOn(pm)`.

- [ ] **Step 1: Tests in `test/audit.test.mjs`** — one test per code with a fabricated date (`now` injected), plus `audit: clean`, `--fix removes old state files, dead worktrees and stale next, and commits`, `dead-worktree is list-only when sync is on` (add an origin remote to the pm repo), `retro-missing only after retroSince`.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement `audit.mjs`**; output line format `<code> <id> — <what> — <fix or hint>`; `--fix` prints `fixed: …` lines and commits `pm: audit --fix`.
- [ ] **Step 4: `hooks.mjs`**: after the merge check, `try { audit = auditLine(pm, cwd) } catch {}`; append to `statusLine`. Test in `test/hooks.test.mjs`: `session start counts the audit once a week` (first start prints the line when a finding exists, a second start within the window does not).
- [ ] **Step 5: Run `node --test test/audit.test.mjs test/hooks.test.mjs` — PASS**
- [ ] **Step 6: Commit** `feat(PM-064): pm audit — stale tasks, dead worktrees, unused learnings; weekly count at session start`

---

### Task 6: `/close`, `retro` skill, pm skill and help

**Files:**
- Create: `commands/close.md`, `skills/retro/SKILL.md`
- Modify: `skills/pm/SKILL.md` (description → triggers only; protocol rows; CLI block), `scripts/pm.mjs` (`USAGE`, `PHRASES`), `.claude-plugin/plugin.json` (0.11.0)
- Delete: `docs/PROGRESS.md`
- Test: `test/cli.test.mjs` (help lists the new verbs)

- [ ] **Step 1: Test** — `pm help names learn, next, audit and the close phrases`.
- [ ] **Step 2: Write `commands/close.md`** per spec section "/close command": four numbered steps, each ending in a CLI call; the retro step ends with `pm learn check <ids>`; `--no-retro` runs `pm learn none` for each id; wrap-up lines; the three "never" rules.
- [ ] **Step 3: Write `skills/retro/SKILL.md`** per spec section "retro skill", ≤ 60 lines, frontmatter `name: retro`, description = triggers only.
- [ ] **Step 4: Edit `skills/pm/SKILL.md`**: description = one sentence + EN/RU phrases incl. "слил", "закрой сессию", "wrap up", "what did we learn", "что узнали нового", "audit", "аудит доски", "next session starts with", "в следующей сессии берём"; add protocol rows for `/close`, `Promote:`, `[pm] audit:`, "what did we learn"; CLI block gains `learn`, `next`, `audit`, `prefix --start`; "What is where" gains `learnings/L-NNN.md`.
- [ ] **Step 5: `pm.mjs` USAGE and PHRASES updated; version bump; `git rm docs/PROGRESS.md`.**
- [ ] **Step 6: Run full `node --test` — PASS; commit** `feat(PM-065): /close ritual, retro skill, pm skill triggers; 0.11.0`

---

### Task 7: README (EN, RU)

**Files:**
- Modify: `README.md`, `README.ru.md`

- [ ] **Step 1:** Replace "Ending a session" with "Closing a session" (the four `/close` steps, `--no-retro`, what the plugin never does), add "Learnings" (file shape, `pm learn` verbs, dedupe, promotion, cap) and "Audit" (table of codes, `--fix` scope, weekly line); update "Commands", "What to say", "Where things live", "Hooks" (SessionStart gains the audit count). RU mirrors EN section by section.
- [ ] **Step 2:** `node --test` still green (docs only); commit `docs(PM-066): README for /close, learnings and audit`.

---

## Self-review notes

- Spec coverage: data model → T1/T3; CLI verbs → T1/T3/T5; summary lines → T2/T4; `/close` + `retro` + SKILL/help/version/PROGRESS.md → T6; README → T7; dogfooding happens on the branch after T1 (`pm init`, `pm prefix PM --start 61`).
- Names used across tasks: `nextTask`, `setNext`, `clearNext`, `listLearnings`, `promotable`, `addLearning`, `checkRetro`, `runAudit`, `auditLine`, `lastManualLogDate` — defined once in their task's Interfaces block.
