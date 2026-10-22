# Session close, project learnings and board audit — design

Date: 2026-10-22. Status: accepted by the user in chat (2026-10-22); builder-checked the same day, the
eight questions it raised are settled in the text below as the author's calls (dates for the audit,
`dead-worktree` under sync, promotion as a user-approved step, local numbering, `--start`, `pm learn
check`, `next` only on `todo`, near-match hints for patterns).

## Intent

Three gaps in project-memory 0.10.0:

1. **Closing a session is two unrelated rituals.** `/done` closes a task on the board; the retro
   (what did this session teach us) and the worktree cleanup live in the user's private CLAUDE.md and
   a private skill. The plugin does not know the word «слил», never asks what the next session should
   start with, and the only handoff is the last `next:` line in a task Log — the automatic notes written
   by PreCompact/SessionEnd have no `next:` and are ignored by the summary.
2. **The plugin has no memory of lessons.** `decisions.md` records choices; nothing records
   "this error means X, do Y". The next session hits the same wall.
3. **Nothing is ever cleaned.** Tasks stuck in `in_progress` for weeks, `waiting` without an end,
   `review` without a PR, `worktrees:` pointing at removed worktrees, `.state/session-*.json` piling up.

The result should be: one `/close` ritual that cannot end without a handoff, a small structured store of
project learnings that is deduplicated on write and surfaced at session start, and a deterministic
`pm audit` that lists what went stale and fixes the mechanical part.

What was borrowed, and from where (research 2026-10-22, six repos):
- rebelytics/one-skill-to-rule-them-all: archival as a side effect of writing, dedupe before write,
  session-start scan of frontmatter only, a mandatory checkpoint ("wrote one, or wrote `none`").
- UniM0cha/self-improving-skills: "write nothing by default", the anti-patterns list, decay by last
  use with archive instead of delete, a hard cap.
- pskoett/self-improving-agent: a pattern key `area.symptom` for dedupe, promotion after repeats with a
  back-link to the source.
- obra/superpowers: the ledger on disk survives compaction; skill descriptions are triggers only.

Not borrowed: background `claude -p` workers, SQLite queues, transcript regex scanning, nine-field
maintenance blocks, PR-based self-patching. Everything here is files in the existing `pm` git repo and
one Node CLI with no dependencies.

## Goals

- `/close` ends a session with: every task of this worktree logged or closed, a retro checkpoint,
  the next task chosen, and a clear "the worktree can go" line.
- Learnings are per project (same `pm` repo, same sync), written only from the retro, deduplicated by
  pattern, surfaced in the session summary without growing its cost.
- `pm audit` is deterministic, needs no LLM, runs in under a second, and `--fix` touches only what
  cannot be wrong.
- The plugin's own repo uses the plugin (board initialized, these three epics as tasks).

## Non-goals

- No automatic writing of learnings from transcripts or hooks. Only the agent, in the retro, writes.
- No LLM-driven consolidation or "umbrella" merging of learnings.
- No orca / worktree removal inside the plugin. `/close` prints that the worktree can be removed; the
  user's CLAUDE.md keeps the orca command. (My call: the plugin is tool-agnostic.)
- No change to Claude Code auto-memory (`<claude-home>/projects/<key>/memory/`). It stays the place for
  user preferences and feedback; project lessons go to learnings. (My call, the user approved the
  proposal that contained it.)
- No new hooks. The five existing hooks stay; SessionStart gets two more lines at most.

## Anti-goals (what would make this a failure)

- A summary that grows with the number of learnings. Hard cap: one `Learnings:` line and one
  `Promote:` line, ≤5 items each, always inside the existing 40-line budget.
- A retro that takes more than one exchange when there is nothing to record.
- `pm audit --fix` changing a status, deleting a task, a learning or a decision.
- A second copy of the protocol: README, SKILL.md and `pm help` must describe the same commands; the
  SKILL description becomes triggers only.

## Data model

### `learnings/L-NNN.md` in the pm repo

```
---
id: L-003
title: CI translation keys fail while local passes
pattern: i18n.missing-key-in-ci
status: active            # active | promoted | retired
seen: 2
first: 2026-10-01
last: 2026-10-22
tasks: [PM-012, PM-019]
promoted_to: ""           # "<file>#<section>" once promoted
retired_why: ""
---
## Symptom
Unable to find … <key> in the DOM only in CI.

## Fix
The CI build runs with a stale locale bundle; rebuild locales before the e2e job.

## Apply
When a test fails on a translation key that exists locally: run `pnpm locales:build` first, do not
touch the component.
```

- Ids: `L-NNN`, reserved with an exclusive create like tasks (`wx`), unique across machines by file name.
- `pattern`: `area.symptom`, lowercase, `[a-z0-9]+(\.[a-z0-9-]+)+`. Dedupe key.
- `seen` counts distinct retro recordings; `tasks` is the union of tasks that recorded it. `seen` and
  `tasks` move only through `pm learn add` (never by viewing).
- Body sections are fixed (`## Symptom`, `## Fix`, `## Apply`); the CLI fills them from flags, the
  agent may edit the prose afterwards (same rule as task files).
- `.gitattributes`: nothing new; files are unique by name so sync merges never conflict on them.
- Cap: 100 active learnings per project. `pm learn add` refuses the 101st with "retire or promote
  first — pm learn list shows them oldest-last first".

### Task frontmatter

- `next: <date>` on at most one task per epic — the epic is the task's own `epic` key (`""` = the
  repo-wide group), never the worktree's. Only a `todo` task can be `next` (ready or not). Set by
  `pm next`, removed by `pm claim`, by any status change away from `todo`, or by `pm next --clear`.
- `waiting_since: <date>` is set when a task enters `waiting` and removed when it leaves (like
  `review_at`). Tasks that were already waiting before this version have none; the audit then uses
  `updated`.
- Log lines gain one kind: `- <date> · <worktree> · retro: none` or `retro: L-003, L-007`.
- `config.json` gains `startNumber` (see `pm prefix --start`) and `retroSince: <date>`, written by
  the first `pm learn add` / `pm learn none` on this board: the audit asks for retro lines only on
  tasks closed on or after that date, so an upgraded board does not wake up with thirty findings.

### `.state/audit.json`

`{ "at": <ms> }` — when the last SessionStart audit count ran. Local, gitignored, like the rest of `.state/`.

## CLI

```
pm learn add --title T --pattern area.symptom [--symptom S] [--fix F] [--apply A] [--tasks PM-001]
pm learn list [--all]                    active learnings (id · seen · last · title); --all includes promoted/retired
pm learn show L-003                      the file
pm learn find <words…>                   case-insensitive match over title, pattern and body of active learnings
pm learn promote L-003 --to <file#section>
pm learn retire L-003 --why "…"
pm learn none <task-id>                  the retro checkpoint when nothing was learned
pm learn check <task-id,…>               "ok" when every listed task has a retro: line dated today, else the missing ids (exit 1)
pm next [<task-id> | --clear]            mark the task the next session starts with (one per epic)
pm prefix [KEY] [--start N]              as before; --start N makes new ids continue from N (config.json startNumber)
pm audit [--fix]                         list what went stale; --fix applies the mechanical part
```

Behaviour that matters:

- `pm learn add` with a `pattern` that matches an **active** learning does not create a file: it bumps
  `seen`, sets `last`, unions `tasks`, and prints `L-003 seen 3 (PM-012, PM-019, PM-031) — same lesson;
  edit the Fix if it changed`. A repeat for a task already in `tasks` on the same day is a no-op
  ("already recorded today"), so `seen` counts recordings, not retries. With no exact match, the
  command still creates the file but first looks for near matches (same `area.` prefix, or a title
  word in common) and prints `similar: L-003 i18n.missing-key-in-ci — same lesson? pm learn retire
  L-0NN` under the result; the retro skill runs `pm learn find` before `add` for the same reason. A match on a `retired` learning reactivates it (`status: active`,
  `retired_why` cleared) and says so; a match on a `promoted` one prints where it was promoted and
  does not write. For each task in `--tasks` it appends `retro: L-NNN` to the task Log (one line per
  `pm learn add` call, merged with the same day's `retro:` line if one exists).
- Promotion threshold: `seen ≥ 3` and `tasks` has ≥ 2 distinct ids. `pm learn add` prints
  `promote? pm learn promote L-003 --to <file#section>` when crossed; the summary lists such learnings
  on its `Promote:` line. Promotion is a protocol row, not part of `/close`: the agent proposes a
  target (the repo's CLAUDE.md or AGENTS.md, or the skill of that area) and the one-paragraph rule,
  writes it only after the user says yes, with a trailing `Source: L-003` line, and only then runs
  `pm learn promote L-003 --to <file#section>`, which records `status: promoted` and `promoted_to`.
  The write into the repo is the user's commit, like any code change.
- `pm learn none PM-012` appends `- <date> · <worktree> · retro: none` to the task Log; it works on
  closed tasks too (the task was just closed in step 1). `/close` ends step 2 with
  `pm learn check <ids>` over the tasks step 1 touched (every task this worktree had open when
  `/close` started) and does not go on until it prints `ok`.
- `pm next PM-014` requires status `todo`, clears `next` on other tasks with the same `epic`, sets
  `next: <today>`. The summary's `Ready:` line prints that task first with `← next`, or
  `← next (after PM-009)` when its dependencies are still open; `pm ready` prints it first when ready.
- Learnings and tasks are numbered locally (`max + 1`); two machines creating `L-004` at once is an
  add/add conflict handled by the existing `pm sync` conflict flow, exactly like tasks today. The audit
  lists two active learnings with one `pattern` as `learning-dup`.
- `pm audit` findings (each a line `<code> <id or file> — <what> — <fix or how>`):

  | code | finding | `--fix` |
  |---|---|---|
  | `stuck` | `in_progress` whose last manual Log line (`did:`) is older than 14 days; `auto:` lines do not count; no Log line → `updated` | no — list |
  | `waiting-long` | `waiting_since` (or `updated` when absent) older than 30 days | no — list |
  | `review-no-pr` | `review` without `pr` | no — list |
  | `dead-worktree` | `worktrees:` entry that `git worktree list` of this repo does not know | yes, only while sync is off — another machine's worktrees are invisible here, so with sync on it is listed only |
  | `orphan` | `in_progress` with no `worktrees:` entry (its worktree was removed after `/close`) | no — list with "pm claim or pm set status=todo" |
  | `learning-dup` | two active learnings with the same `pattern` | no — list |
  | `next-stale` | `next:` older than 30 days or on a task that is no longer `todo`/`waiting` | yes — clear it |
  | `state-old` | `.state/session-*.json` older than 7 days | yes — delete |
  | `learning-unused` | active learning with `last` older than 90 days | no — list with `pm learn retire` hint |
  | `learning-promote` | active learning past the promotion threshold | no — list |
  | `learnings-cap` | more than 80 active learnings | no — list the count |
  | `decision-dropped` | a decision whose `- tasks:` are all `dropped` | no — list |
  | `retro-missing` | a `done`/`review` task whose last status date (last Log line, else `updated`) is on or after `retroSince` and within 30 days, with no `retro:` line | no — list |

  Exit code 0 always (it is a report, not a gate). `--fix` prints what it changed and commits
  `pm: audit --fix`. With nothing to report: `audit: clean`.
- SessionStart: once per 7 days (`.state/audit.json`), count the findings; when > 0 add the line
  `[pm] audit: N findings — run: pm audit` to the status lines. Never blocks, never fixes.

## Session summary additions

Two optional lines, both inside the existing `MAX_LINES` budget, after `Decisions:`:

- `Learnings: L-007 CI translation keys fail while local passes · L-003 …` — active learnings whose
  `tasks` intersect the tasks of this worktree's epic, else the 5 most recently `last`-dated; ≤5, newest
  first. Read from frontmatter only; the body is never loaded for the summary.
- `Promote: L-003 (seen 4 in 3 tasks)` — only when some active learning passes the threshold.

## `/close` command (commands/close.md)

Triggers in the pm skill description: "/close", "слил", "закрой сессию", "closing the session",
"wrap up". The command is a conversation, one exchange per step, each step ends with a CLI call:

1. **Tasks of this worktree.** `pm summary` → for each open task claimed here, ask: done, awaiting
   merge, or paused? Done/merge → the `/done` procedure (definition of done, leftovers as tasks,
   `pm done`). Paused → `pm log … --next "<exact next step>"`. No task claimed and code changed → offer
   `pm task new` + `pm claim` + `pm log`, or "nothing to track".
2. **Retro.** Invoke the `retro` skill (below). It ends with either `pm learn add …` calls or
   `pm learn none <id>` for every task from step 1. Skip only with `/close --no-retro`, which runs
   `pm learn none` itself so the checkpoint still exists.
3. **Next task.** `pm ready` → ask which task the next session starts with (default: the first ready
   one, or "none" when the direction is finished) → `pm next <id>`. Update `## Current focus` for this
   epic when it moved.
4. **Wrap.** Print: the board diff line, `next session: <id> <title>` (or "nothing chosen"), and
   `worktree <name> can be removed — nothing of this session lives only here` only when
   `git status --porcelain` is empty and the branch is pushed (otherwise say what is not).

The command never removes a worktree, never pushes code, never runs `git` that changes the repo.

## `retro` skill (skills/retro/SKILL.md)

Ported from the user's private `closing-task-retro` skill, generalized, English with the same
Russian triggers, under 60 lines. Triggers: "/close" step 2, «что узнали нового», «что зафиксировать»,
"what did we learn", "retro".

Sources to walk (each checked explicitly): a tool/CLI error that was worked around; an infra
workaround; "expected X, got Y"; a correction from the user; a red pipeline or review and its cause;
a subagent finding that surprised; a skill that misfired.

Routing, first match wins:
1. A skill of this session misfired → fix that skill, write nothing else.
2. Already in the repo, git, CLAUDE.md or a skill → write nothing; if it was there and still bit →
   improve its findability there.
3. A fact about the user or their preferences → auto-memory (unchanged).
4. A repeatable procedure of ≥2 steps that other tasks need → a skill (`superpowers:writing-skills`
   when installed), only when verified.
5. A project lesson: symptom + fix + how to apply → `pm learn add` (the CLI dedupes by pattern).
6. A code defect across the repo → `pm task new`, not memory.

Default is to write nothing. Never record: session state (PR numbers, test counts), "X does not work"
without a fix, one-off narratives, environment-specific paths. Before writing: no secrets
(`grep -nE 'ghp_|glpat-|sk-|Bearer |://[^ /]*:[^ /]*@'`). End with three lines: recorded · extended ·
not recorded and why, then `pm learn none <id>` for tasks with nothing.

## Skill description and docs

- `skills/pm/SKILL.md` description shrinks to a one-sentence purpose plus the trigger phrases
  (EN + RU), no workflow summary. The protocol table gains rows for `/close`, "слил", "what did we
  learn", "audit", "next session starts with …", `Promote:` and `[pm] audit:` summary lines.
- `Elsewhere:` in the summary prints `@ (no worktree)` for an orphan instead of a blank.
- `pm help` PHRASES gains the new phrases. README (EN and RU) gains sections "Closing a session"
  (replacing the current "Ending a session"), "Learnings" and "Audit"; the command list is updated.
- `docs/PROGRESS.md` is deleted (a September snapshot that promised to delete itself).
- Version 0.11.0 in `plugin.json`.

## Dogfooding

`pm init` in this repo, `pm prefix PM --start 61`, tasks for the three epics (close, learnings, audit)
plus the docs task. The repo's history already names PM-055…PM-060 and T-038…T-051 (an older board
that lives under the marketplace clone's key, not this checkout's); restarting at PM-001 would make
`subjectHits` match old commits to new tasks, so new ids continue from PM-061.

## Constraints

- Node ≥ 20, no dependencies, Windows paths and CRLF handled like the rest (`normPath`, `\r\n`).
- Every new behaviour has a `node --test` test next to the existing ones (`test/learn.test.mjs`,
  `test/audit.test.mjs`, `test/next.test.mjs`, summary and hooks tests extended).
- Hooks never throw; audit inside SessionStart is wrapped like the merge check.
- Free text in Russian or English as the user writes it; ids and keys ASCII.

## Left to the builder

- Exact wording of CLI output lines, as long as each stays one line and names the next command.
- Internal module split (`lib/learn.mjs`, `lib/audit.mjs`; `next` in `tasks.mjs`).
- How `/close` detects "branch pushed" (`git rev-parse @{u}` + `git status -sb`), with a safe
  fallback of saying it could not tell.
