# project-memory (`/pm`) — design

Date: 2026-09-12 · Status: approved in brainstorming (rev. 3: public release; cross-machine sync of board
and memory is opt-in per project, local by default), awaiting spec review

## 1. Problem

Claude Code sessions do not reliably remember project state. Findings on the author's machine:

- The `MEMORY.md` protocol required by the global CLAUDE.md was never initialized in any of 10 projects:
  it is prose with no tooling behind it.
- Four unrelated "where did I stop" mechanisms exist and none reads another: token-optimizer
  checkpoints (automatic, low quality), gstack `/context-save` (manual, stored outside git, worktree slug
  bug), superpowers plan checkboxes (ticked unreliably), agentmemory MCP (configured, guide disabled).
- No task board with statuses, ordering and dependencies exists anywhere.
- Claude Code auto-memory is machine-local: a second computer starts from zero.

A skill alone does not fix this: it only works when the model remembers to invoke it. The fix must be
driven by hooks (deterministic) with a skill describing the protocol.

## 2. Goals

1. One accepted project plan that stays current, with a changelog of why it changed.
2. A task board: statuses, order, dependencies, per-task understanding, checklist and work log.
3. A decision log: what was decided, why, what was rejected.
4. Session handoff: every new session (any worktree, any machine) starts knowing where work stopped and
   the next step.
5. Full agent autonomy: the agent maintains all of the above itself and reports a one-line board diff.
6. Plans produced by other tools (superpowers, gstack, plan mode, dev-cycle) feed the board.
7. A human view: `BOARD.md` and a read-only HTML kanban `board.html`.
8. Everything is local by default; on explicit request, a project's board and auto-memory sync across
   the user's machines (Windows, macOS, Linux) through the project's own repository.
9. Published on GitHub as a Claude Code plugin anyone can install.

## 3. Non-goals (v1)

MCP server · drag-and-drop board editing · multi-agent orchestrator · modifying other skills/plugins ·
two-way sync with other tools' plan files · a hosted service of any kind.

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| 1 | On each machine, state lives outside the project's branches in one per-repo folder shared by all worktrees | Worktree-per-task workflows (e.g. Orca): in-branch state diverges across worktrees |
| 2 | Own minimal markdown format, not Backlog.md / Beads | Both store state inside the working branch, contradicting #1 |
| 3 | Concurrency: usually one agent; sometimes several worktrees on one task | Tasks list attached worktrees; logs are append-only; ids are reserved atomically |
| 4 | Full agent autonomy | Explicit-command discipline is exactly what fails today |
| 5 | Other tools' plans stay where they are; the board gets coarse items + a link | One source of truth for status; no duplicated content; other skills stay unpatched |
| 6 | Local by default; sync is opt-in per project, via an orphan branch `pm` in the project's own repository | Nothing leaves the machine unless the user asks; no surprises for collaborators; once enabled, the board travels with the project |
| 7 | When sync is enabled, auto-memory moves into the board clone and syncs with it | Facts and preferences follow the user to other machines; opt-out per project |
| 8 | Plugin content is generic, cross-platform, MIT, English docs, multilingual triggers | Public release |

## 5. Storage

### 5.1 Local location and repo key

```
<claude-home>/projects/<repo-key>/pm/
```

- `<claude-home>` = `$CLAUDE_CONFIG_DIR` if set, else `~/.claude` (via `os.homedir()`).
- Main worktree root = parent directory of `git rev-parse --path-format=absolute --git-common-dir`.
  All worktrees of a repo on a machine resolve to the same root.
- `<repo-key>` = main worktree root with every character outside `[A-Za-z0-9]` replaced by `-`
  (`C:\Users\a\proj` → `C--Users-a-proj`, `/Users/a/proj` → `-Users-a-proj`). It must equal the key Claude
  Code uses for auto-memory, so `pm/` sits next to `memory/`. The key is machine-local; cross-machine
  identity is the git remote (§5.7), never the key.
- Outside a git repository `/pm` is inactive (hooks print nothing).
- Current worktree name = basename of `git rev-parse --show-toplevel`.

### 5.2 Layout

`pm/` is its own small git repository on branch `pm` (local history, undo). It has no remote until sync
is enabled (§5.7). It is not a worktree of the project, so worktree managers do not list it.

```
pm/
  .git/                 branch pm; no remote by default, the project's remote once sync is on (§5.7)
  .gitattributes        decisions.md and memory/MEMORY.md use merge=union
  .gitignore            .state/
  PLAN.md               accepted plan
  tasks/T-001-slug.md   one file per task
  decisions.md          append-only decision log
  memory/               Claude Code auto-memory, linked into place (§5.8)
  BOARD.md              generated, never hand-edited
  board.html            generated, never hand-edited
  .state/               hook bookkeeping, machine-local
```

### 5.3 Content language

Keys, ids, statuses and section headings are English. Free text (titles, understanding, log, decisions,
plan, the board diff line) is written in the language the user speaks in chat.

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
worktrees: [feature-csv]
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
- 2026-09-12 · feature-csv · did: <what> · next: <exact next step>
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

### 5.7 Cross-machine sync (opt-in per project)

- **Default: local only.** `pm init` creates a local repo with no remote. Nothing is ever pushed, fetched
  or shared until the user explicitly asks.
- **Sync enabled** ⇔ the `pm/` repo has a remote named `origin`. There is no other flag.
- **Remote** = `--remote <url>` if given, else the URL of the project's `origin`. A private URL lets a
  public project keep its board private.
- **`pm sync on [--remote url]`** (user asks: "enable board sync" / "включи синхронизацию доски"):
  1. print one line: the board and memory will be pushed to `<remote>` branch `pm` — if that repository
     is public, they become public (suggest `--remote <private-url>`); the agent confirms with the user
     before continuing;
  2. add the remote; if it already has branch `pm`, merge it into the local board
     (`--allow-unrelated-histories` when both exist; conflicts follow the rule below), else push
     `-u origin pm`;
  3. link memory (§5.8) unless `git config pm.syncMemory false`.
- **`pm sync off`**: remove the remote; the local board stays. Prints how to delete the remote branch if
  the user wants it gone.
- **Another machine or a collaborator — never automatic.** At `SessionStart`, if the project repo has a
  remote-tracking ref `refs/remotes/origin/pm` (brought by a normal `git fetch`) and this machine has no
  synced board, the summary shows one line: `[pm] this repo has a shared board (branch pm) — say
  "connect the board" to use it`. Nothing is cloned until the user says so (`pm sync on`). This check is
  local-only: no network call.
- **Pull** (sync on only): at `SessionStart`, `git pull --rebase` with a 5-second timeout; a failure
  (offline, auth) is silent and the session continues on local state.
- **Push** (sync on only): after every `pm/` commit, a detached background process runs `pull --rebase`
  then `push`, never blocking the session.
- **Conflicts**: `decisions.md` and `memory/MEMORY.md` merge by union. Any other conflict aborts the
  rebase, keeps local commits, and records `.state/conflict`; the session summary then shows
  `[pm] sync conflict — run /pm sync`, and `pm sync` lists the files for the agent to merge. Nothing is
  ever discarded automatically.
- **Collaborators** who install the plugin keep their own local boards; only if they explicitly connect
  do they share the same board, and their worktree names appear in `worktrees` and `Log`. Collaborators
  without the plugin only see an extra branch.

### 5.8 Memory sync (only when sync is on)

- Claude Code's auto-memory folder `<claude-home>/projects/<repo-key>/memory` becomes a link to
  `pm/memory`: a directory junction on Windows (no admin rights needed), a symlink on macOS/Linux.
- First setup on a machine: if a real `memory/` folder exists, its files move into `pm/memory` first;
  a name clash keeps both (`<name>.<machine>.md`) and is reported. The link replaces the folder only after
  the move succeeded. Data is never deleted.
- The link is (re)checked at every `SessionStart` and repaired if missing.
- Memory files written by Claude Code are committed by the `Stop` hook (§7.3) and pushed like any change.
- Opt-out per project: `git config pm.syncMemory false` (for example when collaborators share the board
  and personal notes should stay private).
- If the spike (§13) shows the link is unreliable, Claude Code's `autoMemoryDirectory` setting is used
  instead; the rest of this section is unchanged.

## 6. Script `scripts/pm.mjs`

Single file, Node ≥ 20, standard library only, no platform-specific shell commands (git is invoked
directly via `child_process.execFileSync`). Handles everything deterministic; the agent writes prose
sections with normal file edits.

| Command | Effect |
|---|---|
| `pm init` | Create a local board (no remote), print the path |
| `pm sync on [--remote url]` / `pm sync off` | Enable / disable sync for this project (§5.7); `on` also links memory (§5.8) |
| `pm sync` | When sync is on: pull + push now; on conflict list files to merge |
| `pm scan` | List plan files from other tools found for this repo (§8) with checkbox counts done/total |
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

Every mutating command regenerates the board and commits `pm/` (`git add -A && git commit -m
"pm: <command> <id>"`, one retry if `index.lock` is busy), then, if sync is on, triggers the background
push. Each
change — including the agent's direct prose edits made since the previous commit — is individually
revertible. Ids are reserved locally; if two machines create the same id offline, `validate` (run by
`pm sync` and at `SessionStart`) reports the duplicate and the agent renumbers one of them.

## 7. Hooks (`hooks/hooks.json`)

Each hook runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/pm.mjs" hook <event>`. If no board exists for the
repo, every hook exits 0 silently (except the one-line shared-board hint of §7.1). Every hook exits 0 on any internal
error: the plugin must never break a session.

### 7.1 `SessionStart` (sources: startup, resume, clear, compact)

If sync is on: pull (§5.7) and repair the memory link (§5.8). Store `{session start time, HEAD}` in
`.state/<session_id>.json`, then print the summary (hard limit 40 lines):

```
[pm] <project> · focus: <Current focus> · board: file:///…/pm/board.html
Your worktree (<name>):
  T-003 CSV import [in_progress] → next: <last Log next:> (<date>, <machine/worktree>)
Ready: T-004 <title> · T-006 <title> · T-007 <title>
Waiting: T-005 ← <waiting_on>
Decisions: D-004 <title> · D-003 <title> · D-002 <title>
Rules: maintain tasks/statuses/decisions yourself · end every turn that changed the board with a
  one-line board diff · only the main agent writes pm/ · before "done" ask "what's left?" · details: /pm
```

Limits: all tasks of this worktree, first 3 ready, up to 5 waiting, last 3 decisions, plus at most one
sync line (conflict, duplicate ids, commits unpushed for over a day, or "this repo has a shared board").
A repo with no local board prints only that shared-board hint when it applies, otherwise nothing. The rules digest is always included: it is what makes autonomy work without
loading the full skill.

### 7.2 `PostToolUse` (matcher `Write|Edit|MultiEdit|ExitPlanMode`)

- If the edited path is inside `pm/`: regenerate the board (keeps `board.html` fresh after direct edits).
- If the edited path matches a plan location (§8), or the tool is `ExitPlanMode`: inject one line via
  `additionalContext`: `[pm] plan updated: <path> — reconcile with the board (coarse items + link).`

### 7.3 `Stop` — "board not updated" guard

First commits any uncommitted `pm/` changes (including memory files) and, if sync is on, triggers the
background push.
Then blocks at most once per throttle window with `{"decision":"block","reason":…}` when all hold:

- `stop_hook_active` is false;
- code changed: `git status --porcelain` is non-empty, or the HEAD commit time is newer than the last
  board update;
- board is stale: the latest board update touching this worktree (task files listing it,
  `decisions.md`, `PLAN.md`) is older than `STALE_MINUTES = 20`;
- no block was issued in the last `STALE_MINUTES` (tracked in `.state/`).

The reason asks to append a Log entry (did/next) to the worktree's in-progress task, or to create/claim a
task, or to reply that there is nothing to track. `STALE_MINUTES` is a single constant.

### 7.4 `PreCompact` and `SessionEnd` — automatic safety note

If code changed since session start, append to every `in_progress` task listing this worktree:
`- <date> · <worktree> · auto: changed files: <up to 10> · last commit: <sha> <subject>`.
Then commit and push (as in §6). The note is written without the model, so a handoff is never empty.

## 8. Plans from other tools

| Source | Location | Goes to the board as |
|---|---|---|
| superpowers brainstorming | `docs/superpowers/specs/*-design.md` | link on the task/milestone; key decisions → `decisions.md` |
| superpowers writing-plans | `docs/superpowers/plans/*.md` | one task (or a milestone of tasks if large); `## Task N` → checklist items; `Step`s stay in the plan |
| Claude Code plan mode | `<claude-home>/plans/*.md` | tasks on approval; essence copied into `Understanding` (file names are random) |
| gstack office-hours | `docs/designs/*.md` | goal/vision → `PLAN.md` |
| gstack plan-ceo-review | `~/.gstack/projects/<slug>/ceo-plans/*.md` | scope decisions → `decisions.md`; scope changes → `PLAN.md` changelog |
| gstack plan-eng/design-review | `## GSTACK REVIEW REPORT` appended to the plan | fixes → tasks; unresolved decisions → `waiting` tasks |
| dev-cycle | `.dev-cycle/tasks/*.md` | link; final status mirrored on completion |
| feature-puzzles | not persisted | Puzzle Map → `Understanding` |

Flow is one-way. When a source changes, the §7.2 nudge makes the agent reconcile again: add new items,
mark removed ones `dropped`. On `pm init` in an existing repo, `pm scan` lists old plans; the agent
imports them, inferring status from checkboxes (all ticked → `done`, some → `in_progress`, none → `todo`).
Unknown tools are simply not scanned; the list is a constant in the script.

## 9. Skill `skills/pm/SKILL.md` — protocol

Trigger phrases are listed in English and Russian; the agent matches intent, not exact words.

| Trigger | Agent action |
|---|---|
| "what's next?", "take the next one" / "что дальше?", "бери следующую"; session start with no active task | Take the first ready task (or the named one), `pm claim`, write `Understanding` first; a blocking question → `waiting` |
| "break it down" / "разбей", large request | Decompose into board tasks with `order`/`depends_on`; detailed steps via superpowers writing-plans (if installed), linked |
| during work | Refinements → `Understanding`; decisions → `pm decision` with why and rejected alternatives |
| agent believes the task is done | Definition of done: checklist closed and verification actually ran. Then the mandatory "what's left?" pass: leftovers become new tasks with `depends_on`. If not all done, report "partially done" and keep `next:` |
| "we're done", "continue in a new session" / "закончили", "продолжим в новой сессии" | Log with `next:` for every in-progress task of this worktree, update `Current focus`, regenerate board, tell the user `/clear` is safe |
| "remember …" / "запомни …" | Route to exactly one place: decision → `decisions.md`; durable fact about user/project → auto-memory `memory/`; task detail → that task's `Understanding` |
| "the plan changes" / "план меняется" | Edit `PLAN.md` in place + changelog line + decision |
| "waiting for …" / "ждём …" | `waiting` with `waiting_on` |
| "undo T-007" / "откати T-007" | Revert the last board change using the `pm/` git history |
| no board yet, non-trivial multi-step work starts | `pm init`, fill `PLAN.md`, import via `pm scan`; announce it in the board diff line |
| "enable board sync", "connect the board" / "включи синхронизацию доски", "подключи доску" | Show the push-target line from `pm sync on`, get the user's yes, then run it. Never enable sync on the agent's own initiative |
| "disable board sync" / "выключи синхронизацию" | `pm sync off` |

Rules:
- Every turn that changed the board ends with one line, e.g.
  `board: T-003 → done · new T-007 "…" (after T-005) · D-004` (in the user's language).
- Only the main agent writes `pm/`. Subagents return results; the main agent records them.
- Use the CLI for structured changes (ids, statuses, log, decisions); edit prose sections directly.
- Other skills are optional: the protocol works without superpowers or gstack installed.

The full skill loads only on `/pm` or when triggered; the rules digest from §7.1 is always present.

## 10. Packaging and release

```
.claude-plugin/plugin.json        name: project-memory, version, description, repository, license
.claude-plugin/marketplace.json   this repo as a single-plugin marketplace
skills/pm/SKILL.md
hooks/hooks.json
scripts/pm.mjs
scripts/pm.test.mjs
.github/workflows/test.yml        node --test on windows-latest, macos-latest, ubuntu-latest
README.md                         what it does, install, daily use, sync, privacy, coexistence with other memory tools
LICENSE                           MIT
```

- Install for anyone: `/plugin marketplace add <owner>/<repo>`, then `/plugin install project-memory@<marketplace>`.
- Development: `claude --plugin-dir <repo>`.
- No personal paths, names or machine-specific settings in shipped files.
- README "Privacy" section: everything is local by default; `pm sync on` pushes the board and memory to
  branch `pm` of the project's remote (or `--remote`); how to use `pm.syncMemory false` and `pm sync off`.
- README "Coexisting with other memory tools": generic advice to disable overlapping resume/memory
  mechanisms once `/pm` works.
- Publishing the GitHub repository and tagging `v0.1.0` happen after dogfooding, with explicit approval.

## 11. Rollout on the author's machines (not shipped)

Tracked as tasks on this project's own board (dogfooding), each confirmed separately, all reversible:

- Install on Windows; enable sync for this project; install on the MacBook, connect the board, and
  verify the MacBook session sees the Windows board and memory.
- After about a week of use: replace the global CLAUDE.md "feature-puzzles / per-task memory" section and
  the "Session protocol" SessionStart prompt with a pointer to `/pm`; disable the token-optimizer
  checkpoint hint; stop using gstack `/context-save`/`/context-restore`; remove the unused agentmemory MCP
  config; uninstall context-keeper; disable feature-puzzles.

## 12. Testing

Automated (`node --test scripts/pm.test.mjs`) using temp directories: throwaway git repos with linked
worktrees, a local bare repo as the remote, and `CLAUDE_CONFIG_DIR` pointing into the temp dir. Runs in CI
on Windows, macOS and Linux.

1. `pm/` resolves to the same folder from the main worktree and from a linked worktree.
2. `<repo-key>` equals Claude Code's key for real paths, including non-ASCII (checked manually on the
   author's machines against existing folders; unit-tested for the encoding rule).
3. Ready queue: order, dependencies, `dropped` dependency resolved, `waiting` excluded.
4. `validate` detects cycles, unknown dependencies, `waiting` without `waiting_on`.
5. Two concurrent `pm task new` processes get distinct ids.
6. `pm summary` never exceeds 40 lines; the rules digest is always present.
7. `board.html` / `BOARD.md` contain every non-dropped task in the right column.
8. Stop guard: blocks when code changed and the board is stale; silent when `stop_hook_active`; silent
   when the code is unchanged; silent within the throttle window.
9. PreCompact/SessionEnd: auto note appended only to in-progress tasks of this worktree; committed.
10. Every hook exits 0 silently when the repo has no board, when cwd is not a git repo, and on internal errors.
11. `pm init` never creates a remote and no command pushes while sync is off. `pm sync on` with a remote
    lacking `pm` pushes the branch; with a remote that has `pm` it merges it (including into an existing
    local board); `pm sync off` removes the remote and keeps the board.
12. "Second machine": a separate clone with a different `CLAUDE_CONFIG_DIR` shows the shared-board hint
    at `SessionStart` when `refs/remotes/origin/pm` exists, clones nothing until `pm sync on`, and makes no
    network call either way.
13. Concurrent edits from two clones: `decisions.md` merges cleanly; a conflicting task edit sets the
    conflict flag, shows the summary line, and loses no data; a duplicate id is reported by `validate`.
14. Offline remote: hooks still exit 0 within the timeout; changes are committed locally and pushed later.
15. Memory link: untouched while sync is off; on `pm sync on` an existing `memory/` folder is moved
    without loss (clash → both kept), the link is created and repaired; `pm.syncMemory false` leaves
    memory untouched.

Manual dogfooding: the first board is this project's own board, tracking the tasks of this plan. Check: a
new session shows the summary; a second worktree sees the same board; the MacBook sees the same board and
memory; `board.html` opens and refreshes.

## 13. Risks and the first spike

The first implementation task is a spike on Windows (and later macOS) that answers:

| Question | Fallback if the answer is bad |
|---|---|
| Does a plugin hook run `node` and expand `${CLAUDE_PLUGIN_ROOT}` on Windows (Git Bash vs cmd)? | Adjust the command form in `hooks.json` per platform |
| Does `PostToolUse` accept `additionalContext` as specified? | Use the documented output form instead |
| Does `<repo-key>` match Claude Code's folder name, including non-ASCII paths? | Store `pm/` under our own stable key; memory sync then uses `autoMemoryDirectory` |
| Does Claude Code read and write auto-memory through a junction/symlink? | Use `autoMemoryDirectory` |
| Does Claude Code cleanup (`cleanupPeriodDays`) ever touch unknown folders under `projects/`? | Move `pm/` to `<claude-home>/pm/<repo-key>/` |

Other risks:

| Risk | Mitigation |
|---|---|
| Board of a public repo becomes public | Local by default; `pm sync on` shows the push target and requires the user's yes; `--remote` for a private repo; README privacy section |
| Stop guard becomes annoying | Throttle window; single constant to tune |
| Summary bloats context | Hard 40-line cap, tested |
| Background push fails silently for days | Summary shows `[pm] N commits not pushed` when the local branch is ahead of the remote by more than 0 for over a day |
