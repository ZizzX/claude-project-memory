---
name: pm
description: Project memory for this repo — accepted plan, task board (statuses, order, dependencies), decision log and session handoff that survive across sessions and worktrees. Use when starting or resuming work; when the user says "what's next", "take the next one", "break it down", "remember …", "we're done", "done, only merge left", "continue in a new session", "the plan changes", "waiting for …", "undo that", "undo the code of T-007", "go back to the state before T-007", "enable board sync", "connect the board", "add the pm alias", "update the plugin", "later", "never", "update it yourself" (Russian: "что дальше", "бери следующую", "разбей", "запомни", "закончили", "готово, закрываем", "продолжим в новой сессии", "план меняется", "ждём", "отмени правку доски", "откати код T-007", "вернись к состоянию до T-007", "включи синхронизацию доски", "подключи доску", "добавь алиас pm", "обнови плагин", "позже", "не напоминай", "обновляй сам"); when a task is finished or partially finished; and when a plan from another tool was just written.
---

# pm — project memory

The board lives outside the repo's branches, shared by every worktree of this repo on this machine:
`<claude-home>/projects/<repo-key>/pm/`. The session summary injected at session start shows the exact
command to run the CLI; below it is written as `pm`. Run it from inside the project.

## What is where

| File | Content | How to change it |
|---|---|---|
| `PLAN.md` | the repository's goal and milestones, `## Current focus` as one line per epic (`- KEY: what is happening now`), `## Changelog`. Shared by every worktree and direction — never touch another epic's lines | edit in place, then append `- <date> · <what changed> · <why> · D-NNN` to Changelog |
| `tasks/T-NNN.md` (or `<PREFIX>-NNN.md` after `pm prefix`; old ids keep theirs, the number continues) | frontmatter + `## Goal`, `## Understanding`, `## Checklist`, `## Log` | CLI for frontmatter and Log; edit Goal / Understanding / Checklist directly |
| `decisions.md` | append-only `## D-NNN · date · title` entries | `pm decision` only |
| `memory/` | Claude Code auto-memory (only when sync is on) | as usual |
| `BOARD.md`, `board.html` | generated views | never edit |

Statuses: `todo | in_progress | waiting | review | done | dropped`. "Waiting on another task" is `depends_on`,
not a status; `waiting` is for external blockers and needs `waiting_on`. `review` = finished and verified,
only the merge is left (set by `pm done`); it closes by itself once its own merge is seen. Ready = `todo` with all
dependencies `done`/`dropped`. A task fits one branch/PR; fine-grained steps live in a linked plan file.
`## Log` stays the last section of a task file.

An **epic** is a direction of work: a free key on a task (`--epic PROJ-12` — a Jira/Linear epic or ticket key,
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
| You believe the task is done | Definition of done: checklist closed AND verification actually ran (tests, a run of the app). Then ask "what's left?": every leftover becomes `pm task new … --deps T-NNN`. Only then `pm done T-NNN --did "…"` — it decides: `done` when nothing is to be merged or the task's own PR is already merged, else `review` until the merge closes it. Tell the user the outcome line it prints. If anything is unfinished, say "partially done", keep the status, and `pm log … --next "<exact next step>"`. |
| `/done`, "done, only merge left", "готово, закрываем" | Follow `/done` (commands/done.md): check the verdict against the definition of done above, then `pm done`. |
| `Merged, still open: …` in the summary | These tasks were merged but are not closed. Ask the user; on yes `pm reconcile --yes` (or `pm set T-NNN status=done` one by one). Never close them on your own. `PR conflict: …` → run `pm reconcile` and show its fix line. `Closed after merge: …` → just mention it. |
| The plugin was just updated to a version with `pm reconcile` (first session after it) | Run `pm reconcile` once, so tasks merged earlier but never closed are listed; then ask as above. |
| "we're done", "continue in a new session" | For every in-progress task of this worktree: `pm log T-NNN --did "…" --next "<exact next step>"`. Update `## Current focus` if it moved. Tell the user `/clear` is safe — the next session starts from the summary. |
| "remember …" | Exactly one place: a decision → `pm decision`; a durable fact about the user or project → auto-memory; a detail of a task → that task's `## Understanding`. |
| "the plan changes" | Edit `PLAN.md` — only your epic's focus line and your own sections — append a Changelog line, record a decision. |
| "waiting for …" | `pm set T-NNN status=waiting waiting_on="…"`. |
| "undo that", "undo the board change" | `git -C <pm dir> log --oneline -5`, then `git -C <pm dir> revert --no-edit <sha>` for the board change in question; `pm board`. |
| "undo the code of T-007", "remove the changes of T-007" | `pm show T-007`, show the user its `undo:` block with the risks and wait for an explicit yes — pm never runs a destructive git command on code itself (D-011). Uncommitted changes in the worktree → stop and ask. Then `pm task new --title "<undo T-007>" --epic <T-007's epic>`, claim it, branch `revert/T-007` (this worktree already has a task in progress → propose a separate worktree or pausing it first, so the revert commits are attributed to the undo task), run the printed `revert` command. On conflict: stop, show the conflicted files, resolve together or `git revert --abort`. Finally `pm log T-007 --did "undone in T-0NN"` and ask whether T-007 becomes `todo` (redo) or `dropped`. |
| "go back to the state before T-007" | Offer, safest first: (1) `git switch -c before/T-007 <base>` from the `before:` line — nothing is lost; (2) make this branch equal that state by reverting every commit in `<base>..HEAD` — first list every other task whose `commits` fall in that range, they are undone too; (3) `git reset --hard <base>` only when `git branch -r --contains` is empty for those commits and the user confirms, after `git branch backup/T-007-<date>`. Never force-push. |
| "undo T-007" with no qualifier | Ask which one: the board change, the code of the task, or the state before it. |
| An MR/PR was created for the task | `pm set T-NNN pr=<url>` — `pm show` then reads its state, merge SHA and author, and the undo block targets the merge commit. |
| A `[pm] plan updated: <path>` line appears | Reconcile: new coarse items → tasks with a link to the plan; items removed from the plan → `status=dropped`. Do not copy the plan's content. |
| No board yet and non-trivial multi-step work starts | `pm init`, fill `PLAN.md` at the repository level: the goal of the product/repo, milestones, `## Current focus` as one line per epic, Changelog. The plan of one direction is a separate file (superpowers, gstack, plan mode) linked from its tasks with `--links` — never copied into `PLAN.md`. Then `pm scan` and import old plans (all boxes ticked → done, some → in_progress, none → todo). Announce it in the board diff line. |
| "enable board sync" / "connect the board" | Run `pm sync on` (no `--yes`) and show the user where the board and memory will be pushed. Only after the user says yes: `pm sync on --yes`. Never enable sync on your own initiative. |
| "add the pm alias" | `pm alias` — it writes to the user's shell profiles, which they asked for; report the files it lists. Never change the PowerShell execution policy yourself: if the output says it blocks the profile, show the command and let the user run it. |
| "disable board sync" | `pm sync off`. |
| "stop syncing my memory" | `git config pm.syncMemory false` only stops *future* linking — it does not undo an already-active link. Tell the user this, then do it manually: move `pm/memory` back to `<claude-home>/projects/<repo-key>/memory` and remove the link/junction. |
| `[pm] update available: <old> → <new> …` in the summary | Offer the five options, do exactly what the user picks, and never change what is installed on your own initiative (the D-011 rule). `pm update` prints this machine's two commands. "update the plugin" → run them, then report the version that landed and that a full restart is needed (a new process, not `/clear`). "later" → `pm update later` (silent for 7 days; a release newer than that one still speaks up). "I'll do it myself" → show the two commands, then `pm update later`. "never" → `pm update never`. "update it yourself, do not ask" → `pm update auto`, then update right away. A line that already says `pm.updateNotify=auto` is the user's standing yes: update without asking and report what landed — an auto run is never silent. |
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
pm set T-003 key=value ...                      status, order, depends_on, waiting_on, milestone, epic, links, title, pr
pm claim T-003                                  attach this worktree, status in_progress (a review task keeps review)
pm log T-003 --did "..." --next "..."           append a Log entry
pm done T-003 [--did "..."] [--pr url | --no-merge]  finished and verified: done, or review until its merge closes it
pm reconcile [--yes] [--no-fetch]               find merged tasks: close review ones, list the rest (--yes closes them)
pm show T-003                                   branch, MR/PR, timeline, commits, decisions, dependents, undo block
pm decision --title T --why W --rejected R [--tasks T-001]
pm ready [--epic KEY | --all]                   ready tasks of this worktree's epic (default), of one epic, or all
pm epics                                        every epic: open/total and its focus line
pm prefix [KEY]                                 show or set the task id prefix (PM → PM-051); old ids keep theirs
pm validate | pm board | pm summary | pm scan | pm help
pm sync on [--remote url] [--yes] | pm sync off | pm sync
pm alias                                        add pm to this machine's shell profiles (PowerShell, bash, zsh)
pm update [later | never | auto | ask]          the update notice: versions, the two commands, snooze or silence it
```
