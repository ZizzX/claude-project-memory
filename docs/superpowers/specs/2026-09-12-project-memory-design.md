# project-memory (`/pm`) — design

Date: 2026-09-12 · Status: approved in brainstorming, awaiting spec review

## 1. Problem

Claude Code sessions do not reliably remember project state. Findings on the owner's machine:

- The `MEMORY.md` protocol required by the global CLAUDE.md was never initialized in any of 10 projects:
  it is prose with no tooling behind it.
- Four unrelated "where did I stop" mechanisms exist and none reads another: token-optimizer
  checkpoints (automatic, low quality), gstack `/context-save` (manual, stored outside git, worktree slug
  bug), superpowers plan checkboxes (ticked unreliably), agentmemory MCP (configured, guide disabled).
- No task board with statuses, ordering and dependencies exists anywhere.

A skill alone does not fix this: it only works when the model remembers to invoke it. The fix must be
driven by hooks (deterministic) with a skill describing the protocol.

## 2. Goals

1. One accepted project plan that stays current, with a changelog of why it changed.
2. A task board: statuses, order, dependencies, per-task understanding, checklist and work log.
3. A decision log: what was decided, why, what was rejected.
4. Session handoff: every new session (any worktree) starts knowing where work stopped and the next step.
5. Full agent autonomy: the agent maintains all of the above itself and reports a one-line board diff.
6. Plans produced by other tools (superpowers, gstack, plan mode, dev-cycle) feed the board.
7. A human view: `BOARD.md` and a read-only HTML kanban `board.html`.

## 3. Non-goals (v1)

MCP server · drag-and-drop board editing · sync across machines · team sharing · multi-agent
orchestrator · modifying other skills/plugins · two-way sync with other tools' plan files.

## 4. Decisions already made

| # | Decision | Why |
|---|---|---|
| 1 | State lives outside branches in one shared per-repo folder | Owner works in Orca: one worktree+branch per task; in-repo state diverges across branches |
| 2 | Own minimal markdown format, not Backlog.md / Beads | Both store state in-repo, which contradicts #1 |
| 3 | Concurrency: usually one agent; sometimes several worktrees on one task | Tasks list attached worktrees; shared files are append-only; atomic ids |
| 4 | Full agent autonomy | Explicit-command discipline is exactly what fails today |
| 5 | Other tools' plans stay where they are; board gets coarse items + a link | One source of truth for status; no duplicated content; other skills stay unpatched |

## 5. Storage

### 5.1 Location

```
~/.claude/projects/<repo-key>/pm/
```

- Main worktree root = parent directory of `git rev-parse --path-format=absolute --git-common-dir`.
  All worktrees of a repo resolve to the same root.
- `<repo-key>` = main worktree root with every character outside `[A-Za-z0-9]` replaced by `-`
  (e.g. `C:\Users\Aziz\orca\projects\ai-memory` → `C--Users-Aziz-orca-projects-ai-memory`). This must
  equal the key Claude Code uses for auto-memory, so `pm/` sits next to `memory/`. Verified by test
  against real directories, including a path with non-ASCII characters.
- Outside a git repository `/pm` is inactive (hooks print nothing).
- Current worktree name = basename of `git rev-parse --show-toplevel`.

### 5.2 Layout

```
pm/
  .git/                 local history (not pushed anywhere); enables undo
  PLAN.md               accepted plan
  tasks/T-001-slug.md   one file per task
  decisions.md          append-only decision log
  BOARD.md              generated, never hand-edited
  board.html            generated, never hand-edited
  .state/               hook bookkeeping (gitignored)
```

### 5.3 Content language

Keys, ids, statuses and section headings are English. Free text (titles, understanding, log,
decisions, plan) is written in the language the owner uses in chat (Russian).

### 5.4 `PLAN.md`

```markdown
# <Project name>

## Goal
<what we are building and for whom — a few lines>

## Milestones
- M1 <title> — active
- M2 <title> — planned

## Current focus
<one line; read by the session summary>

## Changelog
- 2026-09-12 · <what changed> · <why> · D-004
```

Edited in place; every edit appends one changelog line.

### 5.5 Task file `tasks/T-003-csv-import.md`

```markdown
---
id: T-003
title: CSV import
status: in_progress
order: 3
depends_on: [T-001]
waiting_on: ""
worktrees: [ai-agent-memory-system]
milestone: M1
links: [docs/superpowers/plans/2026-09-12-csv-import.md]
updated: 2026-09-12
---
## Goal
<outcome + acceptance criteria>

## Understanding
<how the task is understood, clarifications, refinements, open questions>

## Checklist
- [ ] <coarse step>

## Log
- 2026-09-12 · ai-agent-memory-system · did: <what> · next: <exact next step>
```

- Frontmatter is a restricted subset parsed by the script: `key: value`, `key: [a, b]`, `key: ""`.
- `status` ∈ `todo | in_progress | waiting | done | dropped`.
- `waiting` means waiting on something external; `waiting_on` must be non-empty.
- Waiting on another task is not a status: it is expressed by `depends_on`.
- **Ready** (derived) = `status: todo` and every dependency is `done` or `dropped`, sorted by `order`.
  A `dropped` dependency is treated as resolved; `validate` warns about it.
- Size rule: one task fits one branch/PR. Checklist items are coarse; a growing item becomes its own task
  with `depends_on`. Fine-grained steps live in the linked plan file.
- **Handoff** = the last `Log` entry's `next:`. There is no separate handoff file.
- `Log` and `decisions.md` are append-only.

### 5.6 `decisions.md`

```markdown
## D-004 · 2026-09-12 · Store board outside branches
- why: <reason>
- rejected: <alternatives and why not>
- tasks: T-001, T-003
```

## 6. Script `scripts/pm.mjs`

Single file, Node ≥ 20, standard library only. Handles everything deterministic; the agent writes
prose sections with normal file edits.

| Command | Effect |
|---|---|
| `pm init` | Create `pm/` skeleton (`PLAN.md` template, `tasks/`, `decisions.md`, `.gitignore`), `git init`, print the path |
| `pm scan` | List plan files from other tools found for this repo (paths in §8) with checkbox counts done/total |
| `pm task new --title T [--order N] [--deps T-1,T-2] [--milestone M1] [--links p]` | Create the next `T-NNN-slug.md` from the template. Id is reserved by exclusive file create (`wx`), retrying on collision |
| `pm set T-003 key=value ...` | Update frontmatter fields, bump `updated` |
| `pm claim T-003` | Add the current worktree to `worktrees`, set `in_progress` |
| `pm log T-003 --did "..." --next "..."` | Append a dated, worktree-signed Log entry |
| `pm decision --title T --why W --rejected R [--tasks T-1]` | Append a complete `D-NNN` entry in one write |
| `pm ready` | Print the ready queue |
| `pm validate` | Report unknown dependencies, cycles, `waiting` without `waiting_on`, bad status values |
| `pm board` | Regenerate `BOARD.md` and `board.html` |
| `pm summary` | Print the session summary (§7.1) |
| `pm hook <event>` | Hook entry point: reads hook JSON from stdin (§7) |

Every mutating command regenerates the board and commits `pm/` to its local git
(`git add -A && git commit -m "pm: <command> <id>"`, one retry if `index.lock` is busy), so each change —
including the agent's direct prose edits made since the previous commit — is individually revertible.
All commands locate `pm/` via §5.1 from the current directory.

## 7. Hooks (`hooks/hooks.json`)

Each hook runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs" hook <event>`. If no board exists for the
repo, every hook exits 0 silently.

### 7.1 `SessionStart` (sources: startup, resume, clear, compact)

Stores `{session start time, HEAD}` in `.state/<session_id>.json` and prints the summary (hard
limit 40 lines):

```
[pm] <project> · focus: <Current focus> · board: file:///…/pm/board.html
Your worktree (<name>):
  T-003 CSV import [in_progress] → next: <last Log next:> (<date>)
Ready: T-004 <title> · T-006 <title> · T-007 <title>
Waiting: T-005 ← <waiting_on>
Decisions: D-004 <title> · D-003 <title> · D-002 <title>
Rules: maintain tasks/statuses/decisions yourself · end every turn that changed the board with
  "доска: …" · only the main agent writes pm/ · before "done" ask "what's left?" · details: /pm
```

Limits: all tasks of this worktree, first 3 ready, up to 5 waiting, last 3 decisions. The rules
digest is always included: it is what makes autonomy work without loading the full skill.

### 7.2 `PostToolUse` (matcher `Write|Edit|MultiEdit|ExitPlanMode`)

- If the edited path is inside `pm/`: regenerate the board (keeps `board.html` fresh after direct edits).
- If the edited path matches a plan location (§8), or the tool is `ExitPlanMode`: inject one line via
  `additionalContext`: `[pm] plan updated: <path> — reconcile with the board (coarse items + link).`

### 7.3 `Stop` — "board not updated" guard

First commits any uncommitted `pm/` changes (same commit rule as §6). Then blocks at most once per
throttle window with `{"decision":"block","reason":…}` when all hold:

- `stop_hook_active` is false;
- code changed: `git status --porcelain` is non-empty, or the HEAD commit time is newer than the last
  board update;
- board is stale: the latest board update touching this worktree (task files listing it,
  `decisions.md`, `PLAN.md`) is older than `STALE_MINUTES = 20`;
- no block was issued in the last `STALE_MINUTES` (tracked in `.state/`).

Reason text asks to append a Log entry (did/next) to the worktree's in-progress task, or to create/claim
a task, or to reply that there is nothing to track. `STALE_MINUTES` is a single constant.

### 7.4 `PreCompact` and `SessionEnd` — automatic safety note

If code changed since session start, append to every `in_progress` task listing this worktree:
`- <date> · <worktree> · auto: changed files: <up to 10> · last commit: <sha> <subject>`.
Then commit `pm/` (same commit rule as §6). The note is written without the model, so a handoff is
never empty.

## 8. Plans from other tools

| Source | Location | Goes to the board as |
|---|---|---|
| superpowers brainstorming | `docs/superpowers/specs/*-design.md` | link on the task/milestone; key decisions → `decisions.md` |
| superpowers writing-plans | `docs/superpowers/plans/*.md` | one task (or a milestone of tasks if large); `## Task N` → checklist items; `Step`s stay in the plan |
| Claude Code plan mode | `~/.claude/plans/*.md` | tasks on approval; essence copied into `Understanding` (file names are random) |
| gstack office-hours | `docs/designs/*.md` | goal/vision → `PLAN.md` |
| gstack plan-ceo-review | `~/.gstack/projects/<slug>/ceo-plans/*.md` | scope decisions → `decisions.md`; scope changes → `PLAN.md` changelog |
| gstack plan-eng/design-review | `## GSTACK REVIEW REPORT` appended to the plan | fixes → tasks; unresolved decisions → `waiting` tasks |
| dev-cycle | `.dev-cycle/tasks/*.md` | link; final status mirrored on completion |
| feature-puzzles | not persisted | Puzzle Map → `Understanding` |

Flow is one-way. When a source changes, the §7.2 nudge makes the agent reconcile again: add new items,
mark removed ones `dropped`. On `pm init` in an existing repo, `pm scan` lists old plans; the agent
imports them, inferring status from checkboxes (all ticked → `done`, some → `in_progress`, none → `todo`).

## 9. Skill `skills/pm/SKILL.md` — protocol

| Trigger | Agent action |
|---|---|
| "что дальше?", "бери следующую", session start with no active task | Take the first ready task (or the named one), `pm claim`, write `Understanding` first; a blocking question → `waiting` |
| "разбей", large request | Decompose into board tasks with `order`/`depends_on`; detailed steps via superpowers writing-plans, linked |
| during work | Refinements → `Understanding`; decisions → `pm decision` with why and rejected alternatives |
| agent believes the task is done | Definition of done: checklist closed and verification actually ran. Then the mandatory "what's left?" pass: leftovers become new tasks with `depends_on`. If not all done, report "готово частично" and keep `next:` |
| "закончили", "продолжим в новой сессии" | Log with `next:` for every in-progress task of this worktree, update `Current focus`, regenerate board, tell the owner `/clear` is safe |
| "запомни …" | Route to exactly one place: decision → `decisions.md`; durable fact about owner/project → auto-memory `memory/`; task detail → that task's `Understanding` |
| "план меняется" | Edit `PLAN.md` in place + changelog line + decision |
| "ждём …" | `waiting` with `waiting_on` |
| "откати T-007" / undo | Revert the last board change using the local git history of `pm/` |
| no board yet, non-trivial multi-step work starts | `pm init`, fill `PLAN.md`, import via `pm scan`; announce it in the board diff line |

Rules:
- Every turn that changed the board ends with one line: `доска: T-003 → done · new T-007 «…» (after T-005) · D-004`.
- Only the main agent writes `pm/`. Subagents return results; the main agent records them.
- Use the CLI for structured changes (ids, statuses, log, decisions); edit prose sections directly.

The full skill loads only on `/pm` or when triggered; the rules digest from §7.1 is always present.

## 10. Packaging and installation

```
.claude-plugin/plugin.json        name: project-memory
.claude-plugin/marketplace.json   this repo as a single-plugin marketplace "ai-memory"
skills/pm/SKILL.md
hooks/hooks.json
scripts/pm.mjs
scripts/pm.test.mjs
README.md
```

Install: `/plugin marketplace add C:\Users\Aziz\orca\projects\ai-memory`, then
`/plugin install project-memory@ai-memory`. Development: `claude --plugin-dir <repo>`.

## 11. Migration from competing mechanisms

Done only after `/pm` has run for about a week on 1–2 projects. Each item is confirmed separately and is
a reversible config change.

| Item | Action |
|---|---|
| Global CLAUDE.md "feature-puzzles / per-task memory" section and the "Session protocol" SessionStart prompt hook | Replace with a short pointer to `/pm`; keep the graphify and `memory/`-for-facts rules |
| token-optimizer checkpoint hint at SessionStart | Disable; keep the plugin's other features |
| gstack `/context-save`, `/context-restore` | Stop using; Log entries replace them |
| agentmemory MCP | Remove from config (configured but unused) |
| context-keeper plugin | Uninstall (already disabled) |
| feature-puzzles skill | Disable (duplicates superpowers; Puzzle Map moves to `Understanding`) |

## 12. Testing

Automated (`node --test scripts/pm.test.mjs`, temp git repos with worktrees):

1. `pm/` resolves to the same folder from the main worktree and from a linked worktree.
2. `<repo-key>` equals Claude Code's key for real paths, including non-ASCII.
3. Ready queue: order, dependencies, `dropped` dependency resolved, `waiting` excluded.
4. `validate` detects cycles, unknown dependencies, `waiting` without `waiting_on`.
5. Two concurrent `pm task new` processes get distinct ids.
6. `pm summary` never exceeds 40 lines; the rules digest is always present.
7. `board.html` / `BOARD.md` contain every non-dropped task in the right column.
8. Stop guard: blocks when code changed and the board is stale; silent when `stop_hook_active`;
   silent when the code is unchanged; silent within the throttle window.
9. PreCompact/SessionEnd: auto note appended only to in-progress tasks of this worktree; `pm/` committed.
10. Every hook exits 0 silently when the repo has no board or cwd is not a git repo.

Manual dogfooding: the first board is this project's own board, tracking the tasks of this plan.
Check: a new session shows the summary; a second worktree sees the same board; `board.html` opens and
refreshes.

## 13. Risks

| Risk | Mitigation |
|---|---|
| How Claude Code on Windows runs hook commands (Git Bash vs cmd) and expands `${CLAUDE_PLUGIN_ROOT}` | First implementation task is a spike that proves a plugin hook runs `node` on this machine |
| `<repo-key>` differs from Claude Code's encoding | Test 2; if it cannot be matched, fall back to a stable key of our own and document it |
| Claude Code cleanup (`cleanupPeriodDays`) touching unknown folders under `~/.claude/projects/` | Verify during the spike; `pm/.git` also provides a restorable history |
| Stop guard becomes annoying | Throttle window; single constant to tune |
| Summary bloats context | Hard 40-line cap, tested |
