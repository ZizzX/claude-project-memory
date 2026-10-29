---
description: Close this worktree's task — done now, or awaiting merge until its PR lands (project-memory)
argument-hint: "[T-NNN]"
---

The user says the work is finished. Close the task on the board with `pm done`, but only if the conversation
really reached that verdict. Run the CLI exactly as the `[pm]` session summary shows it
(`node "<plugin>/scripts/pm.mjs" <command>`), written below as `pm`.

1. Pick the task: `$ARGUMENTS` if given, else this worktree's single open task from the summary
   (`pm summary`). Several open tasks and no argument → ask which one.
2. Review the conversation against the definition of done:
   - the task's checklist is closed;
   - verification actually ran in this session or is recorded in the task's Log (tests, a run of the app) —
     not "should work";
   - the only thing left is the merge (or nothing, for research, a decision or docs outside git).
3. If anything of this task is unfinished: do not run `pm done`. Name what is missing, log
   `pm log T-NNN --did "…" --next "<exact next step>"`, and offer to pause instead: the next session starts
   from that `next`.
4. Otherwise ask "what's left?" once. Part of this task → step 3. Something outside the task → the triage of
   `/pm` ("Found something outside the task"): fix it now after asking, offer a separate session, or
   `pm later T-NNN "<text>"` — a new task only when the user says so. Then run
   `pm done T-NNN --did "<what was done and how it was verified>"`, adding `--pr <url>` when a PR/MR exists
   and the task has no `pr` yet, or `--no-merge` when nothing of this task will be merged.
5. Tell the user the outcome line `pm done` printed (`→ done` or `→ review` and why) and the epic line under
   it. A task in `review` closes by itself once its merge is seen (at a later session start, or at once with
   `pm reconcile`). `that was the last open task` → ask the user which direction is next (`pm next --options`)
   and update or remove the epic's focus line in `PLAN.md`.
6. End with the board diff line, e.g. `board: T-041 → review (PR #15)`.

Never mark a task done without the verification having run.
