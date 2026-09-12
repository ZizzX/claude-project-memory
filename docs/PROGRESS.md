# Progress snapshot — project-memory plugin

Temporary hand-maintained snapshot so this work can be picked up on another machine. It exists only
until the plugin can carry its own board (Task 16); delete it then.

**Read first:** `docs/superpowers/specs/2026-09-12-project-memory-design.md` (what and why),
then `docs/superpowers/plans/2026-09-12-project-memory.md` (16 tasks, each with the code to write).

## Where the work stands — 2026-09-12

| Tasks | State | Commits (oldest first) |
|---|---|---|
| 1 Plugin skeleton + platform spike | done, review clean | 7744b09 |
| 2 Paths and test helpers | done, review clean | 9b8f9e0 |
| 3 Frontmatter · 6 Decisions and plan | done, review clean | 885fbcb, 4055b4c |
| 4 Task files · 5 Ready queue and validation | done, review clean after 1 fix round | ddca849, a12d80f, 88d6005 |
| 7 Board rendering and board repository | done, review clean | ade0cee |
| 8 Session summary · 9 CLI | done, review clean | 59257b7, 4584c4e |
| 10 Scan other tools' plans · 11 Opt-in sync | done, review clean after 2 fix rounds | 27d92c1, 071a88a, 6fa2f68, 3c01fd4 |
| 12 Memory sync through a link | **next** | — |
| 13 Hooks | not started | — |
| 14 `/pm` skill | not started | — |
| 15 README, license, CI | not started | — |
| 16 Dogfood, push, CI | not started | — |

Suite: 40 tests, `node --test` from the repo root, green on Windows.

## How this is being executed

One subagent implements a task from its brief, a second reviews the diff, findings go through fix
rounds, then the task is marked complete. Briefs are generated from the plan by the
`superpowers:subagent-driven-development` skill's `scripts/task-brief` — regenerate them anywhere,
they are not part of the repo. The controller's ledger (task status, rulings, deferred findings) lives
in `.superpowers/sdd/2026-09-12-project-memory/progress.md`, which is git-ignored; this file is its
shareable summary.

## Decisions taken during implementation (beyond the spec)

- **Commit messages carry no `Co-Authored-By` trailer.** History was rewritten on 2026-09-12 to remove
  them; the `Claude-Session` trailer is kept.
- **Task 9 through Task 13 leave the plugin's `hook` command temporarily unimplemented.** `hooks.json`
  references it from Task 1, Task 9 replaces the spike CLI, Task 13 restores the command. The plugin is
  not installed from this checkout during development, so no session is affected.
- **`PostToolUse` matcher stays `Write|Edit|MultiEdit|ExitPlanMode`.** The Task 1 spike showed a model
  with Bash available can write a plan file through Bash and dodge the nudge. Accepted: the nudge is a
  convenience, and the session summary plus the Stop guard still surface the board.
- **A stale `index.lock` in the board repo is judged orphaned by age (5 minutes), not by whether a
  rebase or merge is in progress.** The first attempt guarded on operation state and was both circular
  (the lock blocked the abort that would clear the state) and unsafe (it could delete a lock held by the
  concurrent background-push process). Cleanup now runs only on the failure path, before the abort.

## Known deferred findings (triage before merge)

- `recentDecisions(pm, 0)` returns everything reversed (`slice(-0)` is `slice(0)`).
- `newTask` leaks a file descriptor if `fs.writeSync` throws.
- `ID_RE` accepts `T-1.md`, looser than the 3-digit-minimum rule.
- `--order` accepts a non-numeric value and stores `NaN`; `--deps`/`--links` split on bare commas.
- `commitPm` sleeps 300 ms after its final failed attempt before returning `false`.
- The "existing local board merges with the remote board" test can only take the conflict branch, so the
  clean-merge path is untested.
- `recordConflict` aborts without clearing a stale lock first (only the no-conflict path does).
- A decisions-log test asserts on a fresh temp dir instead of re-reading the file it just wrote.

## Continuing on another machine

1. Clone the repository and read the spec, the plan and this file.
2. `node --test` to confirm the suite is green.
3. Continue at the first task marked not started, following the plan task by task.
4. What does NOT travel with the repository: the controller's ledger, the subagent reports, and Claude
   Code's per-project auto memory (machine-local by design — that is the problem this plugin fixes).
   Everything needed to continue is in the spec, the plan, this file and `git log`.
