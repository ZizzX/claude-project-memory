<!-- /autoplan restore point: "C:\\Users\\Aziz\\.gstack\\projects\\ZizzX-claude-project-memory\\ZizzX-git-autoplan-restore-20260927-204312.md" -->
# Merge-aware task closing and session close commands

## Problem

Tasks that were finished and merged keep showing up as open (in progress, waiting,
sometimes todo) in the next session. Today a task only becomes `done` when the agent
runs `pm set T-NNN status=done` in the same session. The merge usually happens later
(GitHub UI, another session, the next morning), so nobody closes the task.

A second gap: when a session ends there is no explicit "we are finished" vs "we pause
here" step. A pause relies on the agent remembering to `pm log --did --next`; the
SessionEnd hook only appends the list of changed files. Screenshots and other context
from the conversation are lost.

Facts from the code (research, 2026-09-27):

- `readyQueue` (scripts/lib/tasks.mjs:190) lists only `todo` tasks; `in_progress` and
  `waiting` never appear in Ready. A merged task stays visible because its status was
  never set to `done`.
- Hooks registered: SessionStart, PostToolUse, Stop, PreCompact, SessionEnd
  (hooks/hooks.json). None reads `transcript_path` from the hook input.
- `scripts/lib/forge.mjs` already reads PR/MR state through `gh api` / `glab api`
  (10 s timeout, no cache, offline → null), including `mergeSha`, `mergedAt`, and
  finds the PR by branch name when `pr` is empty.
- The repo squash-merges: SHAs in `task.commits[]` are never ancestors of
  `origin/master`. Commit subjects on master carry the task id and PR number:
  `feat(T-038): ... (#10)`.
- `captureCommits` (scripts/lib/gitlink.mjs:63) runs on every Stop and attaches
  reflog commits to the single in-progress task of the worktree.

## Goal

1. A merged task closes itself, or the next session asks about it. It is never shown
   as open work again.
2. The user ends a session with one of two words and gets the right outcome:
   - **done** ("готово", "закрываем"): the conversation reached the verdict "task is
     finished, only merge left". The task is marked as awaiting merge and flips to
     `done` automatically once the merge is seen.
   - **pause** ("пауза", "продолжим в новой сессии"): everything needed to continue
     is written down (state, next step, open questions, key files, images), and the
     next session starts from it.
3. If the session is closed without either word, the next session still recovers:
   it knows where the previous transcript is and what was changed.

## Implementation plan

Delivered as two board tasks, one branch/PR each (a pm task fits one branch/PR).
PR 1 closes the complaint (merged tasks shown as open); PR 2 is session continuity.
Local-first by design: no server, no webhook. A GitHub Action that writes the board on
merge was considered and rejected: the board lives outside the repo (and often is not
synced), so CI cannot reach it.

Acceptance, seen by the user:
- First session after installing PR 1: the summary lists every open task already
  merged per the local default-branch refs (commit subject), existing stale tasks
  included, and asks whether to close them; matches only the forge can see follow
  after the background refresh or at once with `pm reconcile`. Nothing closes
  silently that the user did not mark done.
- A task marked done (`/done`) whose PR merges later becomes `done` with no question:
  at the latest at the second session start after the merge (the first start triggers
  the background refresh, the next one applies it), or at once with `pm reconcile`.
- After `/pause`, the next session in the same worktree on the same machine shows the
  handoff and the saved attachment paths; on another machine it shows the handoff
  text and says which attachments stayed on the other machine.

### PR 1 — merge-aware closing

### 1. Merge detection: `scripts/lib/merged.mjs` (new)

`findMerged(pm, cwd, tasks)` returns `[{ id, how, sha, pr, at }]` for open tasks
(`todo | in_progress | waiting | review`) claimed in any worktree, so a merged task
also stops lingering in the summary's `Elsewhere:` line.

Signals:

1. **Default-branch log by task id** (local, no network): one
   `git log <remote>/<default> --since=<oldest candidate's first Log date> --format=%H%x09%ct%x09%s`
   call; match subjects where the id is the conventional-commit scope `type(ID):` or a
   bracket `[ID]`; ids use the board's prefixes (old `T-` and current `pm prefix`).
   Only the subject counts, never the body ("after T-041").
2. **Forge** (network): a new `prLookup(data, cwd)` in forge.mjs returns
   `{ status: 'ok' | 'none' | 'error', pr, cause }` (the existing `prInfo` becomes a
   thin wrapper, so `pm show` keeps working); `normalizePr` also keeps the `base` and
   `head` branch names. A hit is `state == merged` with `base` = the default branch.
   When the task has both `pr` and `branch` and the PR's `head` differs from `branch`,
   the result is a conflict: never auto-closed, listed with both values.
3. No ancestry checks on `commits[]`: squash-merge rewrites SHAs (verified: T-038,
   T-040, PM-056 commits are not ancestors of origin/master).

Default branch: `isDefaultBranch` in forge.mjs becomes exported; resolution order
`origin/HEAD` → `main` → `master`. When `origin/HEAD` is missing, `pm reconcile`
prints the fix once: `git remote set-head origin -a`.

Freshness: one background refresh, the update.mjs `refreshInBackground` pattern
(detached `pm _merge-check`, `windowsHide`, one run at a time via an exclusive lock
file created with `fs.openSync(path, 'wx')` holding pid and start time; a lock older
than 10 minutes is stale and taken over; foreground `pm reconcile` takes the same
lock). It runs
`git fetch --quiet <remote> <default>` in the code repo and the forge lookups (at most
5 per run, oldest `checkedAt` first, so every candidate gets its turn), and stores results per task in hook state `merge-check`
(`{ checkedAt, state, url, base, head, mergeSha, mergedAt, lastError }`, keyed by task
id + PR url, so an entry for an older PR never counts for a new one). A permanent cause
(no forge CLI, not logged in) stops background spawns until `pm reconcile` runs or 24
hours pass. The merge detector adds no synchronous network call to SessionStart (the
existing board sync pull stays as it is): it reads local refs + the cache and starts
the refresh when the cache is older than 30 minutes. `pm reconcile` does the same work in the foreground.
Constants (30 min, 5 calls, 10 min lock, 30 s git timeout, 24 h backoff) are named in merged.mjs with a
`ponytail:` note on their ceiling.

### 2. What closes automatically, what only asks

A detection is a hint unless it is tied to the verdict the user gave:

- **Auto-close** (`review` → `done`, Log line `merged <sha> (#N), closed
  automatically`, `merged_sha` stored) only when the task is
  `review` AND either the forge says the task's own PR (URL equal to the task's current
  `pr`, or found by its branch when `pr` is empty; base = default branch; no head/branch
  conflict) was merged at or after `review_at`, or a subject hit is dated at or after
  `review_at` (the time `pm done` ran). The task file is re-read right before the
  write, and nothing is written if its `status`, `pr` or `review_at` changed. A PR merged before `/done` (first of two PRs) never closes it.
  `git config pm.autoClose false` (the `pm.syncMemory` / `pm.updateNotify` pattern)
  turns every auto-close into an ask.
- **Ask** for every other hit: `Merged, still open: T-012 (#14), T-015 (master a1b2c3)`
  in the summary; SKILL.md tells the agent to ask and then run `pm reconcile --yes`
  or set statuses one by one.
- **Unknown vs not merged:** `pm reconcile` lists `review` tasks older than 7 days as
  `Awaiting merge N days: T-NNN` when a check ran and found no merge, and as
  `Merge not checked: T-NNN (<reason: no forge CLI / offline / no PR>)` when it
  could not check.
- A branch lookup that finds a different PR than the hand-typed `pr` is reported as a
  conflict with both URLs and the fix (`pm set T-NNN pr=<url>`); it is never replaced
  silently (e.g. PM-054 `#8` vs master `#7`).
- `git log` on a missing `<remote>/<default>` ref gives no hits plus a `Merge not
  checked` reason, never an exception. The `origin/HEAD` hint is shown once per repo
  (a state flag).
- `pm show` prints `merged: <sha> (<how>: subject | forge), <date>`.

### 3. `pm reconcile [--yes] [--no-fetch]`

Foreground version of the above without the 5-call cap: it checks every candidate
and prints `checked K of N`; prints the three lists; `--yes` closes the asked
ones. Run once by the agent after installing the update (SKILL.md update row), so the
existing backlog of stale tasks is handled in the first session.

Every failure the new code prints has three parts: what happened, why, and the command
that fixes it, from one helper (`problem — cause — fix: …`), e.g. `Merge not checked:
T-041 — gh is not installed or not logged in — fix: install gh, run gh auth login, then
pm reconcile`. `pm help` points to the README section for details.

### 4. New status `review` ("awaiting merge") and `pm done`

`STATUSES` gains `review`: finished and verified, only merge left. Not Ready; does not
satisfy `depends_on` (already true: readyQueue accepts only done/dropped). Board: its
own column "Ждёт мерджа" between In progress and Done; board.mjs's 5-column grid and
per-status selectors become 6 / a `review` selector; the phone layout keeps working
(board test + opening board.html). Summary: `Awaiting merge: T-NNN (#PR)`. `pm
validate` accepts it. No migration.

`pm done <id> [--did "..."] [--pr url | --no-merge]`:
- requires a Log entry or `--did`;
- order: validate arguments → capture commits (`captureCommits`, as `pm set` already
  does before a status change) → re-read the task → decide → write;
- "expects a merge" means the task has a `pr` or captured `commits`; a `branch` alone
  does not count (`pm claim` always records the branch, so research tasks have one);
  `--no-merge` forces `done`, `--pr <url>` forces the merge path;
- task that does not expect a merge (research, a decision, docs outside git) →
  straight to `done`;
- task that expects a merge: if the forge says its own PR is already merged → `done`;
  otherwise `status=review`, `review_at=<ISO time>`, `pr` stored when known;
- always prints the outcome and why, e.g. `T-041 → review: PR #15 not merged yet;
  closes by itself after the merge (git config pm.autoClose false turns that off)` or
  `T-042 → done: no PR or commits`.

`pm claim` on a `review` task only adds the worktree: status, `branch`, `pr` and
`review_at` stay (continuing implementation is `pm set T-NNN status=in_progress`).

`commands/done.md` (`/done`, or `/project-memory:done` on a name clash): review the
conversation; if the verdict "finished, verified, only merge left" is there, run
`pm done`; if something is unfinished, name it, file leftovers as tasks (`--deps`),
and offer `/pause` instead. Never mark done without the verification having run.

### PR 2 — session continuity

### 5. `pm pause` and the handoff

`pm pause <id> --did "..." --next "..." [--questions "..."] [--files a,b] [--attach img1,img2] [--images-from-transcript [path] [--pick 3,7]]`:
- appends the Log entry (same as `pm log`); status unchanged;
- rewrites one `## Handoff` section above `## Log` (state 3-6 lines, exact next step,
  open questions, key files, attachments, machine name); a missing section is created
  above `## Log`, a hand-moved one is found by its heading, and a file without `## Log`
  gets both;
- `--attach` copies image files into a local, never-synced folder
  `<claude-home>/projects/<repo-key>/pm-attachments/<id>/` (outside `pm/`: `pm/` is
  pushed to the `pm` branch and screenshots must not leave the machine through board
  sync). >5 MB (a named constant with a `ponytail:`
  ceiling note) and non-image files are refused; `<file>.analysis.md` is copied along.
- `--images-from-transcript [path]` extracts pasted base64 images from the session
  JSONL (default: SessionStart stores `{ session_id, transcript_path }` as
  `current-session-<worktree>`; the CLI reads that key, prints which transcript it
  used, and with two live sessions in one worktree takes the latest and says so), newest first, up to 10; when more exist it says so in the handoff
  (`saved 10 of 14 pasted images; older ones not saved`), and older important ones are saved with
  `--images-from-transcript --pick 3,7` from the numbered list the command prints.
  Every field is guarded (Claude Code's internal format); an unknown shape is skipped
  and counted; more than half skipped prints a warning that the transcript format may
  have changed.
- a missing/unreadable transcript or a refused file makes the command exit non-zero
  with the reason, after writing everything else: a partial handoff is never reported
  as complete. Re-running `pm pause` rewrites the handoff and copies only the
  attachments not saved yet (files are named by content sha).

The handoff is shown for this worktree's open tasks of any status (as the summary's
"Your worktree" block lists them), at most 8 lines inside the 40-line summary budget
(`MAX_LINES`), then `full handoff: pm show T-NNN` (`pm show` gains the `## Handoff`
section and attachment paths; today it prints no task body). Attachments not present on this
machine are listed as `(on <machine>)`. Worktree ids are folder names and differ
between machines, so where the paused task is not claimed by this worktree the summary
prints `Paused elsewhere: T-041 (on <machine>, <date>) — pm claim T-041 to continue
here`, and `pm claim` then prints the handoff.

`commands/pause.md` (`/pause`): write the handoff: state, exact next step, open
questions, files touched, and every image that matters (`--attach`,
`--images-from-transcript`).

Natural-language equivalents ("готово, закрываем", "пауза", "продолжим в новой
сессии") map to the same flows through the SKILL.md protocol table.

### 6. Closing without a command

SessionStart stores an immutable `firstStart` in `session-<session_id>` state (the
existing `start` is rewritten after every safety note and cannot be the boundary).
`firstStart` is written only when the key has none, so resume, clear and compact keep
it. `pm done`/`pm pause` write `handoff-<task id>` state `{ at }` per task. SessionEnd
appends `session ended without handoff; transcript: <transcript_path>` to every open
task of this worktree whose mark is missing (read as 0) or older than `firstStart`.
SessionStart then says `Last session ended without a handoff — read the tail of
<transcript>`; SKILL.md tells the agent to read its last ~200 lines and write the
handoff first. No verdict parsing inside hooks.
Two sessions in one worktree at once share the per-task marks
(`ponytail:` note; key by session when the CLI can learn its session id).

### 7. SKILL.md and docs

Protocol rows: done / pause / merged-but-open question / missing handoff / run
`pm reconcile` once after the update. README (en + ru) section "Ending a session" with copy-paste examples: `/done` on a task
without a PR, `/done` waiting for a PR, `/pause` with images, fixing a partial pause,
continuing on another machine (`pm claim`), `pm reconcile --yes`. `pm help` and the
README command and status tables list `done`, `pause`, `reconcile` and `review`, minimal
call first. Upgrade note: an older plugin reading a board with `review` tasks shows
`bad status "review"` in its board-problems line and drops `review` cards from
BOARD.md and board.html (the task files stay); update
every machine that shares the board; to roll back, first `pm set T-NNN
status=in_progress` for each `review` task.
New summary strings are English like the rest of summary.mjs; free text inside them is
the user's language.

### Tests (node:test, test/*.test.mjs)

PR 1:
- merged: subject scope and bracket match, body ignored, mixed `T-`/`PM-` prefixes,
  `--since` bound; forge merged/open/null via `PM_FORGE_FIXTURE`; cache read in
  SessionStart with no spawn of a forge call (spawn stub); refresh lock; wrong `pr`
  → conflict line; `origin/HEAD` missing → main/master + one hint.
- background refresh: runs git with `GIT_TERMINAL_PROMPT=0` and a timeout; a failure
  is stored as `lastError` and printed by `pm reconcile`; a write interrupted between
  temp file and rename leaves the previous cache readable.
- closing rules: review + own PR merged → done; review + subject hit before
  `review_at` → stays review (two-PR case); todo/in_progress/waiting + hit → asked,
  not closed; `--yes` closes; not-checked vs not-merged lists.
- done: claimed task with a branch but no commits/PR → done (research case);
  commits or pr + merged → done; + open → review with `review_at`; `--no-merge` and
  `--pr` overrides; the printed outcome line; `pm.autoClose=false` turns an
  auto-close into an ask.
- reconcile: six forge-only candidates → background runs rotate by `checkedAt`,
  foreground checks all six; failure lines carry problem, cause and fix.
- own-PR contract: hand-typed `pr` pointing at another merged PR → conflict, no close;
  the right PR merged into a non-default base → no close; forge hit merged before
  `review_at` (two-PR case through forge and cache) → stays review; a cache entry for
  an older PR url is ignored after `pm set pr=`; task changed between check and write
  → no write.
- `pm done` right after a commit with no Stop in between → commits captured → review.
- `pm claim` on a review task keeps review, branch, pr and review_at.
- lock: two concurrent `_merge-check` runs plus a foreground reconcile → one holder; a
  lock older than 10 minutes is taken over; a permanent forge failure → no spawn for 24 h.
- missing `<remote>/<default>` ref → not-checked reason, no exception; the origin/HEAD
  hint is printed once per repo.
- board: the 6-column CSS keeps the phone media query (render assertion), plus a
  manual /browse check at 375 px width.
- tasks/board: `review` not in Ready, does not satisfy depends_on, validate accepts
  it; board renders 6 columns and the review selector; escaping unchanged.
PR 2:
- pause: handoff rewritten not appended, `## Log` stays last; attachments outside
  `pm/`, never staged by persist/sync; >5 MB / non-image refused with non-zero exit;
  `.analysis.md` copied; transcript: 10-of-N message, unknown shapes skipped,
  missing transcript → non-zero exit after writing the rest.
- summary: handoff for any open status of the worktree, ≤ 8 lines, total ≤ MAX_LINES,
  `(on <machine>)` for missing attachments.
- cross-machine: a paused task claimed under another worktree name prints the
  `Paused elsewhere` line; `pm claim` there prints the handoff.
- pause: `--pick` saves chosen older images; the default transcript path comes from
  session state; a re-run copies only missing attachments.
- hooks: `firstStart` survives a safety note, resume and compact; SessionEnd writes
  the transcript pointer for each open task whose mark is missing or older than
  `firstStart`; two open tasks, `pm done` on one → the pointer is still written for the
  other.
- transcript key: two sessions in different worktrees → each `pm pause` uses its own
  transcript; more than half skipped shapes → warning.
- handoff surgery: missing section, hand-moved section, file without `## Log`.
- `pm show` prints the full handoff and attachment paths.

## Not in scope

- Parsing the transcript inside hooks to detect a verdict (hooks can't judge; the
  model does it on `/done` and at the next SessionStart).
- Foreground `git fetch` in hooks (the background refresh fetches instead).
- Syncing attachments across machines (local by design; handoff text syncs).
- Prompt-type Stop hook that detects verdicts every turn (deferred: per-turn model cost).
- Opening PRs from `/done` (belongs to /ship).
- Closing tasks from webhooks / CI.
- Mirroring to GitHub issues.


<!-- autoplan-accepted:ceo -->
- Delivery is two board tasks / PRs: PR 1 merge-aware closing (merged.mjs, closing rules, `pm reconcile`, status `review`, `pm done`, `/done`); PR 2 session continuity (`pm pause`, handoff, attachments, transcript images, `/pause`, SessionEnd pointer).
- Merge detection: default-branch commit subjects by task id (scope `type(ID):` or `[ID]`, subject only, board prefixes) and forge PR state; never ancestry of `commits[]`.
- SessionStart never touches the network; one detached background refresh (update.mjs pattern, lock via `checkingSince`, skipped if < 10 min old) runs `git fetch --quiet <remote> <default>` plus at most 5 forge lookups and caches per-task results; started when the cache is older than 30 minutes; `pm reconcile` does the same in the foreground (`--no-fetch` to skip fetch).
- Auto-close only `review` tasks, and only when the forge says the task's own PR is merged or a subject hit is dated at or after `review_at`; every other hit is asked, never closed silently; tests cover the two-PR case.
- `pm reconcile` separates "Awaiting merge N days" (checked, not merged) from "Merge not checked (<reason>)"; lists merged-but-open for existing tasks; SKILL.md tells the agent to run it once after the update.
- Default branch: exported `isDefaultBranch`, order origin/HEAD → main → master; missing origin/HEAD prints `git remote set-head origin -a` once.
- A forge hit by branch corrects a wrong `pr` field; `pm show` prints merge SHA, how it was detected and the date.
- `pm done`: no git link → done; linked and own PR merged → done; else review with `review_at`; requires Log entry or `--did`.
- Board gets a 6th column `review` ("Ждёт мерджа") with its selector; phone layout still works; board test covers it.
- Attachments go to `<claude-home>/projects/<repo-key>/pm-attachments/<id>/`, outside the synced `pm/`; >5 MB and non-image refused; `.analysis.md` copied along.
- `--images-from-transcript` saves up to 10 newest pasted images, states "saved K of N", skips and counts unknown shapes; missing/unreadable transcript or refused file → non-zero exit after writing the rest.
- Handoff shown for this worktree's open tasks of any status, ≤ 8 lines within MAX_LINES, then `full handoff: pm show T-NNN`; attachments absent on this machine are shown as `(on <machine>)`.
- No-handoff detection uses an immutable `firstStart` in session state and `handoff-<worktree>` `{ at }`; the pointer is written only when `at < firstStart`; tests cover a safety note in between and both sides of the boundary.
- New summary strings are English; free text is the user's language.
- The background fetch runs with GIT_TERMINAL_PROMPT=0 and a timeout; cache/state writes are atomic (temp + rename); `merge-check` state keeps `lastError`, shown by `pm reconcile`.
- Not in scope: foreground fetch in hooks, attachment sync, prompt-type Stop hook (deferred), opening PRs from /done (skipped), webhook/CI closing.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Replaces the CEO `pm done` "git link" requirement: a merge is expected only when the task has `pr` or captured `commits` (a `branch` alone does not count); `--no-merge` forces done, `--pr <url>` forces the merge path; the command always prints the resulting status and why; tests cover the research case, both overrides and the outcome line.
- `git config pm.autoClose false` turns every auto-close into an ask; test covers it.
- Background forge checks rotate by oldest `checkedAt` (≤ 5 per run); foreground `pm reconcile` checks every candidate and prints `checked K of N`; test with six forge-only candidates.
- Every failure printed by the new code is `problem — cause — fix: …` from one helper; `pm help` points to the README section; tests assert the three parts on forge-missing, transcript-unreadable and attachment-refused.
- `--images-from-transcript [path]` defaults to this session's `transcript_path` stored by SessionStart; `--pick 3,7` saves chosen older images from the printed numbered list; re-running `pm pause` rewrites the handoff and copies only unsaved attachments (content-sha names); tests cover all three.
- On a machine where the paused task is not claimed by this worktree, the summary prints `Paused elsewhere: T-NNN (on <machine>, <date>) — pm claim T-NNN to continue here`; `pm claim` prints the handoff; test uses two worktree names.
- The 5 MB attachment limit is a named constant with a `ponytail:` ceiling note.
- README (en + ru) "Ending a session" has copy-paste examples for: done without PR, done waiting for PR, pause with images, fixing a partial pause, continuing on another machine, `pm reconcile --yes`; `pm help` and README tables list `done`, `pause`, `reconcile`, `review` with the minimal call first; upgrade note for mixed versions with rollback steps.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- Replaces the CEO requirement "a forge hit by branch corrects a wrong `pr` field": a branch lookup that finds a different PR than `pr` is reported as a conflict with both URLs and the fix `pm set T-NNN pr=<url>`, never rewritten and never auto-closed.
- forge.mjs gains `prLookup` returning `{ status: ok | none | error, pr, cause }`; `normalizePr` keeps `base` and `head`; `prInfo` stays a wrapper so `pm show` output is unchanged; existing forge/show tests stay green.
- A forge hit counts only when base = default branch and the PR is the task's own (URL equal to `pr`, or found by `branch` when `pr` is empty) with no head/branch conflict; for auto-close it must be merged at or after `review_at`; the merge-check cache is keyed by task id + PR url; the task file is re-read before writing and nothing is written if status, pr or review_at changed; tests cover the wrong-pr, non-default-base, merged-before-review_at-through-cache and changed-task cases.
- `pm done` captures commits before deciding (as `pm set` does); tested without a Stop in between.
- Acceptance timing: a `review` task closes at the latest at the second session start after the merge, or at once with `pm reconcile`; forge-only matches for existing tasks appear after the background refresh or `pm reconcile`.
- Replaces the CEO `checkingSince` lock: one exclusive lock file (`fs.openSync(path, 'wx')`, pid + start time, stale after 10 minutes) serializes `_merge-check` and foreground `pm reconcile`; tested with concurrent runs and stale takeover.
- A permanent forge cause (no CLI, not logged in) stops background spawns for 24 hours or until `pm reconcile`; git runs with a named 30 s timeout; a missing default ref yields "Merge not checked" without an exception; the origin/HEAD hint is shown once per repo via a state flag; all tested.
- `pm claim` on a `review` task keeps status, branch, pr and review_at; tested.
- SessionStart stores `current-session-<worktree>` = `{ session_id, transcript_path }`; `pm pause --images-from-transcript` without a path reads it and prints the transcript used; tested with two worktrees.
- Replaces the CEO `handoff-<worktree>` mark: handoff marks are per task (`handoff-<task id>`); a missing mark counts as 0; `firstStart` is written only when absent (resume, clear, compact keep it); SessionEnd writes the pointer for each open task of the worktree whose mark is older than `firstStart`; tested with two open tasks.
- `## Handoff` rewrite handles a missing section, a hand-moved section and a file without `## Log`; more than half skipped transcript shapes prints a warning; `pm show` prints the handoff and attachment paths; all tested.
- The upgrade note says an older plugin drops `review` cards from BOARD.md and board.html (task files stay).
- The board's 6-column CSS keeps the phone media query (render assertion) and gets a manual /browse check at 375 px.
- Replaces the CEO wording "SessionStart never touches the network": the merge detector adds no synchronous network call to SessionStart; the existing board sync pull is unchanged.
<!-- /autoplan-accepted:eng -->
## Review record

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"e0a9e48cec1e3e6ff01ea2292fc79dcbb5dea25303d9e41954f7843d14eb04de","replacements":[{"oldText":"### 1. Merge detection: `scripts/lib/merged.mjs` (new)\n\n`findMerged(pm, cwd, tasks)` returns `[{ id, how, sha, pr, at }]` for open tasks\n(`todo | in_progress | waiting | review`) that are merged into the default branch.\n\nSignals, cheapest first; the first hit wins:\n\n1. **Master log by task id** (local, no network): one\n   `git log <remote>/<default> --since=<oldest open task created> --format=%H%x09%s`\n   call, match subjects with `\\b(T|PM|<prefix>)-\\d+\\b` inside a conventional-commit\n   scope `type(ID):` or `[ID]`. Only a subject match counts, never the body (bodies\n   mention other ids: \"after T-041\").\n2. **Forge** (network, only for tasks with `pr` or a non-default `branch`, and only\n   when signal 1 missed): reuse `prInfo` from forge.mjs; `state == merged` → hit with\n   `mergeSha`. Results are cached per task in hook state (`merge-check` state via\n   `readState`/`writeState`, entry `{ checkedAt, state, url, mergeSha }`).\n   - SessionStart (15 s hook timeout) never calls the forge synchronously: it reads\n     the cache only and, when an entry is older than 30 minutes, starts a detached\n     background refresh (`pm _merge-check`), the same pattern as\n     `refreshInBackground` in update.mjs. The result shows up at the next\n     SessionStart or `pm reconcile`.\n   - `pm reconcile` calls the forge synchronously, at most 5 calls per run, and\n     writes the cache.\n   - A forge answer that finds the PR by branch also corrects a wrong `pr` field\n     (a PR number typed by hand that points to a different PR).\n3. No `git branch --merged` / ancestor checks on `commits[]`: squash-merge breaks\n   them (verified).\n\nThe default branch comes from the existing `isDefaultBranch` helper / `origin/HEAD`.\nNo `git fetch` in hooks: SessionStart already runs the board sync pull; the code\nrepo's remote refs are as fresh as the user's last fetch. `pm reconcile --fetch`\nfetches explicitly.\n\n### 2. Reconcile: `pm reconcile` + SessionStart\n\n`pm reconcile [--fetch] [--yes]`:\n\n- task has `status=review` (the \"done\" verdict was recorded) and is merged →\n  `status=done`, `pr`, `merged_sha` filled, Log line\n  `merged <sha> (#N), closed automatically`. No question: the user already said done.\n- task is `in_progress | waiting | todo` and merged → not closed silently. Printed as\n  `Merged but still open: T-NNN (<how>, <sha>)`; `--yes` closes them.\n- task is `review` for more than 7 days and not merged → listed as\n  `Awaiting merge for N days: T-NNN`.\n\nCandidates include tasks claimed in any worktree, so a merged task no longer lingers\nin the summary's `Elsewhere:` line (in-progress tasks of other worktrees) either.\n\nSessionStart runs the same logic in hook mode: auto-closes the `review` ones and adds\none summary line `Merged, still open: T-012 (#14), T-015 (master a1b2c3) — close them?`.\nSKILL.md tells the agent to ask the user and run `pm reconcile --yes` or set statuses\none by one. A forge failure never blocks the hook (existing null behavior).\n\n### 3. New status `review` (\"awaiting merge\")\n\n`STATUSES` gains `review`. Semantics: work is finished and verified, only merge is\nleft. It is not Ready, it does not unblock `depends_on` (a dependent task must see\nthe code on master), it is shown on the board as its own column\n\"Ждёт мерджа\" between In progress and Done, and in the summary as\n`Awaiting merge: T-NNN (#PR)`. `pm validate` accepts it. Existing boards need no\nmigration.\n\n### 4. Session close: `pm done` and `pm pause`\n\n`pm done <id> [--pr url] [--did \"...\"]`:\n- requires a Log entry or `--did`; sets `status=review`, stores `pr` when known\n  (else the forge lookup by branch fills it at reconcile);\n- if the task is already merged (reconcile check) → straight to `done`.\n\n`pm pause <id> --did \"...\" --next \"...\" [--questions \"...\"] [--files a,b] [--attach img1,img2]`:\n- appends the Log entry (same as `pm log`);\n- rewrites a `## Handoff` section (the single current handoff, above `## Log`):\n  state in 3-6 lines, exact next step, open questions, key files, attachments;\n- `--attach` copies images into a local, never-synced folder\n  `<claude-home>/projects/<repo-key>/pm-attachments/<id>/` (the scratchpad and\n  clipboard paths die with the session) and lists them in the handoff. It is outside\n  `pm/` on purpose: `pm/` is a git repo pushed to the `pm` branch, and screenshots\n  must not leave the machine through board sync. Files over 5 MB and non-image\n  types are refused with a message. A `<file>.analysis.md` next to an image\n  (image-offload) is copied with it.\n- `--images-from-transcript <path>` extracts the base64 image blocks the user pasted\n  into this session's transcript (JSONL) into the same folder, newest first, at most\n  10, so pasted screenshots survive the session too.\n- status stays as it is.\n\nSessionStart summary, for the worktree's in-progress task, prints its `## Handoff`\nplus the attachment paths, so the new session starts with it without re-reading the\ntask file. The summary has a hard 40-line budget (`MAX_LINES` in summary.mjs): the\nhandoff gets at most 8 lines there, followed by `full handoff: pm show T-NNN`.\n\n### 5. Plugin slash commands\n\n`commands/done.md` and `commands/pause.md` in the plugin (available as `/done`,\n`/pause`, or `/project-memory:done` on a name clash). Each is a short prompt:\n\n- `/done`: review the conversation; if the verdict \"finished, verified, only merge\n  left\" is there, run `pm done`; if something is unfinished, say what, file leftovers\n  as tasks (`--deps`), and ask whether to `pause` instead. Never mark done without the\n  verification having actually run (the existing definition of done).\n- `/pause`: write the handoff: state, the exact next step, open questions, the files\n  touched, and every image from the conversation that matters (`--attach`).\n\nNatural-language equivalents (\"готово, закрываем\", \"пауза\", \"продолжим в новой\nсессии\") map to the same flows through the SKILL.md protocol table.\n\n### 6. Closing without a command\n\nSessionEnd hook (already exists, `onSafetyNote`): additionally stores\n`transcript_path` of the ending session in the in-progress task's Log line\n(`session ended without handoff; transcript: <path>`) when no `pm done`/`pm pause`\nran in that session (tracked in session state). SessionStart then says\n`Last session ended without a handoff — read the tail of <transcript>` and SKILL.md\ntells the agent to read the last ~200 lines of that JSONL and write the handoff first.\nNo verdict parsing inside hooks: judging \"is the task finished\" stays with the model.\n\n### 7. SKILL.md and docs\n\nProtocol rows for: done / pause / merged-but-open question / missing handoff. README\n(en + ru) section \"Ending a session\". New summary strings stay in English like the\nrest of the summary template (summary.mjs); the free text inside them (titles, did,\nnext, handoff) is whatever language the user writes in.\n\n### Tests (node:test, test/*.test.mjs)\n\n- merged.test.mjs: subject match by id in scope and brackets; body mention ignored;\n  prefix ids (PM-); forge merged / open / null; cap and cache; SessionStart reads\n  only the cache and spawns no forge call (PM_FORGE_FIXTURE seam + spawn stub);\n  a forge hit by branch corrects a wrong `pr`.\n- attachments: copied outside `pm/`, never staged by `persist`/sync; >5 MB and\n  non-image refused; `.analysis.md` copied along; transcript extraction takes at\n  most 10 images, newest first, and ignores a missing or unreadable transcript.\n- summary: handoff capped at 8 lines, total stays within `MAX_LINES`.\n- reconcile: review+merged → done with Log; in_progress+merged → listed, not closed;\n  `--yes` closes; stale review listed.\n- tasks: `review` not in Ready, does not satisfy depends_on, validate accepts it.\n- done/pause CLI: status transitions, handoff section rewritten not appended,\n  `## Log` stays last, attachments copied, oversize refused.\n- hooks: SessionStart prints handoff and merged line; SessionEnd writes transcript\n  pointer only when no handoff happened.\n- board: `review` column renders; escaping unchanged.\n\n## Not in scope\n\n- Parsing the transcript inside hooks to detect a verdict (hooks can't judge; the\n  model does it on `/done` and at the next SessionStart).\n- Auto `git fetch` in hooks.\n- Closing tasks from webhooks / CI.\n- Mirroring to GitHub issues.","newText":"Delivered as two board tasks, one branch/PR each (a pm task fits one branch/PR).\nPR 1 closes the complaint (merged tasks shown as open); PR 2 is session continuity.\nLocal-first by design: no server, no webhook. A GitHub Action that writes the board on\nmerge was considered and rejected: the board lives outside the repo (and often is not\nsynced), so CI cannot reach it.\n\nAcceptance, seen by the user:\n- First session after installing PR 1: the summary lists every open task that is\n  already merged on the default branch (existing stale tasks included), and asks\n  whether to close them. Nothing closes silently that the user did not mark done.\n- A task marked done (`/done`) whose PR merges later is `done` at the latest in the\n  first session after the merge reaches the local remote refs (background fetch\n  below), with no question.\n- After `/pause`, the next session in the same worktree on the same machine shows the\n  handoff and the saved attachment paths; on another machine it shows the handoff\n  text and says which attachments stayed on the other machine.\n\n### PR 1 — merge-aware closing\n\n### 1. Merge detection: `scripts/lib/merged.mjs` (new)\n\n`findMerged(pm, cwd, tasks)` returns `[{ id, how, sha, pr, at }]` for open tasks\n(`todo | in_progress | waiting | review`) claimed in any worktree, so a merged task\nalso stops lingering in the summary's `Elsewhere:` line.\n\nSignals:\n\n1. **Default-branch log by task id** (local, no network): one\n   `git log <remote>/<default> --since=<oldest candidate's first Log date> --format=%H%x09%ct%x09%s`\n   call; match subjects where the id is the conventional-commit scope `type(ID):` or a\n   bracket `[ID]`; ids use the board's prefixes (old `T-` and current `pm prefix`).\n   Only the subject counts, never the body (\"after T-041\").\n2. **Forge** (network): reuse `prInfo` from forge.mjs for tasks with `pr` or a\n   non-default `branch`; `state == merged` → hit with `mergeSha`, `mergedAt`.\n3. No ancestry checks on `commits[]`: squash-merge rewrites SHAs (verified: T-038,\n   T-040, PM-056 commits are not ancestors of origin/master).\n\nDefault branch: `isDefaultBranch` in forge.mjs becomes exported; resolution order\n`origin/HEAD` → `main` → `master`. When `origin/HEAD` is missing, `pm reconcile`\nprints the fix once: `git remote set-head origin -a`.\n\nFreshness: one background refresh, the update.mjs `refreshInBackground` pattern\n(detached `pm _merge-check`, `windowsHide`, one run at a time via a `checkingSince`\ntimestamp in state, skipped if a run started < 10 minutes ago). It runs\n`git fetch --quiet <remote> <default>` in the code repo and the forge lookups (at most\n5 per run), and stores results per task in hook state `merge-check`\n(`{ checkedAt, state, url, mergeSha, mergedAt }`). SessionStart never touches the\nnetwork: it reads local refs + the cache and starts the refresh when the cache is\nolder than 30 minutes. `pm reconcile` does the same work in the foreground.\nConstants (30 min, 5 calls, 10 min lock) are named in merged.mjs with a\n`ponytail:` note on their ceiling.\n\n### 2. What closes automatically, what only asks\n\nA detection is a hint unless it is tied to the verdict the user gave:\n\n- **Auto-close** (`review` → `done`, Log line `merged <sha> (#N), closed\n  automatically`, `merged_sha` and corrected `pr` stored) only when the task is\n  `review` AND either the forge says the task's own PR (its `pr`, or the PR found by\n  its branch) is merged, or a subject hit is dated at or after `review_at` (the time\n  `pm done` ran). A PR merged before `/done` (first of two PRs) never closes it.\n- **Ask** for every other hit: `Merged, still open: T-012 (#14), T-015 (master a1b2c3)`\n  in the summary; SKILL.md tells the agent to ask and then run `pm reconcile --yes`\n  or set statuses one by one.\n- **Unknown vs not merged:** `pm reconcile` lists `review` tasks older than 7 days as\n  `Awaiting merge N days: T-NNN` when a check ran and found no merge, and as\n  `Merge not checked: T-NNN (<reason: no forge CLI / offline / no PR>)` when it\n  could not check.\n- A forge hit found by branch replaces a wrong hand-typed `pr` (e.g. PM-054 `#8` vs\n  master `#7`).\n- `pm show` prints `merged: <sha> (<how>: subject | forge), <date>`.\n\n### 3. `pm reconcile [--yes] [--no-fetch]`\n\nForeground version of the above; prints the three lists; `--yes` closes the asked\nones. Run once by the agent after installing the update (SKILL.md update row), so the\nexisting backlog of stale tasks is handled in the first session.\n\n### 4. New status `review` (\"awaiting merge\") and `pm done`\n\n`STATUSES` gains `review`: finished and verified, only merge left. Not Ready; does not\nsatisfy `depends_on` (already true: readyQueue accepts only done/dropped). Board: its\nown column \"Ждёт мерджа\" between In progress and Done; board.mjs's 5-column grid and\nper-status selectors become 6 / a `review` selector; the phone layout keeps working\n(board test + opening board.html). Summary: `Awaiting merge: T-NNN (#PR)`. `pm\nvalidate` accepts it. No migration.\n\n`pm done <id> [--pr url] [--did \"...\"]`:\n- requires a Log entry or `--did`;\n- task with no git link (no `branch`, `pr` or `commits`: research, a decision, docs\n  outside git) → straight to `done`;\n- task with a git link: if the forge says its own PR is already merged → `done`;\n  otherwise `status=review`, `review_at=<ISO time>`, `pr` stored when known.\n\n`commands/done.md` (`/done`, or `/project-memory:done` on a name clash): review the\nconversation; if the verdict \"finished, verified, only merge left\" is there, run\n`pm done`; if something is unfinished, name it, file leftovers as tasks (`--deps`),\nand offer `/pause` instead. Never mark done without the verification having run.\n\n### PR 2 — session continuity\n\n### 5. `pm pause` and the handoff\n\n`pm pause <id> --did \"...\" --next \"...\" [--questions \"...\"] [--files a,b] [--attach img1,img2] [--images-from-transcript <path>]`:\n- appends the Log entry (same as `pm log`); status unchanged;\n- rewrites one `## Handoff` section above `## Log` (state 3-6 lines, exact next step,\n  open questions, key files, attachments, machine name);\n- `--attach` copies image files into a local, never-synced folder\n  `<claude-home>/projects/<repo-key>/pm-attachments/<id>/` (outside `pm/`: `pm/` is\n  pushed to the `pm` branch and screenshots must not leave the machine through board\n  sync). >5 MB and non-image files are refused; `<file>.analysis.md` is copied along.\n- `--images-from-transcript` extracts pasted base64 images from the session JSONL,\n  newest first, up to 10; when more exist it says so in the handoff\n  (`saved 10 of 14 pasted images; older ones not saved`), and the agent picks older\n  important ones with `--attach` from the transcript list the command prints.\n  Every field is guarded (Claude Code's internal format); an unknown shape is skipped\n  and counted.\n- a missing/unreadable transcript or a refused file makes the command exit non-zero\n  with the reason, after writing everything else: a partial handoff is never reported\n  as complete.\n\nThe handoff is shown for this worktree's open tasks of any status (as the summary's\n\"Your worktree\" block lists them), at most 8 lines inside the 40-line summary budget\n(`MAX_LINES`), then `full handoff: pm show T-NNN`. Attachments not present on this\nmachine are listed as `(on <machine>)`.\n\n`commands/pause.md` (`/pause`): write the handoff: state, exact next step, open\nquestions, files touched, and every image that matters (`--attach`,\n`--images-from-transcript $transcript`).\n\nNatural-language equivalents (\"готово, закрываем\", \"пауза\", \"продолжим в новой\nсессии\") map to the same flows through the SKILL.md protocol table.\n\n### 6. Closing without a command\n\nSessionStart stores an immutable `firstStart` in `session-<session_id>` state (the\nexisting `start` is rewritten after every safety note and cannot be the boundary).\n`pm done`/`pm pause` write `handoff-<worktree>` state `{ at }`. SessionEnd, when\n`at < firstStart` (no handoff in this session) and this worktree has an open task,\nappends `session ended without handoff; transcript: <transcript_path>` to it.\nSessionStart then says `Last session ended without a handoff — read the tail of\n<transcript>`; SKILL.md tells the agent to read its last ~200 lines and write the\nhandoff first. No verdict parsing inside hooks.\nTwo sessions in one worktree at once share the `handoff-<worktree>` mark\n(`ponytail:` note; key by session when the CLI can learn its session id).\n\n### 7. SKILL.md and docs\n\nProtocol rows: done / pause / merged-but-open question / missing handoff / run\n`pm reconcile` once after the update. README (en + ru) section \"Ending a session\".\nNew summary strings are English like the rest of summary.mjs; free text inside them is\nthe user's language.\n\n### Tests (node:test, test/*.test.mjs)\n\nPR 1:\n- merged: subject scope and bracket match, body ignored, mixed `T-`/`PM-` prefixes,\n  `--since` bound; forge merged/open/null via `PM_FORGE_FIXTURE`; cache read in\n  SessionStart with no spawn of a forge call (spawn stub); refresh lock; wrong `pr`\n  corrected; `origin/HEAD` missing → main/master + one hint.\n- background refresh: runs git with `GIT_TERMINAL_PROMPT=0` and a timeout; a failure\n  is stored as `lastError` and printed by `pm reconcile`; a write interrupted between\n  temp file and rename leaves the previous cache readable.\n- closing rules: review + own PR merged → done; review + subject hit before\n  `review_at` → stays review (two-PR case); todo/in_progress/waiting + hit → asked,\n  not closed; `--yes` closes; not-checked vs not-merged lists.\n- done: no git link → done; linked + merged → done; linked + open → review with\n  `review_at`.\n- tasks/board: `review` not in Ready, does not satisfy depends_on, validate accepts\n  it; board renders 6 columns and the review selector; escaping unchanged.\nPR 2:\n- pause: handoff rewritten not appended, `## Log` stays last; attachments outside\n  `pm/`, never staged by persist/sync; >5 MB / non-image refused with non-zero exit;\n  `.analysis.md` copied; transcript: 10-of-N message, unknown shapes skipped,\n  missing transcript → non-zero exit after writing the rest.\n- summary: handoff for any open status of the worktree, ≤ 8 lines, total ≤ MAX_LINES,\n  `(on <machine>)` for missing attachments.\n- hooks: `firstStart` survives a safety note; SessionEnd writes the transcript\n  pointer only when `at < firstStart`, both sides of the boundary tested.\n\n## Not in scope\n\n- Parsing the transcript inside hooks to detect a verdict (hooks can't judge; the\n  model does it on `/done` and at the next SessionStart).\n- Foreground `git fetch` in hooks (the background refresh fetches instead).\n- Syncing attachments across machines (local by design; handoff text syncs).\n- Prompt-type Stop hook that detects verdicts every turn (deferred: per-turn model cost).\n- Opening PRs from `/done` (belongs to /ship).\n- Closing tasks from webhooks / CI.\n- Mirroring to GitHub issues."}]} -->

### Phase 1 (CEO) — Step 0

Mode: SELECTIVE EXPANSION (autoplan override). Base branch: master (GitHub, origin/HEAD).

**System audit.** 30 recent commits are board/view and update-notice work (PM-051…PM-056,
T-038…T-051); no in-flight PR on this branch; the worktree branch was renamed
ZizzX/conch → ZizzX/git (reflog), which is exactly PM-058's scenario (stale `branch`
field). No CLAUDE.md/TODOS.md in the repo; the board (pm/) is the TODO store.
Taste references: `update.mjs` background refresh + cached state (good pattern to
copy); `forge.mjs` null-on-any-failure (good); `onSafetyNote` in hooks.mjs (good
place to extend). Avoid: summary.mjs growing more ad hoc lines without the budget.

**0A Premises.**
- P1 "merged tasks show as Ready/Waiting". Ready lists only `todo`
  (tasks.mjs:190), so a merged `in_progress` task shows under "Your worktree" or
  "Elsewhere", a `waiting` one under "Waiting". Root cause holds: status is set by
  hand and the merge happens after the session. Accepted, wording corrected.
- P2 "detect the verdict from the conversation". Hooks can't judge; the model
  can, on `/done`, and at the next SessionStart by reading the previous
  transcript's tail. Accepted with that split.
- P3 "save everything including images". Pasted images live only inside the
  transcript JSONL (base64); files on disk may be in a temp dir. Accepted: copy
  both into a local attachments folder.
- Do-nothing cost: every new session starts with stale open tasks; the user
  already bulk-dropped 18 tasks today (D-019) partly out of that noise.

**0B Existing code leverage.**
| Sub-problem | Existing code | Reuse |
|---|---|---|
| PR state, merge SHA | forge.mjs `prInfo`, `normalizePr`, `forgeApi` | reuse as is |
| background network + cache | update.mjs `refreshInBackground`, store `readState/writeState` | copy pattern |
| commit ↔ task | gitlink.mjs `captureCommits` | unchanged; not a merge signal (squash) |
| session end note | hooks.mjs `onSafetyNote` | extend |
| summary | summary.mjs `buildSummary`, `MAX_LINES` | extend within budget |
| Log/next | tasks.mjs `appendLog`, `lastNext` | reuse for pause |
| status set | tasks.mjs `setFields`, `STATUSES` | add `review` |

**0C Dream state.**
```
CURRENT                           THIS PLAN                              12-MONTH IDEAL
status by hand; merge after  -->  merge detected (git subject + forge) -> board mirrors git/forge with no
session leaves tasks open;        review→done automatic; /done /pause     manual status keeping; any session
handoff = one next line           handoff + images; transcript pointer    resumes from an exact handoff
```

**0D Alternatives (approach).**
- A) Plan as written: new `review` status + reconcile + done/pause + commands. (chosen, P1)
- B) Smallest: only `pm reconcile` on SessionStart, no new status, no commands. Leaves
  the "done, only merge left" verdict unrecorded; the user asked for it. Rejected (P1).
- C) Prompt-type Stop hook (LLM evaluates every turn for a verdict). Automatic, but
  costs a model call per turn and is invisible; deferred as TODO (P3/P5).

**0E** Mode handoff: SELECTIVE EXPANSION; hold the core, cherry-pick small in-radius wins.

**0F/0G Cherry-picks** (auto-decided, P2: in blast radius, < 1 day CC):
| # | Proposal | Effort | Decision | Reasoning |
|---|---|---|---|---|
| E1 | Extract pasted images from the transcript into attachments | S | ACCEPTED | user asked for images explicitly |
| E2 | Forge hit by branch corrects a wrong `pr` field | S | ACCEPTED | real mismatch found (PM-054 `#8` vs master `#7`) |
| E3 | Attachments outside the synced `pm/` | S | ACCEPTED | security: sync pushes `pm/` to origin |
| E4 | Background forge refresh instead of sync calls in SessionStart | S | ACCEPTED | 15 s hook timeout vs 10 s per forge call |
| E5 | Prompt-type Stop hook for automatic verdicts | M | DEFERRED | per-turn cost, needs measurement |
| E6 | `/done` opens the PR when none exists | M | SKIPPED | belongs to /ship, not pm |
| E7 | `pm show` prints how the merge was detected | S | ACCEPTED | debuggability of auto-close |

HOLD checks: 9 changed files + 3 new (merged.mjs, commands/done.md, commands/pause.md)
+ tests; one new module. Under the 15-file threshold; no cut proposed.

**0I Temporal interrogation.**
- Hour 1: status list lives in tasks.mjs `STATUSES`; board columns and view model in
  board.mjs key on status names; validate() rejects unknown statuses.
- Hour 2-3: subject regex must accept the board's prefix (`pm prefix`), mixed old
  `T-` and new `PM-` ids; squash subjects end with `(#N)`.
- Hour 4-5: hooks run in every worktree; the detached refresh must not run twice at
  once (reuse a lock/timestamp in state); Windows `spawn` with `windowsHide`.
- Hour 6+: transcript JSONL format for images (`type: "image"`, `source.data`) is
  Claude Code's internal format; guard every field, skip unknown shapes.
Effort: human ~3 days / CC ~2-3 h.

<!-- autoplan-accepted:ceo -->
- Delivery is two board tasks / PRs: PR 1 merge-aware closing (merged.mjs, closing rules, `pm reconcile`, status `review`, `pm done`, `/done`); PR 2 session continuity (`pm pause`, handoff, attachments, transcript images, `/pause`, SessionEnd pointer).
- Merge detection: default-branch commit subjects by task id (scope `type(ID):` or `[ID]`, subject only, board prefixes) and forge PR state; never ancestry of `commits[]`.
- SessionStart never touches the network; one detached background refresh (update.mjs pattern, lock via `checkingSince`, skipped if < 10 min old) runs `git fetch --quiet <remote> <default>` plus at most 5 forge lookups and caches per-task results; started when the cache is older than 30 minutes; `pm reconcile` does the same in the foreground (`--no-fetch` to skip fetch).
- Auto-close only `review` tasks, and only when the forge says the task's own PR is merged or a subject hit is dated at or after `review_at`; every other hit is asked, never closed silently; tests cover the two-PR case.
- `pm reconcile` separates "Awaiting merge N days" (checked, not merged) from "Merge not checked (<reason>)"; lists merged-but-open for existing tasks; SKILL.md tells the agent to run it once after the update.
- Default branch: exported `isDefaultBranch`, order origin/HEAD → main → master; missing origin/HEAD prints `git remote set-head origin -a` once.
- A forge hit by branch corrects a wrong `pr` field; `pm show` prints merge SHA, how it was detected and the date.
- `pm done`: no git link → done; linked and own PR merged → done; else review with `review_at`; requires Log entry or `--did`.
- Board gets a 6th column `review` ("Ждёт мерджа") with its selector; phone layout still works; board test covers it.
- Attachments go to `<claude-home>/projects/<repo-key>/pm-attachments/<id>/`, outside the synced `pm/`; >5 MB and non-image refused; `.analysis.md` copied along.
- `--images-from-transcript` saves up to 10 newest pasted images, states "saved K of N", skips and counts unknown shapes; missing/unreadable transcript or refused file → non-zero exit after writing the rest.
- Handoff shown for this worktree's open tasks of any status, ≤ 8 lines within MAX_LINES, then `full handoff: pm show T-NNN`; attachments absent on this machine are shown as `(on <machine>)`.
- No-handoff detection uses an immutable `firstStart` in session state and `handoff-<worktree>` `{ at }`; the pointer is written only when `at < firstStart`; tests cover a safety note in between and both sides of the boundary.
- New summary strings are English; free text is the user's language.
- The background fetch runs with GIT_TERMINAL_PROMPT=0 and a timeout; cache/state writes are atomic (temp + rename); `merge-check` state keeps `lastError`, shown by `pm reconcile`.
- Not in scope: foreground fetch in hooks, attachment sync, prompt-type Stop hook (deferred), opening PRs from /done (skipped), webhook/CI closing.
<!-- /autoplan-accepted:ceo -->

### Phase 1 (CEO) — dual voices

Spec review loop: 1 launch, PASS 8/10; 2 minor notes applied (CLI↔session
correlation, `isDefaultBranch` export). Scope documents auto-approved (A, P6).

Claude subagent (native, INPUT hash matched `9776014…`), 7 findings: (1) forge cache +
background refresh over-built for a one-user CLI [high]; (2) three features in one
plan, split [medium]; (3) stale remote refs undermine the promise [high];
(4) `origin/HEAD` may be missing on Windows [medium]; (5) "could not check" looks like
"not merged" [medium]; (6) no rationale for polling vs webhook, unexplained constants
[low]; (7) GitHub Projects auto-close exists if published [low].

Codex (outside, completed): (1) done ≠ merged; tasks without git would sit in
`review` forever; (2) existing stale tasks stay unresolved after the update; first
session may not know about a merge; (3) subject-id match must not be the source of
truth for closing (two-PR task; id reuse); (4) "full handoff" undefined: 10 newest
images may miss the important one, local paths don't travel, handoff shown only for
in_progress; silent truncation; (5) `session.start` is rewritten after safety notes
(hooks.mjs:138), so the no-handoff boundary is wrong; parallel sessions share a
worktree mark; (6) scope drifts into a tracker; do explicit done/pause first, merge
detection as a separate capability. Recommendation: revise before implementation.

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                            Claude  Codex  Consensus
  1. Premises valid?                    partly  no     CONFIRMED gaps (stale refs, done≠merged)
  2. Right problem to solve?            yes     yes    CONFIRMED
  3. Scope calibration correct?         no      no     CONFIRMED: split into two PRs
  4. Alternatives sufficiently explored? no     no     CONFIRMED gap (fixed: rationale line)
  5. Competitive/market risks covered?  low     —      DISAGREE (Codex silent) → note only
  6. 6-month trajectory sound?          risk    risk   CONFIRMED: maintenance of forge/tracker logic
```

Dispositions (auto-decided, logged in the audit trail):
- Split into PR 1 / PR 2 — ACCEPTED (both models; matches pm's one-task-one-PR rule).
  Order is a taste choice (see gate).
- Stale refs — ACCEPTED: background refresh also runs `git fetch <remote> <default>`.
- Forge cache/background "over-built" (Claude) — REJECTED as stated: the 15 s hook
  timeout and Codex's freshness finding need it; kept as one refresh reusing the
  update.mjs pattern (DRY). Taste choice, surfaced at the gate.
- origin/HEAD fallback + hint — ACCEPTED. Unknown vs not merged — ACCEPTED.
- Rationale for local polling vs webhook — ACCEPTED (one paragraph).
- done ≠ merged (no git link → done) — ACCEPTED. Existing backlog handled by the
  asked list + `pm reconcile` once after the update — ACCEPTED.
- Auto-close tied to the user's verdict (review + own PR, or a hit dated at or after
  `review_at`) — ACCEPTED. Id reuse: `nextNumber` is max+1 over task files and tasks
  are never deleted (dropped stays), so reuse needs a manually deleted top file;
  covered by the `--since` bound; no extra mechanism (P5).
- Handoff promise defined (files stay on the machine, text travels, any open status,
  "saved K of N", non-zero exit on partial) — ACCEPTED.
- `firstStart` instead of `start` — ACCEPTED (verified: hooks.mjs:138-139 rewrites
  start). Parallel sessions per worktree — `ponytail:` limitation, no mechanism (P5).
- GitHub Projects competition — noted, no plan change (pm is local-first and covers
  GitHub + GitLab).

### Phase 1 (CEO) — review sections

Current scope: SELECTIVE EXPANSION; accepted E1, E2, E3, E4, E7; deferred E5; skipped
E6; plus the dual-voice dispositions above.

**Section 1 — Architecture.**
```
  SessionStart hook ──reads──▶ merge-check cache ◀──writes── pm _merge-check (detached)
        │                       (hook state)                    │  git fetch <remote> <default>
        │                                                       │  forge.mjs prInfo (≤5)
        ▼                                                       ▼
  merged.mjs findMerged ◀── git log <remote>/<default> (local refs)
        │
        ├─ closing rules (review + own PR / hit ≥ review_at) ──▶ tasks.mjs setFields → persist
        └─ asked list ──▶ summary.mjs (≤ MAX_LINES) ──▶ agent asks ──▶ pm reconcile --yes
  pm done / pm pause (CLI) ──▶ tasks.mjs (status, review_at, ## Handoff) + state handoff-<wt>
  pm pause --attach / --images-from-transcript ──▶ pm-attachments/<id>/ (outside pm/, never synced)
  SessionEnd (onSafetyNote) ──▶ compare handoff.at with firstStart ──▶ Log pointer to transcript
```
Task status state machine:
```
 todo ─claim─▶ in_progress ─pm done (git link, PR open)─▶ review ─own PR merged / hit ≥ review_at─▶ done
                    └─pm done (no git link, or own PR already merged)───────────────────────▶ done
 any open ─merged hit, not review─▶ asked ─user yes─▶ done
 blocked: review → done on a hit dated before review_at; reconcile never reopens a done task
```
Detection paths: happy (hit → close/ask); nil (no remote/default ref → signal 1 skipped,
reason recorded); empty (no candidates → no git call, no spawn); error (git/forge
failure → "Merge not checked" with reason). Coupling: merged.mjs depends on forge.mjs
and paths.mjs; summary receives data, not rules. Scale: one `git log` bounded by
`--since`; ≤ 5 forge calls per run. SPOF: none new; a failing background run leaves the
cache stale, visible as "not checked". Rollback: revert the plugin version; tasks in
`review` then fail `validate` on the old version → `pm set T-NNN status=in_progress`
(documented). Findings: 2 (stale refs, start rewrite), both fixed.

**Section 2 — Error & Rescue Map.**
```
  CODEPATH                    | WHAT CAN GO WRONG                     | CLASS
  ----------------------------|---------------------------------------|---------------------
  merged.gitSubjects          | no remote/default ref; git missing    | GitUnavailable
  merged.forgeState (prInfo)  | no gh/glab, auth, offline, 404, JSON  | ForgeUnavailable (null)
  _merge-check (detached)     | concurrent run; fetch credential hang | RefreshSkipped / FetchFailed
  reconcile close             | task file write fails                 | FsWriteError
  pm pause --attach           | missing file, >5 MB, not an image     | AttachRefused
  transcript extraction       | missing file, bad JSON line, shape    | TranscriptUnreadable / ShapeSkipped
  SessionEnd pointer          | no session_id; state unreadable       | NoSession

  CLASS                | RESCUED   | ACTION                                  | USER SEES
  GitUnavailable       | Y         | skip signal, record reason              | "Merge not checked: <reason>"
  ForgeUnavailable     | Y         | null, cache state=unknown + lastError   | "Merge not checked: no forge CLI/offline"
  RefreshSkipped       | Y         | checkingSince lock                      | nothing (next run)
  FetchFailed          | Y         | GIT_TERMINAL_PROMPT=0 + timeout, lastError | "Merge not checked: fetch failed"
  FsWriteError         | N (raise) | CLI exits non-zero with the path        | error, task unchanged
  AttachRefused        | Y         | non-zero exit after writing the rest    | reason per file
  TranscriptUnreadable | Y         | non-zero exit after writing the rest    | "transcript not readable: <path>"
  ShapeSkipped         | Y         | count                                   | "saved K of N, skipped S"
  NoSession            | Y         | no pointer (existing rule)              | nothing
```
GAP found and fixed: a background `git fetch` could hang on a credential prompt → run
with `GIT_TERMINAL_PROMPT=0` and a timeout (obligation added).

**Section 3 — Security.** New surfaces: a detached process (same user, same repo), a
`git fetch` of the existing remote, reading the user's own transcript JSONL, writing
image files. Threats: (a) screenshots leaking through board sync — impact High,
likelihood Med, mitigated by the outside-`pm/` folder (E3); (b) path tricks via
`--attach ../../x` — Low, files are copied by basename into the task folder and the
task id passes the existing `<PREFIX>-NNN` check (a58be4b); (c) transcript content is
untrusted: only image blocks are decoded, nothing is executed or echoed into prompts
beyond file paths; (d) forge tokens stay inside gh/glab. No new secrets, no new
dependencies. Open findings: 0.

**Section 4 — Data flow & edge cases.**
```
 git log subjects ─▶ regex (id as scope or [id]) ─▶ candidates ─▶ closing rule ─▶ close / ask
   shadow: empty log → no hits · id of a done/dropped task → not a candidate ·
           two ids in one subject → both hit (asked unless review + rule) ·
           `fix(T-01)` must not match T-010 (whole-token match)
 transcript JSONL ─▶ per-line JSON.parse ─▶ image blocks ─▶ newest 10 ─▶ files
   shadow: truncated last line → skipped · >5 MB image → refused · same image twice → sha-named, deduped
```
Async ordering: SessionStart reads the cache while `_merge-check` may write it.
Invariant: a reader never sees a torn entry. Mechanism required: state writes via temp
file + rename (implementer confirms `writeState` or switches it — obligation). Two
sessions starting together: the `checkingSince` lock lets one run proceed; the other
reads the previous cache. Interaction edges: `/done` twice → no-op; `/pause` then
`/done` → handoff kept, status moves; `pm reconcile --yes` twice → idempotent.

**Section 5 — Code quality.** One new lib (merged.mjs) holds detection and closing rules;
hooks.mjs stays thin. DRY: reuse forge.mjs and update.mjs's background pattern; extract
a shared `spawnDetached` only if both call sites would duplicate more than a few lines
(P5). Names: `findMerged`, `closingDecision(task, hit)`, `refreshMergeCache`.
`closingDecision` is the only branchy function and gets a table test. No other issues.

**Section 6 — Tests.** Codepath → test: detection (unit, fixture git repo from
test/helpers.mjs `setup`), forge (unit, PM_FORGE_FIXTURE), closing rules (table unit),
reconcile/done/pause (CLI integration via `cli`), hooks (integration, hooks.test.mjs
style), board (render assertion), transcript (fixture JSONL: 12 images, a broken line,
an unknown shape). 2am-Friday test: the two-PR case never auto-closes. Hostile QA:
`fix(T-01): …` does not match T-010. Chaos: `_merge-check` killed mid-write leaves a
readable cache. Flakiness: no real network; time injected via `now` like onStop.

**Section 7 — Performance.** SessionStart adds one `git log` bounded by `--since` and
one state read; no network. Background: one ref fetch + ≤ 5 API calls, at most every
30 minutes. Transcript read line by line. Only issue: the fetch hang (fixed in Section 2).

**Section 8 — Observability.** `pm reconcile` is the debug view; `pm show` prints merge
provenance; every auto-close Log line names SHA and rule. Gap: background failures had
no record → `merge-check` keeps `lastError`, shown by `pm reconcile` (obligation).

**Section 9 — Deployment.** Ships as a plugin release through the existing update notice;
no migration; PR 1 can ship alone. Risk: another machine on an older plugin sharing the
board sees `review` as a bad status in `validate`; README note: update both machines.

**Section 10 — Trajectory.** Reversibility 4/5 (a status value persists in task files).
Debt: named constants with ponytail notes; the per-worktree handoff mark. Next: E5
prompt-type Stop hook if `/done` proves too manual.

**Section 11 — Design.** SKIPPED (no UI scope; the board column is covered in Section 1
and the board test).

**What already exists:** see the 0B table. **NOT in scope:** see "## Not in scope"
(E5 deferred → board task after approval; E6 skipped, belongs to /ship).
**Dream state delta:** after both PRs the board is true for merged work and sessions
resume from a handoff; left for the ideal: automatic verdicts (E5) and attachments
across machines.

**Failure Modes Registry**
```
  CODEPATH           | FAILURE MODE             | RESCUED?          | TEST? | USER SEES?          | LOGGED?
  signal 1 git log   | stale refs               | Y (bg fetch)      | Y     | closes next session | state
  forge lookup       | no CLI / offline         | Y                 | Y     | "Merge not checked" | lastError
  closing rule       | first of two PRs merged  | Y                 | Y     | stays review        | Log
  bg fetch           | credential prompt hang   | Y (no prompt+timeout) | Y | "fetch failed"      | lastError
  cache write        | torn JSON                | Y (atomic write)  | Y     | nothing             | —
  attachments        | leak via sync            | Y (outside pm/)   | Y     | —                   | —
  transcript         | unknown shape            | Y                 | Y     | "skipped S"         | output
  SessionEnd pointer | start rewritten          | Y (firstStart)    | Y     | correct pointer     | Log
```
CRITICAL GAPS: 0.

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | squash-merge repo; branch renamed (PM-058)  |
  | Step 0               | approach A; E1-E4,E7 accepted; E5 deferred  |
  | Section 1  (Arch)    | 2 issues found (fixed)                      |
  | Section 2  (Errors)  | 9 error paths mapped, 1 GAP (fixed)         |
  | Section 3  (Security)| 0 open, 1 High mitigated (sync leak)        |
  | Section 4  (Data/UX) | 9 edge cases mapped, 0 unhandled            |
  | Section 5  (Quality) | 0 issues                                    |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 1 issue (fetch hang, fixed)                 |
  | Section 8  (Observ)  | 1 gap (lastError, fixed)                    |
  | Section 9  (Deploy)  | 1 risk flagged (old plugin, other machine)  |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 2           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 8 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 1 item (E5 → board task)                    |
  | Scope proposals      | 7 proposed, 5 accepted                      |
  | CEO plan             | written                                     |
  | Outside voice        | codex, completed                            |
  | Lake Score           | N/A                                         |
  | Diagrams produced    | architecture, state machine, data flow      |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0 (taste choices go to the final gate)      |
  +====================================================================+
```

### Phase 2 (Design) — skipped, no UI scope

### Phase 2.5 (DX) — Step 0

Mode: DX POLISH (autoplan override). Product type: Claude Code plugin (skill + hooks) with
a CLI (`pm`). Primary type for the assessment: Claude Code Skill; the agent is the main
caller of the CLI, the human reads the summary, board.html and short commands.

```
TARGET DEVELOPER PERSONA
========================
Who:       a developer running several Claude Code sessions in parallel git worktrees
           (Orca), on two machines (Windows + MacBook), board synced between them
Context:   ends sessions many times a day; merges PRs on GitHub after the session
Tolerance: zero manual status keeping; will not read docs to close a task
Expects:   "готово" / "пауза" works; the next session knows what happened
```
Evidence: README "Per-project plan, task board, decision log and session handoff";
memory notes (Orca worktree per task, two synced machines); today's complaint.

**Empathy narrative (predicted, from code and the user's report).** "I finish the task
with Claude, we agree it's done, I merge the PR on GitHub in the evening. Next morning a
new session greets me with the same task under 'Your worktree … [in_progress]' or in
'Elsewhere'. I don't remember whether I closed it. I open GitHub, check, come back and
tell Claude to set it done. When I stop for the day mid-task I say 'продолжим завтра';
sometimes the next session has a one-line `next:`, sometimes nothing, and the
screenshots I pasted are gone. Today I gave up and dropped 18 tasks at once."

**Competitive DX benchmark** (search not run; in-distribution knowledge, labeled):
| Tool | Start → result | Time + evidence | DX choice | Source |
|---|---|---|---|---|
| GitHub Issues/Projects | PR "Closes #12" → issue closed on merge | instant, reported | keyword in PR body, server side | GitHub docs (known) |
| Linear | branch name `ENG-12` → issue moves to Done on merge | instant, reported | branch/PR magic words, webhook | Linear docs (known) |
| Jira + dev panel | commit `ABC-12` → transition on merge | configurable, reported | smart commits / automation rules | Atlassian docs (known) |
| pm today | merge → user says "done" in a later session | minutes + a context switch, observed | manual `pm set` | this repo |
| pm after plan | `/done` → merge → closed at next session start | ≤ 1 session start after refs refresh, estimated | local subject + forge poll | this plan |
Boundaries differ (server webhooks vs local-first); pm cannot be instant without a server,
so the comparable target is "no manual step".

TTHW for this feature (clock: user types `/done` → sees the task awaiting merge; merge →
sees it closed): current ≈ 2-5 min of manual checking per task (estimated); target
(auto-decided, P5 "Competitive"): `/done` result in < 1 min, closure with zero manual
steps at the next session start after the merge is fetched.

**Magical moment** (auto-decided, P5 lowest-effort vehicle): the session-start summary line
`Closed after merge: T-041 (#15)` — the user sees the board fixed itself, no command typed.
Vehicle: existing summary + background refresh (no new UI).

**Journey map**
```
STAGE           | DEVELOPER DOES                         | FRICTION                                  | STATUS
1. Discover     | reads README / pm help                 | new verbs not listed                      | fixed (docs tables, examples)
2. Install      | plugin update (existing notice)        | other machine on old version              | fixed (upgrade note + rollback)
3. Hello World  | says "готово" / types /done            | `done` may yield review silently          | fixed (outcome line)
4. Real Usage   | merges on GitHub, opens next session   | stale refs, forge cap                     | fixed (bg fetch, rotation)
5. Debug        | task did not close                     | "not checked" without a fix               | fixed (problem — cause — fix)
6. Upgrade      | first session after update             | old stale tasks                           | fixed (asked list, reconcile)
```

**First-time developer report**
```
T+0:00  says "готово, закрываем" → /done runs pm done T-041
T+0:05  sees "T-041 → review: PR #15 not merged yet; closes by itself after the merge"
T+0:30  (before fix) research task claimed on a branch went to review → fixed: commits/PR rule
T+next  merges on GitHub, next day opens a session in another worktree
T+next  summary: "Closed after merge: T-041 (#15)" — succeeded, no command
T+pause says "пауза", pasted 12 screenshots → "saved 10 of 12; --pick to save older ones"
T+mac   opens the repo on the MacBook (different folder) → "Paused elsewhere: T-041 … pm claim"
```

### Phase 2.5 (DX) — dual voices

Claude subagent (native, INPUT hash matched `e51d950…`): no critical findings. Upgrade
nudge for shell-only users [medium]; required vs optional flags unclear [low]; `pm done`
may not produce done and does not say so [medium]; `--images-from-transcript` long name
[low]; errors stop at cause, no fix/docs [medium ×3]; examples not a named deliverable
[low/medium]; auto-close has no off switch [high]; attachment limits without override
[medium].

Codex (outside, completed): P1 `pm claim` always records `branch`, so research tasks would
go to review; P1 cross-machine handoff depends on folder names; P1 mixed plugin versions
undefined; P2 forge cap without rotation, foreground not complete; P2 errors lack fix,
images beyond 10 can't be `--attach`ed (they are base64 in JSONL), partial pause re-run
undefined; P2 docs: help, tables, examples, `$transcript` source. Recommendation: revise.

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          yes*    yes*   CONFIRMED plausible (*not measured)
  2. API/CLI naming guessable?         no      no     CONFIRMED: `done` semantics surprising
  3. Error messages actionable?        no      no     CONFIRMED gap
  4. Docs findable & complete?         no      no     CONFIRMED: examples/tables missing
  5. Upgrade path safe?                yes     no     DISAGREE → resolved by accepting Codex fix
  6. Dev environment friction-free?    no      no     CONFIRMED (off switch; cross-machine)
```

Dispositions (auto-decided):
- Research-task misclassification — ACCEPTED: "expects a merge" = `pr` or `commits`;
  `--no-merge` / `--pr` overrides; outcome line always printed (both voices).
- Auto-close off switch — ACCEPTED: `git config pm.autoClose false` (existing config pattern, P4).
- Errors `problem — cause — fix` from one helper — ACCEPTED (both voices, P1).
- Images beyond 10 — ACCEPTED: `--pick` by printed index; default transcript path from
  session state; idempotent re-run.
- Cross-machine — ACCEPTED: `Paused elsewhere … pm claim` line; claim prints the handoff.
- Mixed versions — ACCEPTED (Codex): upgrade note + rollback; verified old CLI only warns.
- Forge rotation + foreground without cap — ACCEPTED (Codex).
- Docs examples/tables/help — ACCEPTED (both).
- Attachment size override — REJECTED as a flag (P5); named constant with `ponytail:` note.
- Shell-only upgrade nudge (Claude) — REJECTED: hooks always run in Claude Code sessions,
  SessionStart shows the asked list without any command; no shell-only mode exists.
- Flag rename `--images-from-transcript` (Claude, cosmetic) — REJECTED (P5, explicit name).

### Phase 2.5 (DX) — passes

Pass 1 Getting started: 6 → 8. Nothing to install beyond the plugin update; first use is
a word ("готово"). Gap was the silent `review` outcome; fixed by the outcome line.
Residual: first merge-close is only seen at the next session start (local-first ceiling).

Pass 2 CLI design: 5 → 8. Verbs `done`, `pause`, `reconcile` fit `claim`/`log`/`show`.
Fixed: `done` rule (commits/PR, not branch), overrides, outcome line; `--pick`; default
transcript path. Minimal calls documented first.

Pass 3 Errors: 4 → 8. Traced: (a) forge missing → `Merge not checked: T-041 — gh is not
installed or not logged in — fix: install gh, run gh auth login, then pm reconcile`;
(b) transcript unreadable → `pm pause: transcript not readable — <path> missing — fix:
pass the path or run without --images-from-transcript`; (c) attachment refused →
`pm pause: x.png not saved — 7.2 MB is over the 5 MB limit — fix: crop it or attach a
smaller copy`. One helper; `pm help` links the README section.

Pass 4 Docs: 5 → 8. README "Ending a session" with six copy-paste scenarios, command and
status tables, `pm help` entries.

Pass 5 Upgrade: 5 → 7. No data migration; older plugin degrades to a warning line;
update both machines; rollback steps. Residual: no version marker on the board.

Pass 6 Environment: 6 → 8. Windows (`windowsHide`, no credential prompt), two machines
with different folder names (Paused elsewhere), off switch via git config.

Pass 7 Community: 6 → 6. MIT, GitHub repo private until release; nothing in this plan
changes it. No issues within scope.

Pass 8 Measurement: 4 → 6. `pm reconcile` output and Log lines (`closed automatically`,
`session ended without handoff`) let /devex-review count auto-closes vs manual closes.
No telemetry added (would be a new policy; not proposed).

Claude Code Skill checklist: SKILL.md protocol rows for the new words (done, pause,
reconcile after update, missing handoff) — in plan; commands/done.md and pause.md are
short prompts — in plan; natural-language triggers in Russian listed — in plan.

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                             |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
| Getting Started      |  8/10  |  6/10  |  ↑     |
| API/CLI/SDK          |  8/10  |  5/10  |  ↑     |
| Error Messages       |  8/10  |  4/10  |  ↑     |
| Documentation        |  8/10  |  5/10  |  ↑     |
| Upgrade Path         |  7/10  |  5/10  |  ↑     |
| Dev Environment      |  8/10  |  6/10  |  ↑     |
| Community            |  6/10  |  6/10  |  =     |
| DX Measurement       |  6/10  |  4/10  |  ↑     |
| TTHW                 | <1 min | 2-5 min|  ↑     |
| Competitive Rank     | Competitive (local-first ceiling)            |
| Magical Moment       | designed via "Closed after merge" summary line |
| Product Type         | Claude Code plugin (skill + CLI)             |
| Mode                 | POLISH                                       |
| Overall DX           |  7.4/10 | 5.1/10 | ↑     |
+====================================================================+
```

```
DX IMPLEMENTATION CHECKLIST
[ ] /done result visible in < 1 min with the outcome line
[ ] research task (branch, no commits/PR) → done
[ ] every failure line: problem — cause — fix
[ ] git config pm.autoClose false downgrades auto-close to ask
[ ] README "Ending a session": six copy-paste scenarios; pm help + tables updated
[ ] upgrade note + rollback steps for mixed versions
[ ] Paused elsewhere line on a machine with a different folder name
[ ] --pick and default transcript path work; re-run is idempotent
```

<!-- autoplan-accepted:dx -->
- Replaces the CEO `pm done` "git link" requirement: a merge is expected only when the task has `pr` or captured `commits` (a `branch` alone does not count); `--no-merge` forces done, `--pr <url>` forces the merge path; the command always prints the resulting status and why; tests cover the research case, both overrides and the outcome line.
- `git config pm.autoClose false` turns every auto-close into an ask; test covers it.
- Background forge checks rotate by oldest `checkedAt` (≤ 5 per run); foreground `pm reconcile` checks every candidate and prints `checked K of N`; test with six forge-only candidates.
- Every failure printed by the new code is `problem — cause — fix: …` from one helper; `pm help` points to the README section; tests assert the three parts on forge-missing, transcript-unreadable and attachment-refused.
- `--images-from-transcript [path]` defaults to this session's `transcript_path` stored by SessionStart; `--pick 3,7` saves chosen older images from the printed numbered list; re-running `pm pause` rewrites the handoff and copies only unsaved attachments (content-sha names); tests cover all three.
- On a machine where the paused task is not claimed by this worktree, the summary prints `Paused elsewhere: T-NNN (on <machine>, <date>) — pm claim T-NNN to continue here`; `pm claim` prints the handoff; test uses two worktree names.
- The 5 MB attachment limit is a named constant with a `ponytail:` ceiling note.
- README (en + ru) "Ending a session" has copy-paste examples for: done without PR, done waiting for PR, pause with images, fixing a partial pause, continuing on another machine, `pm reconcile --yes`; `pm help` and README tables list `done`, `pause`, `reconcile`, `review` with the minimal call first; upgrade note for mixed versions with rollback steps.
<!-- /autoplan-accepted:dx -->

### Phase 3 (Eng) — Step 0 scope challenge

Target: this plan (autoplan, plan file). Existing code per sub-problem: forge.mjs
(`prInfo`, `normalizePr`, `forgeApi`, private `isDefaultBranch`), update.mjs
(`refreshInBackground` detached spawn), store.mjs (`readState`/`writeState`, separate
read and write), gitlink.mjs (`captureCommits`, only `in_progress` tasks), hooks.mjs
(`onSessionStart`, `onSafetyNote` rewrites `start`), tasks.mjs (`STATUSES`, `claim`
sets `in_progress` and `branch`), summary.mjs (`MAX_LINES` 40), show.mjs (no task body),
board.mjs (fixed status columns). Complexity: PR 1 ≈ 8 files + merged.mjs; PR 2 ≈ 6
files + pause code + 2 command files; 1 new module; each PR under the 8-file / 2-class
gate once split, so no complexity selector (P2: never reduce). No TODOS.md in the repo;
deferred items go to the board after approval. Search: in-distribution knowledge
([Layer 1] local polling + lock files are the standard local-first pattern; `wx` open is
the Node built-in for an exclusive create).

### Phase 3 (Eng) — dual voices

Claude subagent (native, INPUT hash matched `f49b110…`): no blockers. Medium: permanent
forge failure respawns every 10 min; "hint once" has no stored state. Low: missing
default ref behavior, stale-lock test, unnamed git timeout, state key namespacing,
handoff section surgery edge cases, transcript format drift needs a visible warning,
board phone layout needs automated coverage (layout reworked in 729f262). Security:
subject spoofing needs push rights and cannot auto-close outside `review` (informational).

Codex (outside, completed): P1 own-PR contract undefined (`prInfo` skips branch lookup
when `pr` is set; no base/head in `normalizePr`); P1 cache keyed by task id can close a
new iteration, forge path ignores `review_at`; P1 `pm done` before a Stop misses fresh
commits; P1 background result applied only a session later, so "first session" promise
is false; P2 timestamp lock is racy; P2 forge `null` hides why a check failed; P1
`pm claim` resets `review`; P1 CLI cannot know its session for the transcript; P1
per-worktree handoff mark hides other open tasks, `undefined < firstStart` is false,
resume/compact boundaries; P2 old board drops `review` cards; `pm show` prints no body;
SessionStart already pulls the board over the network. Recommendation: revise.

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               yes     no     DISAGREE → Codex P1s accepted (verified in code)
  2. Test coverage sufficient?         gaps    gaps   CONFIRMED gaps (added)
  3. Performance risks addressed?      yes     partly CONFIRMED with backoff + lock fixes
  4. Security threats covered?         yes     yes    CONFIRMED
  5. Error paths handled?              gaps    gaps   CONFIRMED (structured forge result, backoff)
  6. Deployment risk manageable?       yes     no     DISAGREE → old-board card loss documented
```

Verification of Codex claims (read in code): forge.mjs `prInfo` returns early when
`data.pr` is set (no branch lookup) — confirmed; `normalizePr` has no base/head —
confirmed; gitlink `captureCommits` filters `in_progress` — confirmed (research report);
`pm set` captures commits before a status change — accepted as stated (pm.mjs:113);
store `readState`/`writeState` are separate calls — confirmed; `claim` sets
`in_progress` unconditionally — confirmed (tasks.mjs:150); hooks `onSessionStart` calls
`pull(pm)` when sync is on — confirmed.

Dispositions (auto-decided, P1/P5; none change the user's direction):
- Own-PR contract (`prLookup` with status/cause, base/head, conflict never auto-closes) — ACCEPTED.
- Cache keyed by task + PR url; forge hit must be merged at or after `review_at`; re-read
  before write — ACCEPTED. This replaces the CEO E2 "correct a wrong `pr`": a mismatch is
  now reported with the fix instead of rewritten (auto-rewrite could pick the wrong PR).
- `pm done` captures commits first — ACCEPTED.
- Acceptance timing weakened to "second session start or `pm reconcile`" — ACCEPTED
  (honest over clever; applying results from the detached process would add concurrent
  board writes).
- Exclusive `wx` lock with stale takeover, shared with foreground reconcile — ACCEPTED.
- Permanent-failure backoff 24 h; named git timeout; hint-once state flag; missing ref →
  not checked — ACCEPTED (Claude voice).
- `pm claim` keeps `review` — ACCEPTED.
- `current-session-<worktree>` key for the transcript, printed path — ACCEPTED.
- Per-task handoff marks; missing mark = 0; `firstStart` written once — ACCEPTED.
- Old board drops `review` cards: upgrade note corrected — ACCEPTED.
- `pm show` prints the handoff; "no synchronous network call added" wording — ACCEPTED.
- Handoff surgery cases; transcript drift warning; board phone check — ACCEPTED.
- State key namespacing (Claude, low) — REJECTED for now (P5): existing state is one
  JSON file per key name (`readState(pm, name)`), so names are already separate files.

### Phase 3 (Eng) — review sections

**1. Architecture.**
```
                 hooks.mjs ──────────────┐
  SessionStart ─▶ onSessionStart ─▶ merged.findMerged(local refs + cache) ─▶ closing rules ─▶ tasks (re-read, write)
       │                 └─(cache stale, lock free)─▶ spawn pm _merge-check ─┐
       │                                                                      ▼
       │                          _merge-check: lock(wx) → git fetch (no prompt, 30 s) → forge.prLookup ≤5 → state merge-check
  pm reconcile ─▶ lock(wx) → same as _merge-check (no cap) → closing rules → print lists
  pm done ─▶ captureCommits → re-read → expectsMerge? → forge.prLookup(own PR) → done | review(review_at)
  pm pause ─▶ appendLog + ## Handoff + attachments (outside pm/) + handoff-<task> state
  SessionEnd ─▶ onSafetyNote + per-task marks vs firstStart ─▶ transcript pointer
  summary.mjs ◀─ data only (asked list, awaiting merge, handoff ≤ 8 lines, paused elsewhere)
```
Coupling: merged.mjs → forge.mjs, paths.mjs, store.mjs; hooks stay thin. Realistic
failure: gh logged out → `prLookup` error with cause → "Merge not checked … fix: gh auth
login", backoff 24 h. Distribution: no new artifact; ships in the plugin release.

**2. Code quality.** One new module; `closingDecision(task, hit, now)` is the branchy
unit (≤ 5 branches after the contract is explicit). Shared code: `spawnDetached` between
update.mjs and merged.mjs — two verified callers (update.mjs:110 and the new refresh),
≈ 6 lines each; extract only if identical (implementer decides, low value). Error paths:
structured forge result replaces silent `null` for the new caller; `prInfo` keeps its
contract for `pm show`.

**3. Tests.**
```
CODE PATHS (planned)                                      USER FLOWS
[+] merged.findMerged                                      [+] /done → awaiting merge → merge → closed
  ├── subject hit (scope/bracket/prefix/body ignored) [GAP→planned]   ├── [GAP→planned] second session closes
  ├── forge hit (base=default, head=branch)            [GAP→planned]   └── [GAP→planned] pm reconcile closes at once
  ├── conflict pr vs branch                            [GAP→planned] [+] research task /done → done
  ├── missing default ref → not checked                [GAP→planned] [+] /pause with images → next session shows it
  └── cache keyed by url, older url ignored            [GAP→planned] [+] other machine → Paused elsewhere → claim
[+] closingDecision: review+own PR ≥ review_at / before / non-review / autoClose off [GAP→planned]
[+] _merge-check: lock, stale takeover, backoff, lastError, torn write          [GAP→planned]
[+] pm done: commits captured first, no-merge/pr overrides, outcome line          [GAP→planned]
[+] pm claim on review                                                              [GAP→planned]
[+] pause: handoff surgery 3 cases, attachments, transcript key/pick/drift warning [GAP→planned]
[+] SessionEnd: firstStart once, per-task marks, missing mark                       [GAP→planned]
[+] board: 6 columns + phone media query (render) [manual /browse 375 px]          [GAP→planned]
[+] REGRESSION: prInfo contract for pm show unchanged — existing show.test.mjs/forge.test.mjs must stay green [★★ TESTED today]
COVERAGE today: 0 of the new paths (all planned); existing regression suites: show, forge, hooks, tasks, board.
```
Regression rule: `prInfo` callers (pm show) and `captureCommits` behavior are at risk;
the plan keeps `prInfo` as a wrapper and requires existing suites green (carried as an
obligation). Test plan artifact written (path in the report).

**4. Performance.** SessionStart: one bounded `git log` + one state read; no forge call.
Background: ≤ 1 fetch + ≤ 5 API calls per 30 min, none for 24 h after a permanent
failure. Transcript: line-by-line read. No issues left.

**Failure modes registry**
```
  CODEPATH           | FAILURE                                  | TEST | ERROR HANDLING         | USER SEES
  forge lookup       | wrong hand-typed pr points to merged PR  | Y    | conflict, no close     | conflict line + fix
  closing rules      | old PR merged before /done               | Y    | review_at check        | stays awaiting merge
  pm done            | commit not yet captured                  | Y    | capture first          | correct review
  pm claim           | review reset on another machine          | Y    | keep review            | still awaiting merge
  _merge-check       | two runs at once                         | Y    | wx lock                | nothing
  _merge-check       | gh missing forever                       | Y    | 24 h backoff           | "Merge not checked … fix"
  SessionEnd         | other open task hidden by shared mark    | Y    | per-task marks         | pointer written
  pm pause           | wrong session transcript                 | Y    | worktree key + printed | path shown
  old plugin         | review cards vanish                      | doc  | upgrade note           | documented
```
CRITICAL GAPS: 0.

**Worktree parallelization:** PR 1 and PR 2 touch shared modules (tasks.mjs,
summary.mjs, hooks.mjs, SKILL.md). Sequential implementation: PR 1, then PR 2.

**Completion summary (Eng):** Step 0: scope accepted as-is (split already decided) ·
Architecture: 5 issues (own-PR contract, iteration cache, apply timing, lock, claim) ·
Code quality: 2 (structured forge result, spawn helper note) · Tests: diagram produced,
12 planned groups, regression suites named · Performance: 1 (permanent-failure
backoff) · NOT in scope: written · What already exists: written · TODOS: 1 (E5 → board
task) · Failure modes: 0 critical gaps · Unresolved decisions: 0 · Outside voice: codex
completed · Parallelization: 1 lane, sequential · Lake Score: N/A (auto-decided).

<!-- autoplan-accepted:eng -->
- Replaces the CEO requirement "a forge hit by branch corrects a wrong `pr` field": a branch lookup that finds a different PR than `pr` is reported as a conflict with both URLs and the fix `pm set T-NNN pr=<url>`, never rewritten and never auto-closed.
- forge.mjs gains `prLookup` returning `{ status: ok | none | error, pr, cause }`; `normalizePr` keeps `base` and `head`; `prInfo` stays a wrapper so `pm show` output is unchanged; existing forge/show tests stay green.
- A forge hit counts only when base = default branch and the PR is the task's own (URL equal to `pr`, or found by `branch` when `pr` is empty) with no head/branch conflict; for auto-close it must be merged at or after `review_at`; the merge-check cache is keyed by task id + PR url; the task file is re-read before writing and nothing is written if status, pr or review_at changed; tests cover the wrong-pr, non-default-base, merged-before-review_at-through-cache and changed-task cases.
- `pm done` captures commits before deciding (as `pm set` does); tested without a Stop in between.
- Acceptance timing: a `review` task closes at the latest at the second session start after the merge, or at once with `pm reconcile`; forge-only matches for existing tasks appear after the background refresh or `pm reconcile`.
- Replaces the CEO `checkingSince` lock: one exclusive lock file (`fs.openSync(path, 'wx')`, pid + start time, stale after 10 minutes) serializes `_merge-check` and foreground `pm reconcile`; tested with concurrent runs and stale takeover.
- A permanent forge cause (no CLI, not logged in) stops background spawns for 24 hours or until `pm reconcile`; git runs with a named 30 s timeout; a missing default ref yields "Merge not checked" without an exception; the origin/HEAD hint is shown once per repo via a state flag; all tested.
- `pm claim` on a `review` task keeps status, branch, pr and review_at; tested.
- SessionStart stores `current-session-<worktree>` = `{ session_id, transcript_path }`; `pm pause --images-from-transcript` without a path reads it and prints the transcript used; tested with two worktrees.
- Replaces the CEO `handoff-<worktree>` mark: handoff marks are per task (`handoff-<task id>`); a missing mark counts as 0; `firstStart` is written only when absent (resume, clear, compact keep it); SessionEnd writes the pointer for each open task of the worktree whose mark is older than `firstStart`; tested with two open tasks.
- `## Handoff` rewrite handles a missing section, a hand-moved section and a file without `## Log`; more than half skipped transcript shapes prints a warning; `pm show` prints the handoff and attachment paths; all tested.
- The upgrade note says an older plugin drops `review` cards from BOARD.md and board.html (task files stay).
- The board's 6-column CSS keeps the phone media query (render assertion) and gets a manual /browse check at 375 px.
- Replaces the CEO wording "SessionStart never touches the network": the merge detector adds no synchronous network call to SessionStart; the existing board sync pull is unchanged.
<!-- /autoplan-accepted:eng -->

<!-- AUTONOMOUS DECISION LOG -->
### Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan CEO override | other modes |
| 2 | CEO | Approach A (full plan) | Mechanical | P1 | user asked for both halves | B minimal, C prompt Stop hook |
| 3 | CEO | Accept E1 transcript images | Mechanical | P1/P2 | explicit user ask, S effort | — |
| 4 | CEO | Accept E2 wrong `pr` correction | Mechanical | P2 | real data mismatch | — |
| 5 | CEO | Accept E3 attachments outside pm/ | Mechanical | P1 | sync leak risk | pm/attachments |
| 6 | CEO | Accept E4 background forge refresh | Taste | P1 vs P5 | 15 s hook timeout; Claude voice calls it over-built | reconcile-only forge |
| 7 | CEO | Defer E5 prompt-type Stop hook | Mechanical | P3 | per-turn cost unmeasured | build now |
| 8 | CEO | Skip E6 PR creation from /done | Mechanical | P4 | duplicates /ship | — |
| 9 | CEO | Accept E7 merge provenance in pm show | Mechanical | P2 | debuggability | — |
| 10 | CEO | Spec notes: CLI↔session correlation, export isDefaultBranch | Mechanical | P5 | reviewer PASS notes | — |
| 11 | CEO | Split into PR 1 / PR 2 | Mechanical | P5 | both voices; one task = one PR | one PR |
| 12 | CEO | PR order: merge-closing first, continuity second | Taste | P6 | closes the stated complaint first; Codex preferred done/pause first | continuity first |
| 13 | CEO | Background fetch of default branch | Mechanical | P1 | both voices: stale refs | fetch in foreground |
| 14 | CEO | Auto-close only review + own PR / hit ≥ review_at | Mechanical | P1 | Codex two-PR false close | close on any hit |
| 15 | CEO | done without git link → done | Mechanical | P1 | Codex: review forever | always review |
| 16 | CEO | Unknown vs not merged lists | Mechanical | P1 | Claude voice | single list |
| 17 | CEO | firstStart boundary | Mechanical | P1 | verified start rewrite | start |
| 18 | CEO | Handoff promise: any open status, K of N, non-zero on partial | Mechanical | P1 | Codex | silent truncation |
| 19 | CEO | GIT_TERMINAL_PROMPT=0, atomic state writes, lastError | Mechanical | P1 | error map gaps | — |
| 20 | DX | Mode DX POLISH, persona multi-worktree dev on two machines | Mechanical | override/P6 | README + memory evidence | — |
| 21 | DX | TTHW target Competitive, magical moment = summary line | Mechanical | P5 | local-first ceiling | Champion (needs server) |
| 22 | DX | done expects merge only with pr/commits; overrides; outcome line | Mechanical | P1 | Codex P1 verified tasks.mjs:150 | branch counts |
| 23 | DX | pm.autoClose off switch | Mechanical | P4 | existing git config pattern | no switch |
| 24 | DX | problem — cause — fix helper | Mechanical | P1 | both voices | ad hoc messages |
| 25 | DX | --pick, default transcript path, idempotent re-run | Mechanical | P1 | Codex | --attach for base64 |
| 26 | DX | Paused elsewhere line | Mechanical | P1 | Codex verified paths.mjs worktreeName | same-name assumption |
| 27 | DX | Mixed-version upgrade note + rollback | Mechanical | P1 | Codex; old CLI only warns (verified) | board version marker |
| 28 | DX | Forge rotation; foreground without cap | Mechanical | P1 | Codex | fixed first 5 |
| 29 | DX | Attachment limit override flag | Mechanical | P5 | named constant + ponytail note instead | --force flag |
| 30 | DX | Shell-only upgrade nudge | Mechanical | P5 | hooks always run in sessions | version marker nudge |
| 31 | Eng | Own-PR contract via prLookup (status/cause, base/head, conflict) | Mechanical | P1 | Codex P1, verified forge.mjs | reuse prInfo as is |
| 32 | Eng | Report pr/branch mismatch instead of rewriting pr (replaces CEO E2) | Mechanical | P5 | rewrite could pick the wrong PR | auto-correct pr |
| 33 | Eng | Cache keyed by task + PR url; forge hit ≥ review_at; re-read before write | Mechanical | P1 | Codex P1 | task-id cache |
| 34 | Eng | pm done captures commits first | Mechanical | P1 | Codex P1, matches pm set | decide on stale commits |
| 35 | Eng | Weaken timing to second session start / pm reconcile | Mechanical | P5 | honest promise, no concurrent writer | detached process writes board |
| 36 | Eng | wx lock file shared with reconcile | Mechanical | P1 | Codex P2, stdlib | timestamp in state |
| 37 | Eng | 24 h backoff, git timeout, hint-once flag, missing ref → not checked | Mechanical | P1 | Claude voice | respawn every 10 min |
| 38 | Eng | pm claim keeps review | Mechanical | P1 | Codex P1, tasks.mjs:150 | reset to in_progress |
| 39 | Eng | current-session-<worktree> transcript key | Mechanical | P1 | Codex P1 | session state by id |
| 40 | Eng | Per-task handoff marks, firstStart once | Mechanical | P1 | Codex P1 | per-worktree mark |
| 41 | Eng | Upgrade note: old board drops review cards | Mechanical | P1 | Codex P2, board.mjs columns | "keeps working" |
| 42 | Eng | Handoff surgery cases, drift warning, pm show body, phone check | Mechanical | P1 | Claude + Codex | — |
| 43 | Eng | State key namespacing | Mechanical | P5 | state is one file per key already | prefixes |
| 44 | Eng | Sequential PR 1 → PR 2 | Mechanical | P5 | shared modules | parallel lanes |

<!-- autoplan-baseline-edits:dx {"sourceSha256":"3044a73817b7a958dad5fa3d3e86003cd8c18ee3da5b96f1315db41ff0326318","replacements":[{"oldText":"- task with no git link (no `branch`, `pr` or `commits`: research, a decision, docs\n  outside git) → straight to `done`;\n- task with a git link: if the forge says its own PR is already merged → `done`;\n  otherwise `status=review`, `review_at=<ISO time>`, `pr` stored when known.","newText":"- \"expects a merge\" means the task has a `pr` or captured `commits`; a `branch` alone\n  does not count (`pm claim` always records the branch, so research tasks have one);\n  `--no-merge` forces `done`, `--pr <url>` forces the merge path;\n- task that does not expect a merge (research, a decision, docs outside git) →\n  straight to `done`;\n- task that expects a merge: if the forge says its own PR is already merged → `done`;\n  otherwise `status=review`, `review_at=<ISO time>`, `pr` stored when known;\n- always prints the outcome and why, e.g. `T-041 → review: PR #15 not merged yet;\n  closes by itself after the merge (git config pm.autoClose false turns that off)` or\n  `T-042 → done: no PR or commits`."},{"oldText":"A PR merged before `/done` (first of two PRs) never closes it.","newText":"A PR merged before `/done` (first of two PRs) never closes it.\n  `git config pm.autoClose false` (the `pm.syncMemory` / `pm.updateNotify` pattern)\n  turns every auto-close into an ask."},{"oldText":"and the forge lookups (at most\n5 per run)","newText":"and the forge lookups (at most\n5 per run, oldest `checkedAt` first, so every candidate gets its turn)"},{"oldText":"Foreground version of the above; prints the three lists;","newText":"Foreground version of the above without the 5-call cap: it checks every candidate\nand prints `checked K of N`; prints the three lists;"},{"oldText":"existing backlog of stale tasks is handled in the first session.","newText":"existing backlog of stale tasks is handled in the first session.\n\nEvery failure the new code prints has three parts: what happened, why, and the command\nthat fixes it, from one helper (`problem — cause — fix: …`), e.g. `Merge not checked:\nT-041 — gh is not installed or not logged in — fix: install gh, run gh auth login, then\npm reconcile`. `pm help` points to the README section for details."},{"oldText":"- `--images-from-transcript` extracts pasted base64 images from the session JSONL,\n  newest first, up to 10;","newText":"- `--images-from-transcript [path]` extracts pasted base64 images from the session\n  JSONL (default: this session's `transcript_path`, which SessionStart stores in\n  session state, so the agent never needs to know it), newest first, up to 10;"},{"oldText":"and the agent picks older\n  important ones with `--attach` from the transcript list the command prints.","newText":"and older important ones are saved with\n  `--images-from-transcript --pick 3,7` from the numbered list the command prints."},{"oldText":"a partial handoff is never reported\n  as complete.","newText":"a partial handoff is never reported\n  as complete. Re-running `pm pause` rewrites the handoff and copies only the\n  attachments not saved yet (files are named by content sha)."},{"oldText":"Attachments not present on this\nmachine are listed as `(on <machine>)`.","newText":"Attachments not present on this\nmachine are listed as `(on <machine>)`. Worktree ids are folder names and differ\nbetween machines, so where the paused task is not claimed by this worktree the summary\nprints `Paused elsewhere: T-041 (on <machine>, <date>) — pm claim T-041 to continue\nhere`, and `pm claim` then prints the handoff."},{"oldText":"`--images-from-transcript $transcript`).","newText":"`--images-from-transcript`)."},{"oldText":">5 MB and non-image files are refused;","newText":">5 MB (a named constant with a `ponytail:`\n  ceiling note) and non-image files are refused;"},{"oldText":"README (en + ru) section \"Ending a session\".","newText":"README (en + ru) section \"Ending a session\" with copy-paste examples: `/done` on a task\nwithout a PR, `/done` waiting for a PR, `/pause` with images, fixing a partial pause,\ncontinuing on another machine (`pm claim`), `pm reconcile --yes`. `pm help` and the\nREADME command and status tables list `done`, `pause`, `reconcile` and `review`, minimal\ncall first. Upgrade note: an older plugin reading a board with `review` tasks shows\n`bad status \"review\"` in its board-problems line and otherwise keeps working; update\nevery machine that shares the board; to roll back, first `pm set T-NNN\nstatus=in_progress` for each `review` task."},{"oldText":"- done: no git link → done; linked + merged → done; linked + open → review with\n  `review_at`.","newText":"- done: claimed task with a branch but no commits/PR → done (research case);\n  commits or pr + merged → done; + open → review with `review_at`; `--no-merge` and\n  `--pr` overrides; the printed outcome line; `pm.autoClose=false` turns an\n  auto-close into an ask.\n- reconcile: six forge-only candidates → background runs rotate by `checkedAt`,\n  foreground checks all six; failure lines carry problem, cause and fix."},{"oldText":"  `(on <machine>)` for missing attachments.","newText":"  `(on <machine>)` for missing attachments.\n- cross-machine: a paused task claimed under another worktree name prints the\n  `Paused elsewhere` line; `pm claim` there prints the handoff.\n- pause: `--pick` saves chosen older images; the default transcript path comes from\n  session state; a re-run copies only missing attachments."},{"oldText":"`pm done <id> [--pr url] [--did \"...\"]`:","newText":"`pm done <id> [--did \"...\"] [--pr url | --no-merge]`:"},{"oldText":"[--attach img1,img2] [--images-from-transcript <path>]`:","newText":"[--attach img1,img2] [--images-from-transcript [path] [--pick 3,7]]`:"}]} -->
<!-- autoplan-baseline-edits:eng {"sourceSha256":"2e31569d3e9429f340366d4b374541c7dbe7291031dc5fec501b135c5877d63d","replacements":[{"oldText":"- First session after installing PR 1: the summary lists every open task that is\n  already merged on the default branch (existing stale tasks included), and asks\n  whether to close them. Nothing closes silently that the user did not mark done.\n- A task marked done (`/done`) whose PR merges later is `done` at the latest in the\n  first session after the merge reaches the local remote refs (background fetch\n  below), with no question.","newText":"- First session after installing PR 1: the summary lists every open task already\n  merged per the local default-branch refs (commit subject), existing stale tasks\n  included, and asks whether to close them; matches only the forge can see follow\n  after the background refresh or at once with `pm reconcile`. Nothing closes\n  silently that the user did not mark done.\n- A task marked done (`/done`) whose PR merges later becomes `done` with no question:\n  at the latest at the second session start after the merge (the first start triggers\n  the background refresh, the next one applies it), or at once with `pm reconcile`."},{"oldText":"2. **Forge** (network): reuse `prInfo` from forge.mjs for tasks with `pr` or a\n   non-default `branch`; `state == merged` → hit with `mergeSha`, `mergedAt`.","newText":"2. **Forge** (network): a new `prLookup(data, cwd)` in forge.mjs returns\n   `{ status: 'ok' | 'none' | 'error', pr, cause }` (the existing `prInfo` becomes a\n   thin wrapper, so `pm show` keeps working); `normalizePr` also keeps the `base` and\n   `head` branch names. A hit is `state == merged` with `base` = the default branch.\n   When the task has both `pr` and `branch` and the PR's `head` differs from `branch`,\n   the result is a conflict: never auto-closed, listed with both values."},{"oldText":"(detached `pm _merge-check`, `windowsHide`, one run at a time via a `checkingSince`\ntimestamp in state, skipped if a run started < 10 minutes ago).","newText":"(detached `pm _merge-check`, `windowsHide`, one run at a time via an exclusive lock\nfile created with `fs.openSync(path, 'wx')` holding pid and start time; a lock older\nthan 10 minutes is stale and taken over; foreground `pm reconcile` takes the same\nlock)."},{"oldText":"(`{ checkedAt, state, url, mergeSha, mergedAt }`). SessionStart never touches the\nnetwork: it reads local refs + the cache and starts the refresh when the cache is\nolder than 30 minutes.","newText":"(`{ checkedAt, state, url, base, head, mergeSha, mergedAt, lastError }`, keyed by task\nid + PR url, so an entry for an older PR never counts for a new one). A permanent cause\n(no forge CLI, not logged in) stops background spawns until `pm reconcile` runs or 24\nhours pass. The merge detector adds no synchronous network call to SessionStart (the\nexisting board sync pull stays as it is): it reads local refs + the cache and starts\nthe refresh when the cache is older than 30 minutes."},{"oldText":"Constants (30 min, 5 calls, 10 min lock) are named","newText":"Constants (30 min, 5 calls, 10 min lock, 30 s git timeout, 24 h backoff) are named"},{"oldText":"`review` AND either the forge says the task's own PR (its `pr`, or the PR found by\n  its branch) is merged, or a subject hit is dated at or after `review_at` (the time\n  `pm done` ran).","newText":"`review` AND either the forge says the task's own PR (URL equal to the task's current\n  `pr`, or found by its branch when `pr` is empty; base = default branch; no head/branch\n  conflict) was merged at or after `review_at`, or a subject hit is dated at or after\n  `review_at` (the time `pm done` ran). The task file is re-read right before the\n  write, and nothing is written if its `status`, `pr` or `review_at` changed."},{"oldText":"- A forge hit found by branch replaces a wrong hand-typed `pr` (e.g. PM-054 `#8` vs\n  master `#7`).","newText":"- A branch lookup that finds a different PR than the hand-typed `pr` is reported as a\n  conflict with both URLs and the fix (`pm set T-NNN pr=<url>`); it is never replaced\n  silently (e.g. PM-054 `#8` vs master `#7`).\n- `git log` on a missing `<remote>/<default>` ref gives no hits plus a `Merge not\n  checked` reason, never an exception. The `origin/HEAD` hint is shown once per repo\n  (a state flag)."},{"oldText":"- requires a Log entry or `--did`;","newText":"- requires a Log entry or `--did`;\n- order: validate arguments → capture commits (`captureCommits`, as `pm set` already\n  does before a status change) → re-read the task → decide → write;"},{"oldText":"`commands/done.md` (`/done`,","newText":"`pm claim` on a `review` task only adds the worktree: status, `branch`, `pr` and\n`review_at` stay (continuing implementation is `pm set T-NNN status=in_progress`).\n\n`commands/done.md` (`/done`,"},{"oldText":"(default: this session's `transcript_path`, which SessionStart stores in\n  session state, so the agent never needs to know it)","newText":"(default: SessionStart stores `{ session_id, transcript_path }` as\n  `current-session-<worktree>`; the CLI reads that key, prints which transcript it\n  used, and with two live sessions in one worktree takes the latest and says so)"},{"oldText":"an unknown shape is skipped\n  and counted.","newText":"an unknown shape is skipped\n  and counted; more than half skipped prints a warning that the transcript format may\n  have changed."},{"oldText":"  open questions, key files, attachments, machine name);","newText":"  open questions, key files, attachments, machine name); a missing section is created\n  above `## Log`, a hand-moved one is found by its heading, and a file without `## Log`\n  gets both;"},{"oldText":"(`MAX_LINES`), then `full handoff: pm show T-NNN`.","newText":"(`MAX_LINES`), then `full handoff: pm show T-NNN` (`pm show` gains the `## Handoff`\nsection and attachment paths; today it prints no task body)."},{"oldText":"`pm done`/`pm pause` write `handoff-<worktree>` state `{ at }`. SessionEnd, when\n`at < firstStart` (no handoff in this session) and this worktree has an open task,\nappends `session ended without handoff; transcript: <transcript_path>` to it.","newText":"`firstStart` is written only when the key has none, so resume, clear and compact keep\nit. `pm done`/`pm pause` write `handoff-<task id>` state `{ at }` per task. SessionEnd\nappends `session ended without handoff; transcript: <transcript_path>` to every open\ntask of this worktree whose mark is missing (read as 0) or older than `firstStart`."},{"oldText":"Two sessions in one worktree at once share the `handoff-<worktree>` mark","newText":"Two sessions in one worktree at once share the per-task marks"},{"oldText":"`bad status \"review\"` in its board-problems line and otherwise keeps working;","newText":"`bad status \"review\"` in its board-problems line and drops `review` cards from\nBOARD.md and board.html (the task files stay);"},{"oldText":"  foreground checks all six; failure lines carry problem, cause and fix.","newText":"  foreground checks all six; failure lines carry problem, cause and fix.\n- own-PR contract: hand-typed `pr` pointing at another merged PR → conflict, no close;\n  the right PR merged into a non-default base → no close; forge hit merged before\n  `review_at` (two-PR case through forge and cache) → stays review; a cache entry for\n  an older PR url is ignored after `pm set pr=`; task changed between check and write\n  → no write.\n- `pm done` right after a commit with no Stop in between → commits captured → review.\n- `pm claim` on a review task keeps review, branch, pr and review_at.\n- lock: two concurrent `_merge-check` runs plus a foreground reconcile → one holder; a\n  lock older than 10 minutes is taken over; a permanent forge failure → no spawn for 24 h.\n- missing `<remote>/<default>` ref → not-checked reason, no exception; the origin/HEAD\n  hint is printed once per repo.\n- board: the 6-column CSS keeps the phone media query (render assertion), plus a\n  manual /browse check at 375 px width."},{"oldText":"- hooks: `firstStart` survives a safety note; SessionEnd writes the transcript\n  pointer only when `at < firstStart`, both sides of the boundary tested.","newText":"- hooks: `firstStart` survives a safety note, resume and compact; SessionEnd writes\n  the transcript pointer for each open task whose mark is missing or older than\n  `firstStart`; two open tasks, `pm done` on one → the pointer is still written for the\n  other.\n- transcript key: two sessions in different worktrees → each `pm pause` uses its own\n  transcript; more than half skipped shapes → warning.\n- handoff surgery: missing section, hand-moved section, file without `## Log`.\n- `pm show` prints the full handoff and attachment paths."},{"oldText":"`merged_sha` and corrected `pr` stored)","newText":"`merged_sha` stored)"},{"oldText":"wrong `pr`\n  corrected;","newText":"wrong `pr`\n  → conflict line;"}]} -->

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` via /autoplan | Scope & strategy | 1 | CLEAR | 7 proposals, 5 accepted, 1 deferred |
| Outside Review | codex exec (CEO, DX, Eng phases) | Independent 2nd opinion | 3 | completed | 24 findings; 23 resolved; 1 noted (competition) |
| Eng Review | `/plan-eng-review` via /autoplan | Architecture & tests (required) | 1 | ISSUES OPEN | 19 issues mapped into the plan, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | skipped | no UI scope |
| DX Review | `/plan-devex-review` via /autoplan | Developer experience gaps | 1 | CLEAR | score: 5.1/10 → 7.4/10, TTHW: 2-5 min → <1 min |

- **OUTSIDE COVERAGE:** codex · CEO completed (6 findings) · Design skipped (no UI scope) · DX completed (6 findings) · Eng completed (12 findings).
- **CROSS-MODEL:** Claude subagent and Codex agreed on 13 of 18 consensus rows; disagreements: competition (CEO), upgrade safety (DX), architecture and deployment risk (Eng), all resolved toward the stricter view except competition (noted only).
- **VERDICT:** CEO + DX CLEARED; Eng findings are all written into the plan with tests (status issues_open by rule because issues were found) — eng review required after implementation starts only if the plan changes.

NO UNRESOLVED DECISIONS
