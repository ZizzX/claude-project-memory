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
| `PLAN.md` | the repository's goal and milestones, `## Current focus` as one line per epic (`- KEY: what is happening now`), `## Changelog`. Shared by every worktree and direction — never touch another epic's lines | edit in place, then append `- <date> · <what changed> · <why> · D-NNN` to Changelog |
| `tasks/T-NNN.md` | frontmatter + `## Goal`, `## Understanding`, `## Checklist`, `## Log` | CLI for frontmatter and Log; edit Goal / Understanding / Checklist directly |
| `decisions.md` | append-only `## D-NNN · date · title` entries | `pm decision` only |
| `memory/` | Claude Code auto-memory (only when sync is on) | as usual |
| `BOARD.md`, `board.html` | generated views | never edit |

Statuses: `todo | in_progress | waiting | done | dropped`. "Waiting on another task" is `depends_on`,
not a status; `waiting` is for external blockers and needs `waiting_on`. Ready = `todo` with all
dependencies `done`/`dropped`. A task fits one branch/PR; fine-grained steps live in a linked plan file.
`## Log` stays the last section of a task file.

An **epic** is a direction of work: a free key on a task (`--epic ATS-1224` — a Jira epic or ticket key,
or a short slug). The summary, `pm ready` and the focus line are narrowed to the epic of the tasks this
worktree has claimed; a task without an epic is repo-wide and shows in every direction. Never derive the
epic from a branch or directory name — if the key is unclear, ask. An epic with no open task collapses
into the board's Archive by itself; there is nothing to close.

## Protocol

| Situation | Do this |
|---|---|
| "what's next?", "take the next one", or a session starts with no active task | `pm ready` — its first line says which epic it is narrowed to. If it says there is no epic for this worktree yet, or the tags show another direction's tasks, do not take one of those: start this direction with `pm task new --epic <KEY>` or ask which epic the worktree is for. Otherwise take the first (or the named) task; `pm claim T-NNN`; write `## Understanding` first (how you read the task, open questions). A blocking question → `pm set T-NNN status=waiting waiting_on="…"` and ask it. |
| "break it down", a large request | Create board tasks with `pm task new --title … --epic <KEY> --order N --deps …` (one direction = one epic; the epic is inherited from this worktree's tasks when omitted, `--epic ""` makes a repo-wide task on purpose); put detail in a superpowers plan (if installed) and link it with `--links`. |
| Small work in a repo that has a board (a one-session fix, a review, a question) | Leave the board alone; when the Stop nudge appears, reply that there is nothing to track. File a task afterwards if the work spills into a second session or blocks someone. |
| During work | Refinements → `## Understanding`. A real decision → `pm decision --title … --why … --rejected …`. |
| You believe the task is done | Definition of done: checklist closed AND verification actually ran (tests, a run of the app). Then ask "what's left?": every leftover becomes `pm task new … --deps T-NNN`. Only then `pm set T-NNN status=done`. If anything is unfinished, say "partially done", keep the status, and `pm log … --next "<exact next step>"`. |
| "we're done", "continue in a new session" | For every in-progress task of this worktree: `pm log T-NNN --did "…" --next "<exact next step>"`. Update `## Current focus` if it moved. Tell the user `/clear` is safe — the next session starts from the summary. |
| "remember …" | Exactly one place: a decision → `pm decision`; a durable fact about the user or project → auto-memory; a detail of a task → that task's `## Understanding`. |
| "the plan changes" | Edit `PLAN.md` — only your epic's focus line and your own sections — append a Changelog line, record a decision. |
| "waiting for …" | `pm set T-NNN status=waiting waiting_on="…"`. |
| "undo T-007", "undo that" | `git -C <pm dir> log --oneline -5`, then `git -C <pm dir> revert --no-edit <sha>` for the board change in question; `pm board`. |
| A `[pm] plan updated: <path>` line appears | Reconcile: new coarse items → tasks with a link to the plan; items removed from the plan → `status=dropped`. Do not copy the plan's content. |
| No board yet and non-trivial multi-step work starts | `pm init`, fill `PLAN.md` at the repository level: the goal of the product/repo, milestones, `## Current focus` as one line per epic, Changelog. The plan of one direction is a separate file (superpowers, gstack, plan mode) linked from its tasks with `--links` — never copied into `PLAN.md`. Then `pm scan` and import old plans (all boxes ticked → done, some → in_progress, none → todo). Announce it in the board diff line. |
| "enable board sync" / "connect the board" | Run `pm sync on` (no `--yes`) and show the user where the board and memory will be pushed. Only after the user says yes: `pm sync on --yes`. Never enable sync on your own initiative. |
| "disable board sync" | `pm sync off`. |
| "stop syncing my memory" | `git config pm.syncMemory false` only stops *future* linking — it does not undo an already-active link. Tell the user this, then do it manually: move `pm/memory` back to `<claude-home>/projects/<repo-key>/memory` and remove the link/junction. |
| `[pm] sync conflict …` in the summary | Run `pm sync`, follow its instructions, merge the listed markdown files by hand keeping both sides' information, then `pm sync` again. |
| `[pm] Code changed but the board was not updated …` (Stop hook) | Log progress on the active task, or create/claim one, or reply that there is nothing to track. |

## Rules

- End every turn that changed the board with one line in the user's language, for example:
  `board: T-003 → done · new T-007 "data migration" (after T-005) · D-004`.
- Only the main agent writes the board. Subagents return results; you record them.
- Use the CLI for ids, statuses, logs and decisions; edit prose sections directly.
- Write free text (titles, understanding, log, decisions, plan) in the user's language.
- Keep the Log honest: `did:` is what actually happened, `next:` is concrete enough to start without re-reading the whole conversation.
- In `## Current focus` either every line is `- KEY: …` or none is; when you add the first keyed line, key the existing ones too (an unkeyed line is then not shown to anyone).
- A plan in `docs/superpowers/plans` lives in its branch and dies with it — fine for one task's plan, not for a direction's. Link a direction's plan from its tasks; do not copy plan content into the board.

## CLI

```
pm init                                         create the local board
pm task new --title T [--order N] [--deps T-001,T-002] [--milestone M1] [--epic KEY | --epic ""] [--links a,b]
pm set T-003 key=value ...                      status, order, depends_on, waiting_on, milestone, epic, links, title
pm claim T-003                                  attach this worktree, status in_progress
pm log T-003 --did "..." --next "..."           append a Log entry
pm decision --title T --why W --rejected R [--tasks T-001]
pm ready [--epic KEY | --all]                   ready tasks of this worktree's epic (default), of one epic, or all
pm epics                                        every epic: open/total and its focus line
pm validate | pm board | pm summary | pm scan
pm sync on [--remote url] [--yes] | pm sync off | pm sync
```
