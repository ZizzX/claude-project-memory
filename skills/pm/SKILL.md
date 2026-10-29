---
name: pm
description: Project memory for this repo: plan, task board, decisions, learnings and session handoff across sessions and worktrees. Use when starting or resuming work, when a task is finished or partly finished, when a plan from another tool was just written, or when the user says: what's next, take the next one, break it down, remember, we're done, done only merge left, continue in a new session, close the session, wrap up, what did we learn, next session starts with, audit the board, the plan changes, waiting for, undo that, undo the code of T-007, enable board sync, connect the board, add the pm alias, update the plugin, later, never (Russian: что дальше, бери следующую, разбей, запомни, закончили, готово закрываем, слил, закрой сессию, продолжим в новой сессии, что узнали нового, в следующей сессии берём, аудит доски, план меняется, ждём, отмени правку доски, откати код T-007, включи синхронизацию доски, подключи доску, добавь алиас pm, обнови плагин, позже, не напоминай).
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
| `learnings/L-NNN.md` | a lesson of this project: `pattern: area.symptom`, `seen`, `tasks`, then `## Symptom`, `## Fix`, `## Apply` | `pm learn` for frontmatter and creation; edit the prose directly |
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
| "what's next?", "что дальше?", or a session starts with no active task and the user did not say what to do | `pm next --options` — one line per choice: `current` (in progress here), `task` (this worktree's queue, the first one is what `pm next` would take), `epic` (another direction with something ready). Ask with AskUserQuestion, one question, header `Next`, up to 4 options in that order: label = the id and a short title (`Continue PM-067`, `PM-070 export`, `Epic APP-12`), description = the rest of its line (the goal, the logged next step or the epic's focus); mark the first `task` "(Recommended)". "Other" is the user's own work: file it with `pm task new` and claim it. Then: a task → `pm claim T-NNN`; an epic → `pm next --epic KEY`; `current` → continue it. Without AskUserQuestion: the same as a numbered list. `(nothing ready)` → ask what to work on. |
| "take the next one", "бери следующую" | `pm next` — claims the head of this worktree's ready queue (the task marked next first) and prints it. A named task → `pm claim T-NNN`. If it says there is no epic for this worktree, do not take another direction's task: start this direction with `pm task new --epic <KEY>` or ask which epic the worktree is for (then `pm next --epic <KEY>`). If it says a task is in progress here, finish or log that one first. After claiming, write `## Understanding` first (how you read the task, open questions). A blocking question → `pm set T-NNN status=waiting waiting_on="…"` and ask it. |
| "break it down", a large request | Create board tasks with `pm task new --title … --epic <KEY> --order N --deps …` (one direction = one epic; the epic is inherited from this worktree's tasks when omitted, `--epic ""` makes a repo-wide task on purpose); put detail in a superpowers plan (if installed) and link it with `--links`. |
| Small work in a repo that has a board (a one-session fix, a review, a question) | Leave the board alone; when the Stop nudge appears, reply that there is nothing to track. File a task afterwards if the work spills into a second session or blocks someone. |
| During work | Refinements → `## Understanding`. A real decision → `pm decision --title … --why … --rejected …`. |
| Found something outside the task (a bug, a small fix, a follow-up, a "later") | Default: no task. (1) It belongs to this task's area and fits this session → ask in one line: "Fix now? <what it touches, how it changes this diff/PR>". Yes → fix it in this task and mention it in its Log; no → `pm later T-NNN "<text>"` (a `later#n` line on the current task). (2) Unrelated to the current work → offer a separate session started now: a one-paragraph prompt the user can paste into a new session or worktree; declined → `pm later T-NNN "<text>"`. (3) A wait tied to an event (release, merge, flag removal, someone's answer) → a wait inside this task is its status (`waiting` with `waiting_on`, or `review` with its PR); one that outlives the task → `pm later`. (4) A task only when the user says so, or for planned work that will not fit this session ("break it down"): `pm task new … --from T-NNN` (`--from` records the origin; a dependency is `--deps`). Several findings at once → one question listing all of them. No task in progress → name it in the final report only. A project rule of the user wins (e.g. "flag tasks are not tracked") → name it in the final report only. A `hint:` line after `pm task new` is this rule speaking: if the user did not ask for that task, say so and ask the user whether to keep it — never drop it on your own. |
| You believe the task is done | Definition of done: checklist closed AND verification actually ran (tests, a run of the app). Then ask "what's left?" once: unfinished parts of this task keep it open (below); anything outside the task goes through the "Found something outside the task" row. Only then `pm done T-NNN --did "…"` — it decides: `done` when nothing is to be merged or the task's own PR is already merged, else `review` until the merge closes it. Tell the user the outcome line it prints, and the epic line under it. If anything is unfinished, say "partially done", keep the status, and `pm log … --next "<exact next step>"`. |
| `Epic X: no open tracked tasks` in the summary, or `that was the last open task` after `pm done` / `pm reconcile` | Ask the user which direction is next (`pm next --options`), then update or remove that epic's focus line in `PLAN.md`. Never invent tasks to fill the epic. |
| `/done`, "done, only merge left", "готово, закрываем" | Follow `/done` (commands/done.md): check the verdict against the definition of done above, then `pm done`. |
| `Merged, still open: …` in the summary | These tasks were merged but are not closed. Ask the user about each; close only the ones confirmed: `pm reconcile --yes T-001,T-004` (a bare `--yes` closes every listed one). Never close them on your own. `PR conflict: …` → run `pm reconcile` and show its fix line. `Closed after merge: …` → just mention it. |
| The plugin was just updated to a version with `pm reconcile` (first session after it) | Run `pm reconcile` once, so tasks merged earlier but never closed are listed; then ask as above. |
| `/close`, "слил", "закрой сессию", "close the session", "wrap up" | Follow `/close` (commands/close.md): every task of this worktree closed or logged with a `next:`, the `retro` skill with `pm learn check` as its gate, `pm next` for the task the next session starts with, then the four wrap-up lines. |
| "we're done", "continue in a new session" | For every in-progress task of this worktree: `pm log T-NNN --did "…" --next "<exact next step>"`. Update `## Current focus` if it moved. Tell the user `/clear` is safe — the next session starts from the summary. |
| "what did we learn", "что узнали нового", a lesson surfaced mid-task | The `retro` skill: `pm learn find <word>` first, then `pm learn add --title … --pattern area.symptom --symptom … --fix … --apply … --tasks T-NNN`, or `pm learn none T-NNN` when there is nothing. Learnings are project lessons; a fact about the user still goes to auto-memory. |
| "next session starts with T-007", "в следующей сессии берём T-007" | `pm next T-007` — a `todo` task, one per epic; the summary's `Ready:` leads with it until it is claimed. |
| `Learnings: …` in the summary | Read them before touching that area; `pm learn show L-NNN` for the fix. When one proved wrong: `pm learn retire L-NNN --why "…"`. |
| `Promote: L-003 …` in the summary | Propose the one-paragraph rule and its target (the repo's CLAUDE.md/AGENTS.md or the skill of that area). Only after the user says yes: write it there with a trailing `Source: L-003` line, then `pm learn promote L-003 --to <file#section>`. Never promote on your own. |
| `[pm] audit: N findings` in the summary, "audit the board", "аудит доски" | `pm audit` — show the lines; `pm audit --fix` only touches dead worktree entries, stale `next` marks and old state files. Everything else (stuck, waiting, orphans, unused learnings, missing retros) is a question to the user, answered with the command each line names. The `stats` line is a measure, not a finding: show it, act on nothing. |
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
| `[pm] This session made … the board was not updated …` (Stop hook) | Log progress on this worktree's task (`pm log`), or reply that there is nothing to track. Never file a task because of this nudge. |

## Waits, reminders and declined findings

| Case | Where it goes |
|---|---|
| Wait inside this task | `waiting` with `waiting_on`, or `review` with its PR — never a second task |
| Declined finding | `later#n` on the current task: `pm later T-NNN "<text>"`; `/close` asks once: keep, make a task (`pm task new … --from T-NNN --later N`), dismiss |
| Planned work for another session | `pm task new … --from T-NNN` |

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
pm next [--epic KEY]                            claim the head of the ready queue (the task marked next first)
pm next --options [--epic KEY]                  the choices for "what's next?": task in progress here, the queue, other epics
pm next T-003 | pm next --clear                 mark the task the next session starts with (one per epic; claim clears it)
pm learn add --title T --pattern area.symptom [--symptom S] [--fix F] [--apply A] [--tasks T-001]
pm learn list [--all] | show L-001 | find <words…>
pm learn promote L-001 --to <file#section> | retire L-001 --why "…"
pm learn none T-003 | check T-003,T-004        the retro checkpoint: nothing learned / who still owes one
pm audit [--fix]                                stale tasks, dead worktrees, unused learnings; --fix: the mechanical part
pm reconcile [--yes [ids]] [--no-fetch]         find merged tasks: close review ones, list the rest (--yes closes the listed, or all)
pm show T-003                                   branch, MR/PR, timeline, commits, decisions, dependents, undo block
pm decision --title T --why W --rejected R [--tasks T-001]
pm ready [--epic KEY | --all]                   ready tasks of this worktree's epic (default), of one epic, or all
pm epics                                        every epic: open/total and its focus line
pm prefix [KEY] [--start N]                     show or set the task id prefix (PM → PM-051); --start: new ids continue from N
pm validate | pm board | pm summary | pm scan | pm help
pm sync on [--remote url] [--yes] | pm sync off | pm sync
pm alias                                        add pm to this machine's shell profiles (PowerShell, bash, zsh)
pm update [later | never | auto | ask]          the update notice: versions, the two commands, snooze or silence it
```
