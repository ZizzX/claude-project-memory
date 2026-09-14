# Task ↔ git link: history and code undo per task — design

- Date: 2026-09-14
- Board task: T-028 (epic `git`, milestone M5 git)
- Status: approved in chat section by section; awaiting review of this document

## Problem

A board task knows its goal, understanding, log and decisions, but nothing about the code it produced.
`pm claim` records only the worktree name, log entries carry a date without time, and a commit SHA reaches
the board only as free text in the auto log (`hooks.mjs` `onSafetyNote`). "undo T-007" reverts a board edit,
never code.

The author wants to ask "what happened in T-002?" and get: what was done, which decisions were made, the
branch, the commits (sha, author, time), the MR/PR — and then say "remove these changes" or "go back to the
state before this task" and have it done safely.

## Goals

1. Link a task to its code automatically, including commits made by hand outside a Claude session.
2. `pm show T-NNN`: one read-only view of a task's history — timeline, commits, MR/PR, decisions, dependents.
3. Undo a task's code safely: `pm show` computes the exact commands and risks; the agent runs them only
   after explicit user approval, following a protocol in SKILL.md.
4. Work with GitHub and GitLab (including self-hosted), with any merge strategy, and degrade gracefully when
   `gh` / `glab` is missing or offline.
5. Existing boards and tasks behave exactly as before.

## Non-goals

- Copying commit metadata (author, time, message) into the board — git already stores it.
- Commit message trailers (`Task: T-NNN`) or git hooks installed into the project repo.
- A `pm` command that runs destructive git operations on project code.
- Recovering the full commit list of a GitHub "Rebase and merge" PR.
- Showing the new fields on BOARD.md / board.html.

## Decisions

| Decision | Rejected alternatives and why |
|---|---|
| Git is the source of truth; the board stores only what git cannot know: which branch, commits and MR belong to a task. | Storing author/time/message per commit: duplicates git, goes stale after rebase. |
| Commits are captured from the worktree's HEAD reflog. | Session range `head..HEAD` only: misses manual commits between sessions and attributes pulled commits. Commit trailer: T-ids are private board ids meaningless to teammates, GitLab squash drops them, requires discipline or an invasive git hook, ids collide across boards (T-024). |
| Claim/done time and author come from the board's own git history (every `pm` mutation is already a commit). | New `claimed_at` / `done_at` / `author` fields: duplicate data the board repo already has. |
| `pm` never touches project code; `pm show` prints an `undo:` block, the agent executes it by protocol after a "yes". | `pm revert` command: a destructive operation without a conversational confirmation step. Letting the agent compose git commands freely: error-prone. |
| An undo is its own board task with its own branch `revert/T-NNN`. | Reverting in place and only logging on the original task: loses who/when/why, and revert commits would be captured into whatever task is in progress. |

## 1. Data model

Three optional task frontmatter fields:

| Field | Type | Written by |
|---|---|---|
| `branch` | string | `pm claim` (current branch, `git rev-parse --abbrev-ref HEAD`; empty on detached HEAD) |
| `commits` | list of 12-char SHAs | commit capture (section 2); editable with `pm set T-NNN commits=a,b` |
| `pr` | URL string | the agent, right after it creates an MR/PR: `pm set T-NNN pr=<url>` |

- `commits` joins `LIST_FIELDS` in `tasks.mjs`.
- The fields are materialized only when non-empty: a task that never had them serializes byte-for-byte as
  today, even after unrelated writes (`readTaskFile` must not add defaults for them).
- URLs contain `:` and are already quoted by `frontmatter.mjs` `formatValue`.

Local, not synced: the capture cursor `.state/capture-<worktree>.json` = `{ "since": <unix seconds> }`.

## 2. Commit capture

One function, `captureCommits(pm, cwd, now)` in a new `scripts/lib/gitlink.mjs`.

**Source.** `git log -g --date=unix --format=%H|%gd|%gs HEAD` in the worktree (a linked worktree has its own
HEAD reflog). `%gd` renders as `HEAD@{<unix>}`; `%gs` is the reflog subject. Entries with time `>= since` are
processed oldest first.

**Selection by reflog subject prefix:**

| Taken | Skipped |
|---|---|
| `commit:`, `commit (initial):`, `commit (amend):`, `cherry-pick:`, `revert:` | `commit (merge):`, `merge `, `pull`, `reset:`, `checkout:`, `rebase`, `Branch:`, anything else |

- `commit (amend)`: the previous HEAD value (the next older reflog entry) is removed from `commits` if present,
  the new SHA is appended.
- A SHA already in `commits` is not added again (same-second entries, repeated Stop).

**Attribution.** Let `open` = tasks with `status: in_progress` whose `worktrees` contain this worktree.

| `open` | Effect |
|---|---|
| exactly 1 | selected SHAs appended to its `commits` |
| 0 | nothing written |
| ≥ 2 | each open task gets a Log line `- <date> · <worktree> · auto: commits not attributed (N tasks in progress): <sha…> — pm set T-NNN commits=…` |

In every case the cursor moves to `now`.

**Call sites:**

| Where | When |
|---|---|
| `pm claim T-NNN` | first capture for the tasks already open (flush), then write `branch`, then set cursor to now |
| `onStop` | every agent turn, before `persist()` so the capture is committed with `pm: stop` |
| `onSafetyNote` | PreCompact / SessionEnd, next to the existing auto log |
| `pm set T-NNN status=done` | before the status changes, while the task is still in progress |

**Rules:**
- No cursor file (a task claimed before this version): the first capture only creates the cursor, no backfill.
- Commits made before `pm claim` are never captured.
- The capture must not count as a board update for the Stop nudge ("Code changed but the board was not
  updated"): `lastBoardUpdate` reads task-file mtimes, so the capture restores the file's previous mtime
  after writing (`fs.utimesSync`). Mark it with a `ponytail:` comment — the ceiling is that the nudge
  heuristic stays mtime-based; move it to board-commit history if more automatic writes appear.
- Hooks never break a session: capture runs inside the existing hook try/catch; a failing git call means
  "nothing captured".
- Reflog disabled (`core.logAllRefUpdates=false`) or empty: nothing captured; `pm show` prints a hint when a
  task in progress has a `branch` but no `commits`.

## 3. `pm show T-NNN`

Read-only. Prints what the task file does not contain; the agent reads Goal / Understanding from the file.
Runs from any worktree of the repo (object database is shared).

```
T-002 Экспорт кандидатов в CSV · done · epic ATS-1224
branch: feat/ATS-3032-export
pr: https://gitlab.example.com/ats/app/-/merge_requests/412 · merged 2026-09-10 14:02 · squash a1b2c3d · @aziz
timeline: created 2026-09-01 10:12 Aziz Isapov · claimed 2026-09-02 09:30 Aziz Isapov · done 2026-09-09 18:44 Aziz Isapov
commits (3):
  9f1c2ab 2026-09-03 11:20 Aziz Isapov  feat: csv writer
  4d0e7f1 2026-09-04 16:05 Aziz Isapov  fix: escape quotes
  c33a019 (rewritten — not in this repository)
decisions: D-004 Потоковая запись вместо сборки в памяти
depended on by: T-005 (done), T-007 (todo)
undo:
  revert: git revert --no-edit -m 1 a1b2c3d   (MR !412, merge commit)
  before: git switch -c before/T-002 7e6d5c4  (state before the task)
  risk:   T-005 (done) depends on T-002 · same files changed later by 5b1e0aa (T-006), 91cd2f3
```

Labels in the output are English (CLI output convention); task titles and decisions stay as written.

| Line | Source |
|---|---|
| timeline | `git -C <pm> log --reverse --format=%at\|%an\|%s -E --grep=…` matching `^pm: task new T-002$`, `^pm: claim T-002$`, `^pm: set T-002 .*status=(\w+)`; every `status=` change is listed. The id is matched as a whole token (`T-002` must not match `T-0021`). Status edited by hand in the file does not appear. |
| commits | existing SHAs via `git cat-file --batch-check`, then one `git log --no-walk=unsorted --format=…` call; missing ones print `(rewritten — not in this repository)` |
| pr | section 4 |
| decisions | `decisions.md` entries whose `- tasks:` line contains the id; `decisions.mjs` `entries()` learns to parse that line |
| depended on by | tasks whose `depends_on` contains the id, with status |
| undo | section 5; omitted when there is nothing to undo |

Lines with no data are omitted, so an old task shows only its header, timeline, decisions and dependents.
Unknown id → the existing `unknown task T-NNN` error.

## 4. Forge lookup (MR/PR)

In `gitlink.mjs`, pure parsing separated from one exec function.

**URL → API call:**

| URL | Call |
|---|---|
| `https://github.com/<owner>/<repo>/pull/<n>` (or a GitHub Enterprise host) | `gh api [--hostname <host>] repos/<owner>/<repo>/pulls/<n>` → `state`, `merged_at`, `merge_commit_sha`, `user.login` |
| `https://<host>/<group/…/project>/-/merge_requests/<iid>` | `glab api --hostname <host> projects/<url-encoded path>/merge_requests/<iid>` → `state`, `merged_at`, `merge_commit_sha`, `squash_commit_sha`, `author.username` |

Host kind: `github.com` or a URL with `/pull/` → GitHub; a URL with `/-/merge_requests/` → GitLab.

**No `pr`, but `branch` set:** host and project path from `git remote get-url origin` (https and
`git@host:path.git` forms) → list by branch (`pulls?head=<owner>:<branch>&state=all` /
`merge_requests?source_branch=<branch>&state=all`), newest first; printed with `(found by branch)`. `pm show`
does not write it back.

**Degradation:** exec timeout 10 s. CLI missing, not authenticated, offline, non-JSON or unknown URL shape →
print the URL with `(no data: gh/glab unavailable)` and continue. Never exit non-zero because of the forge.

**Test seam:** `PM_FORGE_FIXTURE=<file.json>` — a map from the API path to a response object; when set, no
process is spawned (same pattern as `PM_NO_BACKGROUND`).

Known risk to verify in T-031: the exact `glab api --hostname` behaviour for self-hosted hosts on the
installed glab version; fallback is the `GITLAB_HOST` environment variable for the child process.

## 5. Undo

### 5.1 The `undo:` block

Target selection, first matching case:

| # | Condition | `revert` line |
|---|---|---|
| 1 | MR merged and its merge or squash SHA exists and is an ancestor of HEAD (prefer `merge_commit_sha`, else `squash_commit_sha`) | two parents (`git rev-list --parents -n 1`) → `git revert --no-edit -m 1 <sha>`; one parent → `git revert --no-edit <sha>` |
| 2 | no merged MR; task `commits` that exist and are ancestors of HEAD (`git merge-base --is-ancestor`) | `git revert --no-edit <newest> … <oldest>` (topological order, newest first) |
| 3 | a merge/squash SHA or task commits exist, but none is an ancestor of HEAD (merged into another branch, or still only on the task branch) | no `revert` line; `note: the task's code is not in the current branch` |
| 4 | every SHA rewritten and no merged MR | no `revert` line; `note: commits were rewritten and no merged MR was found — cannot undo automatically` |

`before` line: case 1 → `<sha>^1`; case 2 → `<oldest>^`. Printed as `git switch -c before/T-NNN <base>`.

`risk` line:
- tasks in `depended on by` with status `done`;
- later commits touching the same files: files from `git diff --name-only <base> <target tip>`; commits
  `git log --format=%h <base>..HEAD -- <files>` minus the target commits; each annotated with the task whose
  `commits` contain it, when any.

### 5.2 Protocol: "remove the changes of T-002" / "undo the code of T-002"

Added to SKILL.md:

1. Run `pm show T-002`; show the user the `undo:` block and risks; wait for an explicit yes.
2. Uncommitted changes in the worktree → stop and ask.
3. Create a board task `pm task new --title "<Undo T-002, in the user's language>" --epic <T-002's epic>`, claim it, create branch
   `revert/T-002`. If this worktree already has a task in progress, propose a separate worktree or pausing
   that task first (capture must attribute the revert commits to the undo task).
4. Run the `revert` command. On conflict: stop, show the conflicted files, do not resolve on your own — resolve
   together or `git revert --abort`.
5. Board: Log line on T-002 "undone in T-0NN"; ask whether T-002 becomes `todo` (redo) or `dropped`;
   a non-trivial reason → `pm decision`.

### 5.3 Protocol: "go back to the state before T-002"

Offer, from safest to most dangerous:

1. Default — look or restart from there: `git switch -c before/T-002 <base>`. Nothing is lost.
2. Make the current branch equal the state before T-002: revert every commit in `<base>..HEAD`. Before asking,
   list every other task whose `commits` fall into that range — they are undone too.
3. `git reset --hard <base>`: only when none of the commits in `<base>..HEAD` is on a remote
   (`git branch -r --contains` is empty) and the user explicitly confirms; first create
   `git branch backup/T-002-<date>`. The protocol never force-pushes.

### 5.4 Phrases

| Phrase | Meaning |
|---|---|
| "undo the code of T-002", "remove the changes of T-002", "откати код T-002", "удали изменения T-002" | 5.2 |
| "go back to before T-002", "вернись к состоянию до T-002" | 5.3 |
| "undo the board change", "отмени правку доски" | existing board revert in the pm repo |
| "undo T-002" / "откати T-002" with no qualifier | ask which one |

SKILL.md protocol table, `pm help` phrases and both READMEs are updated accordingly, plus one protocol row:
after creating an MR/PR, `pm set T-NNN pr=<url>`.

## 6. Compatibility

- Tasks without the new fields read, write and render exactly as before; the existing byte-for-byte board
  rendering test stays green, and a new test asserts an old task file is unchanged after an unrelated `pm set`.
- The Stop hook adds one `git log -g` call per turn, only when this worktree has a task in progress.
- `branch` / `commits` / `pr` sync with the board. Two machines appending to the same task's `commits` at once
  produce an ordinary markdown conflict, resolved through the existing `pm sync` path.
- Release: version 0.3.0 bumped as the last step, then reinstall (D-009, README "Development").

## 7. Testing

`node --test`, real git in temp repos via `test/helpers.mjs` (`setup`, `addWorktree`, `cli`).

- Capture: plain commit; amend replaces the SHA; a commit made with plain `git commit` outside any `pm` call is
  captured at the next Stop; fast-forward merge, pull, reset and rebase are skipped; 0 open tasks → nothing;
  2 open tasks → "not attributed" Log lines; nothing before claim; repeated Stop adds no duplicates; missing
  cursor → no backfill; capture does not suppress the Stop nudge.
- `pm show`: timeline from board history (including `T-002` vs `T-0021`); commits with a rewritten SHA;
  decisions; dependents; an old task without the new fields.
- Forge: URL parsing for github.com, GitHub Enterprise, gitlab.com, self-hosted GitLab with subgroups, origin
  in https and ssh form; responses through `PM_FORGE_FIXTURE`; missing CLI → URL only, exit code 0.
- Undo: cases 1–4 including a merge commit needing `-m 1`; risk line with dependents and same-file commits
  mapped to tasks; for cases 1 and 2 the printed `revert` command is executed in the temp repo and the tree
  must equal `<base>` for the task's files.

## 8. Task breakdown (epic `git`)

| Task | Scope | After |
|---|---|---|
| T-029 | Capture: fields `branch` / `commits` / `pr`, reflog cursor, call sites in claim, Stop, PreCompact/SessionEnd, done | T-028 |
| T-030 | `pm show`: timeline, commits, decisions, depended on by | T-029 |
| T-031 | Forge lookup via `gh api` / `glab api`: URL parsing, lookup by branch, timeout, fixture | T-030 |
| T-032 | `undo:` block: cases 1–4, before line, risks | T-031 |
| T-033 | SKILL.md, `pm help`, README (en/ru): undo protocols, phrases, `pr` after MR creation | T-032 |
| T-034 | Bump 0.3.0, reinstall, check on live boards: this plugin (GitHub) and ATS (GitLab) | T-033 |

## Known ceilings

- Commits made before `pm claim`, or in a worktree with no task in progress, are never linked.
- A local rebase rewrites SHAs; they show as rewritten until a merged MR provides the merge/squash SHA.
- GitHub "Rebase and merge": the merged commit list is not recoverable; case 2 applies while the original SHAs
  still exist, case 4 otherwise.
- The Stop nudge stays mtime-based; the capture preserves mtime to stay invisible to it.
