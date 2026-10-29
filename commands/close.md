---
description: Close this session — every task logged or closed, a retro checkpoint, the next task chosen (project-memory)
argument-hint: "[--no-retro]"
---

The user is ending the session («слил», «закрой сессию», "wrap up", `/close`). Leave the board in a state the next
session can start from without this conversation. Run the CLI exactly as the `[pm]` session summary shows it
(`node "<plugin>/scripts/pm.mjs" <command>`), written below as `pm`. One exchange per step; each step ends with a
CLI call. Never skip a step silently — say what you skipped and why.

1. **Tasks of this worktree.** `pm summary` → the tasks under "Your worktree" are the ones this `/close` owns;
   remember their ids. For each one ask in one line: done, awaiting merge, or paused?
   - done / awaiting merge → the `/done` procedure: the definition of done, then anything
     outside the task through the triage of `/pm`, then `pm done <id> --did "…"` with `--pr <url>` when an
     MR/PR exists. Tell the user the outcome line it prints.
   - paused → `pm log <id> --did "…" --next "<exact next step>"`. Without a concrete `next:` the task is not
     logged — ask until it is.
   - No task here but code changed → "nothing to track" is the default; offer `pm task new` + `pm claim` +
     `pm log` only when the work continues in another session.
   - Then the declined findings: `pm later` lists the open `later#n` items of this worktree's tasks. None →
     say nothing. Otherwise ask one question over all of them: keep all (default) / pick numbers to turn into
     tasks / dismiss all → `pm later <id> --keep all`, `pm task new --title "…" --from <id> --later <n>` for
     each picked one, `pm later <id> --dismiss …`.
2. **Retro.** Invoke the `retro` skill of this plugin. It ends with `pm learn add … --tasks <ids>` for each
   lesson, and `pm learn none <id>` for every id from step 1 that no `learn add` named (a lesson that went to a
   skill, auto-memory or a task still leaves the task without a `retro:` line). Then run `pm learn check <ids>`
   over the ids from step 1: continue only when it prints `ok`. `$ARGUMENTS` containing `--no-retro` → skip the skill
   and run `pm learn none <id>` for each id yourself, so the checkpoint still exists.
3. **Next task.** `pm ready` → ask which task the next session starts with (default: the first ready one;
   "none" when nothing is left) → `pm next <id>`. A paused task of step 1 stays `in_progress` and cannot be
   `next`: the summary already leads with it and its `next:` line, so answer "continue <id>" and run nothing.
   The epic has no open tracked tasks (`pm done` printed `that was the last open task`, or the summary says
   `Epic X: no open tracked tasks`) → ask the user which direction is next (`pm next --options`), then update or
   remove that epic's focus line in `PLAN.md` and append a Changelog line. If `## Current focus` of this epic
   moved, update its line in `PLAN.md` and append a Changelog line.
4. **Wrap.** Print four lines, nothing else:
   - the board diff line (`board: PM-012 → review (MR !41) · PM-013 paused · L-004 · next PM-014`);
   - `next session: <id> <title>` or `next session: nothing chosen`;
   - `worktree <name>: can be removed — nothing of this session lives only here` when `git status --porcelain`
     is empty and `git rev-parse @{u}` exists with no commits ahead (`git status -sb` says so); otherwise
     `worktree <name>: keep — <what is not committed or not pushed>`; when it cannot be told, say so;
   - `/clear is safe — the next session starts from the summary`.

`/close` never removes a worktree, never pushes code, never runs a git command that changes the repository, and
never writes a learning the retro did not produce.
