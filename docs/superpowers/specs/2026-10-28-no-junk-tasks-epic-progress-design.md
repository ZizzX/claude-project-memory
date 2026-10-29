<!-- /autoplan restore point: "/Users/a.isapov/.gstack/projects/ZizzX-claude-project-memory/ZizzX-feat-epic-remaining-tasks-autoplan-restore-20261028-150839.md" -->
# Fewer junk tasks, epic progress, an honest Stop nudge — design

Date: 2026-10-28. Status: approved at the gate 2026-10-29; accepted bullets folded into §1–§7 (ENG-13). Target version: 0.13.0 (PR2).

## Intent

The user's words (2026-10-28): tasks "create themselves". Reminders ("wait for the release to merge this", "remove
the feature flag"), things that could be fixed here and now get their own task, and when someone finally reaches
one it is a one-line, one-file change. The result is a pile of tasks nobody reaches. What they want instead is how
developers work everywhere: found it and can fix it → fix it now, but **ask the user first and say what the answer
changes**. Not related to the current work → **offer a separate session and start it right away**, instead of
filing a task. And: when the current epic has no tasks left, say so; when it has some, say how many.

Evidence (read-only analysis of the user's two biggest boards, 2026-10-28):

- ATS board, 296 tasks, 65 open. 53 of 65 open (82%) are reminders/waits (26), small follow-ups found mid-work
  (20) or close-time leftovers (7). 48 of 65 open tasks have an empty Log; 51 an empty Goal — the title is the
  whole task. 27 open tasks are untouched for 14+ days.
- The user already purged by hand three times (23.09, 25.09, 23.10): 44 dropped, 40 of them never started. On
  23.10 they wrote the rule «задачи на включение/снятие флагов не заводим — пользователь сам скажет»; five flag
  tasks created before it are still open (T-127, T-166, T-187, T-189, T-251).
- Follow-ups that did get done were tiny: T-067 and T-177 "one line", T-139 one file, T-154 two files.
- No task records where it came from: no `created`, no parent. The parent shows up only in some other task's
  `next:` line.
- Wizzard board, 23 open: ~9 side findings, 22 of 23 untouched for 14+ days, 20 with no Log.

Where the plugin itself produces the pile (file:line in this repo):

- `scripts/lib/summary.mjs:12` — printed at every session start: `before calling a task done, ask "what's left?"
  and file leftovers as tasks`.
- `commands/done.md:17-20` — "what's left?" asked twice; "file every leftover as `pm task new … --deps`".
- `commands/close.md:13` (leftovers as tasks), `:17` (no task but code changed → offer `pm task new`).
- `skills/pm/SKILL.md:44` (done row: every leftover becomes a task), `:71` (Stop nudge → "create/claim one").
- `skills/retro/SKILL.md:28`, `:38` (a code defect → `pm task new`).
- `scripts/lib/hooks.mjs:133-153` — the Stop hook. It fired three times in the 2026-10-28 session with a clean
  tree and no commits. Cause: `codeChangedSince` (`:61-64`) is `headTime > updated`, where `updated` is the newest
  manual write of PLAN.md, decisions.md or *this worktree's* task files (`:52-59`). A worktree with no task of its
  own has `updated` = PLAN.md mtime or 0, so a four-day-old HEAD counts as "code changed". Every false nudge asks
  the agent to "create/claim a task" — another junk source.

The only brake today is `skills/pm/SKILL.md:42` ("Small work … leave the board alone"), outweighed by the five
places above.

Epic gap (`scripts/lib/summary.mjs:31-97`, `scripts/pm.mjs:117-160`, `:321-333`, `:446-454`): when the worktree's
epic has 0 open tasks the header still says `epic X`, the `Epics:` line silently drops X (`summary.mjs:34`),
`pm next` fails with `nothing ready in epic X` (`pm.mjs:131`), and `pm done` prints only `T-NNN → done`. Nothing
says "this epic is finished" or "3 left".

## Goals

1. An agent that finds something outside the task resolves it in the conversation: fix now (after asking), or a
   separate session started now, or — only when the user says so — a task. Default: no task.
2. Reminders tied to an event do not become standalone tasks.
3. The Stop hook nudges only when this session changed code, and never asks to create a task.
4. The session summary, `pm done` and `pm next` say how many tasks the current epic has left, and say plainly when
   it has none.
5. The existing pile can be cleared in one sitting: the audit lists empty, untouched tasks; one command drops a
   confirmed set with a reason.
6. New tasks record when and from what they were created.

## Non-goals

- No auto-dropping. Every drop of an existing task is the user's yes (same rule as D-011 for code).
- No new task types, priorities or labels. No reminder scheduler, no calendar, no notifications.
- No change to how epics are created, archived or ordered.
- Cleaning the ATS/Wizzard boards themselves is not part of this change; it is a rollout step the user runs with
  the new audit after updating.

## Anti-goals (would be a failure even if it "works")

- The agent stops filing tasks the user actually wants (real planned work, "break it down", multi-session work).
- The agent starts fixing unrelated things without asking — scope creep inside someone's PR.
- More questions than today: the triage question must be one line, asked once per finding, batched when several.
- A hard gate in `pm task new` that blocks the user's own request.

## Implementation plan

### 0. Context for reviewers (summary of the Intent above; no behavior of its own)

- Problem (user, 2026-10-28): agents file reminders, one-line fixes and leftovers as separate tasks; nobody
  reaches them. Wanted: found and fixable -> fix now after asking (say what the answer changes); unrelated ->
  offer a separate session started now; the current epic says "no tasks left" or "N left".
- Evidence: the user's ATS board has 296 tasks, 65 open; 53 of the 65 (82%) are reminders/waits (26),
  mid-work findings (20) or close-time leftovers (7). 48 of 65 have an empty Log, 27 are untouched 14+ days. The
  user purged by hand three times (44 dropped, 40 never started). A 23.10 user rule "no flag tasks" left five
  older flag tasks open. Follow-ups that got done were tiny (T-067, T-177: one line). Tasks have no
  created/parent field.
- Sources in this repo: summary.mjs:12 (RULES printed every session: "file leftovers as tasks"),
  commands/done.md:17-20 (asked twice, every leftover -> pm task new), commands/close.md:13,17,
  skills/pm/SKILL.md:44,71, skills/retro/SKILL.md:28,38. Stop hook hooks.mjs:61-64 compares the HEAD commit time
  with the newest manual board write of this worktree's tasks; a worktree with no tasks has updated=0, so any
  HEAD fires "create/claim a task" (three false nudges in one session with a clean tree).
- Epic gap: with 0 open tasks the header still says epic X, the Epics: line drops X, pm next fails with
  "nothing ready in epic X", pm done says nothing about the epic.
- Non-goals: no auto-drop (every drop is the user's yes), no new task types or priorities, no scheduler, no
  change to epic creation/archive; cleaning the user's boards is a rollout step, not code.
- Anti-goals: losing tasks the user wants; fixing unrelated things without asking; more questions than today;
  a hard gate on pm task new.

### Folded sections (ENG-13)

§1–§7 below are the accepted CEO/DX/Eng bullets folded into the original plan; where the original text and an
accepted bullet disagreed, the bullet won (DX-11). Each item is tagged **PR1** (core) or **PR2** (cleanup tools),
as the gate decided (uc1c). The accepted blocks and the review record further down are kept as history.

### 1. Finding triage replaces "file leftovers as tasks" (protocol text) — PR1

The canonical rule lives in one protocol row of `skills/pm/SKILL.md`; every other place uses a short form that
points to it (DX-8):

> **Found something outside the task** (a bug, a small fix, a follow-up, a "later"):
> 1. It belongs to this task's area and fits this session → ask in one line: "Fix now? <what it touches, how it
>    changes this diff/PR>". Yes → do it in this task and mention it in the task's Log. No → `pm later <id>
>    "<text>"` (a `later#n` line on the current task); no task.
> 2. It is unrelated to the current work → offer a separate session started now: a one-paragraph prompt the user
>    can paste into a new session/worktree. Declined → `pm later <id> "<text>"`. No board task unless the user
>    asks for one.
> 3. A wait or reminder tied to an event (release, merge, flag removal, someone's answer) → a wait inside this
>    task is its state (`waiting` with `waiting_on`, or `review` with a PR); a reminder that outlives the task →
>    `pm later` in PR1, `pm remind` from PR2 (§2). Never a new task.
> 4. A task only when the user says so, or when it is real planned work that will not fit this session ("break it
>    down"). Then `pm task new … --from <id>` (`--from` records origin, not a dependency — that is `--deps`).
> Several findings at once → one question listing all of them. No current task → name the finding in the final
> report only. A project rule of the user wins (e.g. "flag tasks are not tracked"): name it in the final report.

**`later#n` lines** (CEO-13, DX-6, ENG-12). A declined finding is one Log line on the current task:
`- <date> · <worktree> · later#<n>: <text>`, `n` counting that task's `later#` lines (1, 2, …; never reused).
A resolution is another Log line: `- <date> · <worktree> · later#<n> kept`, `later#<n> → T-NNN`, or
`later#<n> dismissed`. Unresolved = no resolution line yet. The CLI owns the syntax, so the agent never hand-edits
the Log (builder decision, recorded as a D-NNN):

- `pm later <id> "<text>"` — appends `later#n`, prints `<id>#later<n> recorded`.
- `pm later [<id>]` — lists unresolved lines, `<id> later#<n>: <text>`; no id → every task of this worktree.
- `pm later <id> --keep <n,…|all>` / `--dismiss <n,…|all>` — appends the resolution lines.
- `pm task new --title … --from <id> --later <n>` — the new task resolves `later#n` of `<id>` as `→ <new id>`.
- Text (ENG-12): newlines → spaces, a leading `- [ ]`, `- [x]`, `---` or `#` removed, cut to 200 characters;
  empty after cleanup → error. Errors follow DX-7.

**`/close` step 1** asks one batched question over the unresolved `later#n` lines of this worktree's tasks
(`pm later`): keep all (default) / pick numbers to turn into tasks / dismiss all — then the matching `pm later …
--keep|--dismiss` or `pm task new --from <id> --later <n>`. No unresolved lines → the step says nothing.

Edits:

- `scripts/lib/summary.mjs` RULES: `before calling a task done, ask "what's left?" and file leftovers as tasks` →
  `found something outside the task: fix it now (ask first) or offer a new session — a task only when the user
  says so`. `test/summary.test.mjs` asserts RULES.
- `skills/pm/SKILL.md`: the canonical "Found something outside the task" row; the done row drops "every leftover
  becomes `pm task new`" and points at the triage; the "Small work" row stays; the Stop row becomes "log progress
  on the active task, or reply that there is nothing to track"; a row for `Epic X: no open tracked tasks` (§4);
  one decision table (DX-9): wait inside this task → `waiting`/`review`; declined finding → `later#n`
  (PR2 adds: reminder that outlives the task → `pm remind`).
- `commands/done.md` steps 3–4: "what's left?" asked once. Unfinished parts of *this* task keep it open
  (`pm log … --next`). Findings outside the task go through the triage (short form).
- `commands/close.md` step 1: the `later#n` batch question; "No task here but code changed → 'nothing to track' is
  the default; offer `pm task new` only when the work continues in another session". Step 3: epic with no open
  tracked tasks → ask the user which direction is next, then update or remove its focus line (CEO E6).
- `skills/retro/SKILL.md` route 1 and route 6: "a code defect across the repo → fix now (ask) or offer a separate
  session; `pm task new` only with the user's yes".
- README.md / README.ru.md: the triage and the decision table once; `pm later` and `pm task new --from` lines;
  README:71 corrected: "what's next?" offers the options (`pm next --options`), "take the next one" claims (DX-10).
- `pm help`: usage lines with one example each for `pm later` and `pm task new --from` (DX-9).
- Test: no shipped file (`README*`, `commands/`, `skills/`, `scripts/`) contains "file leftovers" or "every
  leftover becomes".

### 2. Reminders live on the task they belong to — PR2

- A reminder about the current task itself ("merge after the release", "wait for the backend") is that task's
  state: `pm set T-NNN status=waiting waiting_on="…"` or `review` with a PR — never a second task (PR1 protocol).
- A reminder that outlives the task ("remove flag X after the prod tag"): `pm remind T-NNN "<text>"` appends
  `- [ ] remind: <text>` at the end of that task's `## Checklist` (the section is created before `## Log` when
  missing). Reminders never hold a task open (CEO-9): `pm done`, merge auto-close and `pm reconcile` ignore them;
  the definition of done says "checklist closed — open `remind:` lines do not count" (`commands/done.md` step 2,
  SKILL.md done row; wording test).
- `pm remind T-NNN` lists the task's reminders numbered by position among its `remind:` lines (a ticked line keeps
  its number; a hand-deleted line shifts later ones — help and README say so, ENG-10). `pm remind T-NNN --clear
  <n|all>` and `pm remind --clear T-123#2` (DX-5) tick lines (`- [x] remind: …`) and print the text of each line
  ticked. `pm remind` with no id lists every open reminder on the board, `T-123#2 <text>`. `pm show` prints the
  numbered list.
- Errors (DX-7, CEO-12): empty text, unknown id or a dropped task → error, nothing written; `--clear` out of range
  → error naming the valid numbers; `--clear` on a ticked line → no-op with a note. Text sanitized as in §1.
- `pm remind` add and clear are manual board writes (`updated` = today, counted by `manualMtime`); Stop counts them
  only for a task of this worktree.
- Summary `Reminders:` line, right after `Waiting:`: one entry per open reminder, `T-123#1 <text>` (text cut to 60
  characters with `…`, ENG-7), this worktree's epic first, any status except dropped, at most 3, then `+N more
  (pm remind)`, ending with `clear: pm remind --clear <id#n>`. Never cut by the 40-line cap (ENG-7).
- The epic line (§4) adds `· N open reminders` when that epic has any (CEO-15).
- `scripts/lib/reminders.mjs` owns the line syntax (`isReminderLine`, `parseReminders`) next to the PR1 title word
  list (ENG-9). board.html shows reminder lines as Checklist text (no board code change).
- Upgrade note (DX-4): README changelog and Install/Update say to update and restart every session using the board
  before `pm remind` (a 0.12.0 session reads an open `remind:` line as an unfinished checklist item); after a
  downgrade `remind:` lines stay as plain checklist text and `created`/`from` are ignored.

### 3. Stop hook: this session's changes only, no "create a task" — PR1

- SessionStart writes `session-<id>` = `{ start, head, reflogOffset, deleted }`; `reflogOffset` is the current size
  of this worktree's `logs/HEAD` (ENG-1); `deleted` lists the dirty paths (and rename sources) already gone at that
  moment (review of #4, amends ENG-2). `onSafetyNote` refreshes all three after each note, so the Stop window then
  starts at that note — intended, the note already logged those files.
- `onSafetyNote` writes its `auto:` line through `autoWrite`, so it never counts as a manual board update (ENG-3).
- `updated` = the newest manual write of PLAN.md, decisions.md or this worktree's task files (as today).
- Changed in this session, with `since = max(start, updated)`:
  - **commits** (DX-1, ENG-1): reflog entries read from `reflogOffset` on Stop's own (the capture cursor is never
    used) whose subject matches `TAKEN` (`gitlink.mjs`: commit, amend, cherry-pick, revert; pulls, merges,
    rebases, resets skipped) and whose entry time satisfies `time * 1000 > since` (same second as the board update
    → not counted). A reflog shorter than the offset (gc, recreated worktree), no `reflogOffset`, or no reflog file
    (reftable) → commits count as none;
  - **dirty files**: a dirty path whose mtime is newer than `since`; a deleted path — or the old side of a rename,
    since `git mv` keeps the file mtime — counts when it is not in `deleted` and the mtime of its nearest existing
    ancestor directory is newer than `since` (ENG-2 plus the review of #4: a directory touched later by an ignored
    tool file no longer revives an old deletion).
- No `session_id` or no git repository → no block. A `session_id` with no state file (an existence check, not
  `readState`'s `{}`: SessionStart timed out, the board was created mid-session) → Stop writes the state now and does
  not block this time; the window starts there (review of #4).
- The 20-minute window and the per-worktree `lastBlock` stay. `codeChangedSince` is removed.
- Message (DX-1): `[pm] This session made 2 commits and changed 3 files; the board was not updated for 20+
  minutes. Log progress on this worktree's task (pm log), or reply that there is nothing to track.` — the counts
  are what it saw (a zero part is omitted); never "create/claim a task".
- `PM_DEBUG` set → Stop prints its inputs and decision to stderr: times, counts and paths only (ENG-12).
- Tests (`test/hooks.test.mjs`; dates from `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and `fs.utimesSync`, never
  sleeps, ENG-14): old HEAD + clean tree + no own tasks → no block (the regression); a commit after session start →
  block; a fast-forward pull of a fresh commit → no block; a merge commit → no block; an own commit after the board
  update → block; a commit followed by a board update, 20+ minutes later → no block; same-second boundary → no
  block; truncated reflog → dirty files only; `captureCommits` advancing its cursor first does not hide a session
  commit; dirty file newer than start → block; older → no block; deleted before the session → no block; deleted
  after the board update → block; deleted, then a board update → no block; modified before and deleted during the
  session → block; no session_id → no block; session_id without a state file → no block; a safety note then 20+
  minutes idle → no block, with a new own commit → block; `stop_hook_active` → no block; the message asserts the
  new text. Manual: `time node scripts/pm.mjs hook stop` on a large repo stays within +20 ms.

### 4. Epic progress everywhere the epic is mentioned — PR1

`epicProgress(tasks, epic)` in `scripts/lib/tasks.mjs` → `{ open, ready, blocked, inProgress, waiting, review,
done, dropped, total }` over the tasks whose `epic` is exactly that key: `total` excludes dropped; `open` = `isOpen`;
`ready` = todo with every dependency done/dropped; `blocked` = todo with an unmet dependency. Printed parts, in this
order, zero parts omitted: ready, blocked, in progress, waiting, in review — they sum to `open` (CEO-11).
`epicCounts(p)` renders `2 ready, 1 waiting`; `epicDone(p)` renders `(9 done)`, or `(N dropped)` when every task
is dropped (CEO-12).

- Summary (`buildSummary`), when this worktree has an epic: one line after this worktree's task lines, before
  `Elsewhere:` (CEO-11), never cut by the 40-line cap (ENG-7; the header is never cut either):
  - open > 0: `Epic X: 3 left of 9 (2 ready, 1 waiting)`;
  - open = 0: `Epic X: no open tracked tasks (9 done) — ask the user which direction is next: pm next --options`
    (CEO-15: never "the direction is finished"). The header keeps `epic X`.
  - The `Epics:` line is unchanged.
- `pm done`: after the outcome line, one line for the epic of the task it closed (not the worktree's), computed
  after the change: open > 0 → `epic X: 2 left (1 ready, 1 in review)`; open = 0 → `epic X: that was the last open
  task — no open tracked tasks. Update or remove its focus line in PLAN.md; /close asks which direction is next.`
  A task that went to `review` is still open. No epic → nothing extra.
- `pm reconcile`: epic lines computed once after the whole batch, one per epic of the closed tasks, same format
  (ENG-8). A session-start auto-close is reported by the summary's epic line.
- `pm next` when nothing is ready in epic X (exit code unchanged): `nothing ready in epic X — no open tracked tasks
  (9 done) — pm next --options shows other epics, or pm task new --epic X` or `nothing ready in epic X — 2 open,
  none ready (1 waiting, 1 in progress) — pm next --options shows other epics`.
- `pm next --options`: `(nothing ready)` gets the same reason: `(nothing ready) — epic X: 2 open, none ready (…)`.
- `pm epics`: format unchanged, plus ` · N ready` on an epic with open tasks: `X · 3/9 open · 2 ready`.
- `skills/pm/SKILL.md`: summary line `Epic X: no open tracked tasks` → ask the user which direction is next
  (`pm next --options`); never invent tasks to fill the epic.
- PR2 adds `· N open reminders` to the epic lines (§2).

### 5. Clearing the existing pile — PR2

- `pm audit` finding `empty` (DX-2): open `todo` whose Goal, Understanding, Checklist and Log are all empty (so no
  open reminder), `updated` 14+ days old and, when present, `created` 14+ days old. One line per task in the
  existing finding format (id, title, `created`/`updated` dates, `ask the user; pm drop`), then one line
  `empty ids: T-114,T-115,…` that pastes into `pm drop`. `DAYS.empty = 14` (added in PR1 for the stats line).
  Not touched by `--fix`.
- `pm audit` finding `reminder-task`: open tasks whose title matches `isReminderTitle` (`reminders.mjs`, PR1) —
  candidates to fold into the task they came from (`pm remind` on it) or drop. Listed only; the SessionStart
  `auditLine` count excludes it (ENG-11).
- `pm drop <ids> --why "<reason>" [--dry-run]` (CEO-11, CEO-19, DX-3, ENG-4): ids comma- or space-separated,
  deduped; `--why` required and sanitized (ENG-12); all-or-nothing — any refusal drops nothing and lists every
  reason. Droppable: todo, waiting, review, and this worktree's own in_progress. Refused (DX-7 texts): unknown id
  (`T-999 not found — pm ready --all lists tasks`), done, already dropped, another worktree's in_progress (`T-77 is
  in progress in worktree X (last log <date>) — finish it there, or pm set T-77 status=todo, then drop`), an open
  dependent outside the set (`T-200 depends on T-114 — drop it too, or pm set T-200 depends_on=…`).
  Transaction, under `withLock(pm, 'claim')` then `withLock(pm, 'commit')` (lock order claim → commit; `commitPm`
  takes `commit` too, drop calls an inner commit that does not re-lock): refusal checks → commit pending edits of
  the target files as `pm: sync before drop` (failure → stop, nothing written) → `captureCommits` for this
  worktree's in_progress targets → write the files (`status=dropped`, Log `- <date> · <worktree> · dropped:
  <reason>`, a `next` mark cleared) → `git commit -m "pm: drop T-1, T-2" -- <paths>` → on failure restore every
  target file to its pre-drop bytes and print the git error's first line and "nothing was dropped" → `startCapture`
  → print the sha and `undo: git -C "<board dir>" revert --no-edit <sha>` and the open reminders it discarded.
  `--dry-run` stops after the refusal checks and prints what would drop, every refusal and the reminders it would
  discard. `show.mjs` reads the `pm: drop` subject like `pm: reconcile closed`.
- `pm set <id> status=dropped` keeps working and prints a one-line hint to use `pm drop <id> --why` (ENG-15).
- Unexpected failures (DX-16): `main().catch` prints `e.stack` when `PM_DEBUG` is set.
- Rollout (CEO-18): the user cleans the ATS/Wizzard boards only after 0.13.0 is installed there: `pm audit` →
  confirmed ids → `pm drop --dry-run` → `pm drop`. README gets the worked example (audit → dry run → drop → undo).

### 6. Provenance on new tasks, the `pm task new` hint, validate, the metric — PR1

- `pm task new` writes `created: <date>` and, with `--from <id>`, `from: <id>`; `--from` is a string option; the id
  is validated before `newTask` reserves a file (`--from T-999: no such task — nothing created — pm ready --all
  lists tasks`). `--later <n>` needs `--from` (§1). Existing tasks without `created` stay valid; `validate` keeps
  accepting unknown optional fields, so 0.12.0 and 0.13.0 share a synced board (CEO-19).
- `pm show` prints `created` and `from`; the parent's `pm show` lists its children under `spawned:`.
- Hint (CEO-16, DX-12, E1): after the created line, one `hint:` line, never blocking, exit code 0:
  - without `--from` and `--deps`, while this worktree has a task in progress (the lowest id if several):
    `hint: PM-068 is in progress here — a finding of that work: fix it now (ask first) or offer a separate
    session; --from PM-068 records the origin. Skip this if the user asked for the task.`;
  - a title matching `isReminderTitle` — always, with any flags: `hint: "<title>" reads like a reminder — a wait
    inside a task is its status (waiting / review), not a new task. Skip this if the user asked for the task.`
  `--epic` alone does not quiet it (CEO-16). One hint at most: the reminder one wins.
- `scripts/lib/reminders.mjs` (ENG-9): `isReminderTitle` with the Russian + English word list (flag removal or
  enabling, "after release/prod tag/rollout/merge/deploy/the answer", "when … in release notes", "wait for",
  "remind", "ask/tell <team>"). Tests: real ATS titles as positives, ordinary titles ("ask for confirmation", "под
  флагом", "падает после !544") as negatives, both languages.
- `validate` (ENG-5): `depends on dropped` only when the dependent itself is open (`isOpen`).
- `pm audit` `stats` line (CEO-14, ENG-6), printed after the findings, not a finding, not counted by `auditLine`:
  `stats (30 days): 12 tasks created · 3 dropped without a did: line · 2 empty 14+ days` over the tasks whose
  `created` is within 30 days; "dropped without a did: line" = dropped with no ` · did: ` Log line (`later#`,
  `remind`, `auto:`, `retro:`, `dropped:` lines do not count); "empty" per the §5 rule. No task with `created` →
  no stats line.

### 7. Release — PR2

- PR1 ships no version bump. PR2: version 0.13.0 in `.claude-plugin/plugin.json` and `marketplace.json`;
  README/README.ru changelog lines, upgrade/downgrade notes (DX-4), rollout order (CEO-18).
- `node --test` green on the CI matrix (ubuntu/macos/windows × node 20/22); lock-failure tests use a pre-created
  `index.lock` (ENG-14).

## Tests

PR1:
- `test/summary.test.mjs`: RULES text; epic line for open>0, open=0 (done / all dropped), no epic, board without
  epics (unchanged output); a summary over the cap keeps the header and the epic line.
- `test/epics.test.mjs`: `pm epics` ready count; Archive unchanged.
- `test/next.test.mjs`: empty-epic and none-ready messages; `--options` reason; exit code unchanged.
- `test/merged.test.mjs`: `pm done` epic line (not last, last → done with the focus hint, last → review counted
  open, the task's epic not the worktree's); `pm reconcile` one line per epic after the batch.
- `test/hooks.test.mjs`: the Stop cases of §3.
- `test/tasks.test.mjs`: `created`/`from`, `--from` unknown leaves no file, `epicProgress` incl. `blocked`,
  validate open-only rule, a 0.12.0-shaped board validates, text sanitizing.
- `test/later.test.mjs`: `pm later` add / list / keep / dismiss / `--from --later`, numbering, errors.
- `test/reminders.test.mjs`: `isReminderTitle` positives and negatives, both languages.
- `test/cli.test.mjs`: the `pm task new` hint cases (in progress, none, `--from`, `--deps`, `--epic` alone,
  reminder title); `pm help` lines.
- `test/audit.test.mjs`: the `stats` line counts; absent without `created`; not in `auditLine`.
- `test/protocol.test.mjs`: no shipped file contains "file leftovers" or "every leftover becomes"; the triage row
  in SKILL.md; `/close` batch question wording.

PR2: `pm remind` (add, section created, append at the end, stable numbers, clear one/all, `T-123#n`, echo, errors,
ticked no-op, sanitizing, done/merge/reconcile unaffected, `Reminders:` line format, cap, dropped excluded);
`empty` and `reminder-task` findings; `pm drop` (every refusal, all-or-nothing, dry run, lock vs claim, repeated id,
next mark, sync-before-drop, isolated commit, revert restores bytes, held `index.lock`, linked commit, concurrent
`pm log` waits, `pm show` reads the subject); DoD wording.

## What is left to the builder

- Exact wording of every new line (keep them short; summary is capped at 40 lines, `MAX_LINES`).
- The reminder-title heuristic's word list (Russian and English).

<!-- autoplan-accepted:ceo -->
- §0 "Context for reviewers" is added at the top of the Implementation plan: a summary of the Intent, evidence,
  non-goals and anti-goals; it adds no behavior.
- Reminders are `- [ ] remind: <text>` lines under the task's `## Checklist` and never hold a task open (§2 as
  amended: `pm remind` add/list/clear with stable numbers, `pm remind` without id lists the board, summary
  `Reminders:` line). Tests: add; a task without `## Checklist` gets the section before `## Log`; list numbers stay
  the same after a clear; clear one; clear all; a done task with an open reminder appears in `Reminders:` and
  disappears after clear; merge auto-close and `pm reconcile` are unaffected by open reminders.
- `pm task new` without `--from`, `--epic` or `--deps`, while this worktree has a task in progress: after the
  created id it prints one hint line naming that task (the lowest id if several): fix it now or offer a separate
  session; `--from <id>` records the origin. Never blocks; exit code 0. Tests: hint with a task in progress; none
  without one; none with `--from`; none with `--epic` or `--deps` (a "break it down" run stays quiet).
- The epic-finished prompt is part of §4's single `pm done` epic line (one line, not two); `commands/close.md`
  step 3 adds: epic finished → ask the user which direction is next, then update or remove its focus line.
  Tests: last task → done prints the focus-line hint; last task → review prints `1 left (1 in review)`; not last →
  the count line; `pm reconcile` closing an epic's last task prints the line.
- Stop hook tests, in addition to §3: a commit in the session followed by a board update after it, 20+ minutes
  later → no block; `session_id` present but no state file → no block; the existing test asserting the old
  message is updated to the new one.
- `pm drop` tests: refuses another worktree's in_progress task; drops this worktree's own; refuses when an open
  task outside the set depends on an id and names it; succeeds when the dependent is in the set; clears a `next`
  mark; one board commit with the `pm: drop` prefix that `pm show` reads.
- `pm remind` and `pm drop` get usage lines in `pm help` (`pm.mjs` usage block), rows in `skills/pm/SKILL.md`
  ("remind … after …" → `pm remind` on the task it belongs to; "drop these" → `pm drop` only with the ids the user
  confirmed) and lines in README.md / README.ru.md.
- Deferred items (E4 board.html epic progress bar, E5 `pm handoff`) are listed under "NOT in scope"; E7 (the
  drop-never-started stat) is no longer deferred — CEO-14 makes it the `pm audit` stats line. No TODOS.md is created.
- Spec review 2 fixes (all CEO-11):
  - Reminders: a dropped task is excluded from `Reminders:`; `pm drop` prints the open reminders it discards. A
    task with an open reminder is never `empty` in the audit. `pm remind` add and clear count as a manual board
    write (they bump `updated`).
  - `pm drop`: ids comma- or space-separated; `--why` required; all-or-nothing — any refusal drops nothing and
    lists every reason. Droppable: todo, waiting, review, and this worktree's own in_progress. Refused: unknown id,
    done, already dropped, another worktree's in_progress, an open dependent outside the set.
  - Stop: a null `head` in the state file → commits count as none (dirty files only); no git repository → no
    block.
  - `pm done` reports the epic of the task it closed, not the worktree's.
  - `epicProgress` adds `blocked` = todo with an unmet dependency; printed parts are ready, blocked, in
    progress, waiting, in review, and they sum to `open`.
  - Summary placement: the epic line goes after this worktree's task lines, before `Elsewhere:`; `Reminders:`
    goes right after `Waiting:`. Test: a summary over the 40-line cap still shows the epic line.
  Tests: each refusal reason of `pm drop` and all-or-nothing; dropped task gone from `Reminders:`; `empty`
  skips a task with an open reminder; null head; done reports the task's epic; blocked part; cap test.
- Spec review 3 fixes (CEO-12, author-applied after the loop's last review; not re-reviewed):
  - Definition of done: `commands/done.md` step 2 and the `skills/pm/SKILL.md` done row say "checklist closed —
    open `remind:` lines do not count". Test: a wording assertion on both files.
  - `pm remind` edge cases: the new line is appended at the end of the `## Checklist` section; empty text,
    an unknown id or a dropped task → error, nothing written; `--clear` with a number out of range → error
    listing the valid numbers; `--clear` on an already ticked line → no-op with a note. The board-wide list prints
    one line per open reminder: `T-123#2 <text>`.
  - `Reminders:` summary line: one entry per open reminder, `T-123#1 <text>`, at most 3 entries, then
    `+N more (pm remind)`.
  - Stop commits: only non-merge commits in `<head>..HEAD` whose author email is the local `git config
    user.email` (all non-merge commits when it is unset), compared by author time (`%at`), so a pull, merge or
    rebase inside the session does not count. "No state file" is an existence check, not `readState`'s default.
  - `pm remind` writes the task file like any other manual CLI write (it counts in `manualMtime` and sets
    `updated` to today); Stop counts it only for a task of this worktree, as today.
  - `empty` audit, one rule for §5 and §6: open `todo`, empty Goal, empty Log, no open reminder, and its age —
    `created` when present, else `updated` — is 14+ days.
  - An epic whose tasks are all dropped: `Epic X: no tasks left (N dropped)`; with some done: `(N done)`.
  - `pm task new --from` is added to the CLI's string options (`pm.mjs:174`).
  Tests: each `pm remind` error case and the ticked no-op; `T-123#n` format and the 3-entry cap; a commit by
  another author and a merge commit inside the session do not block; a rebased own commit (old author time) does
  not block; `empty` skips a task whose `created` is recent even if `updated` is old.
- Dual-voice decisions (CEO-13..18; native CEO subagent + Codex both reviewed the plan):
  - Declined findings are retained, not forgotten (CEO-13): triage branch 1 "No" and branch 2 declined → one Log
    line on the current task, `- <date> · <worktree> · later: <text>` (existing `appendLogLine`, no new
    command). `/close` step 1 lists this session's `later:` lines once and asks per line: keep (stays in the
    Log), make it a task (`pm task new --from <id>`), or dismiss (`later dismissed` line). Tests: wording of the
    triage branches and of `/close` step 1.
  - Success metric (CEO-14, promotes E7): `pm audit` prints one `stats` line, not a finding: tasks created in the
    last 30 days (by `created`), how many were dropped without a manual Log line, how many are `empty` at 14+
    days. Boards without `created` print nothing. Test: counts on a fixture board; absent without `created`.
  - Epic wording (CEO-15): "no open tracked tasks", never "the direction is finished"; the epic line adds
    `· N open reminders` when that epic has any. Applies to the summary, `pm done`, `pm next`.
  - `pm task new` hint (CEO-16): quiet only with `--from` or `--deps` (not `--epic`); a title matching the
    reminder word list always gets the hint, even with an epic. Tests updated accordingly.
  - Stop commits (CEO-17, supersedes the author-email rule of CEO-12): non-merge commits in `<head>..HEAD` whose
    author time (`%at`) is newer than `updated`; no author filter. Test: a merge commit does not block; an own
    commit after the board update blocks.
  - Rollout order (CEO-18): the user cleans the ATS/Wizzard boards only after 0.13.0 is installed there, with
    `pm audit` → confirmed ids → `pm drop`; the plan's Release section says so.
- CEO review-section requirements (CEO-19): `pm drop` runs under `withLock(pm, 'claim')` like `takeNext`;
  repeated ids are deduped; `pm task new --from` validates the id before `newTask` reserves a file; Stop tests set
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and `fs.utimesSync` explicitly (no sleeps); `validate` keeps
  accepting unknown optional fields so 0.12.0 and 0.13.0 can share a synced board. Tests: drop vs claim under the
  lock; repeated id; `--from` unknown id leaves no new file; a 0.12.0-shaped board validates.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-accepted:dx -->
- Precedence (DX-11): where an accepted bullet (CEO or DX) contradicts §1–§7, the accepted bullet wins; the builder
  folds them into §1–§7 before coding, and wording tests use the accepted text.
- Stop (DX-1, supersedes the commit rule of CEO-17): a session commit is a reflog entry of this worktree whose
  subject matches `TAKEN` (`gitlink.mjs:8`: commit, amend, cherry-pick, revert; pulls, merges, rebases, resets
  skipped), read with `reflogSince`, whose time is newer than `max(start, updated)`. SessionStart also stores the
  set of dirty paths in `session-<id>` (`onSafetyNote` refreshes it with `start`/`head`); a deleted path counts only
  when it was not dirty at that point. No reflog file (reftable) → commits count as none, dirty files only. The
  block message states what it saw, e.g. `[pm] This session made 2 commits and changed 3 files; the board was not
  updated for 20+ minutes. Log progress on this worktree's task (pm log), or reply that there is nothing to
  track.` With `PM_DEBUG` set, Stop prints its inputs and decision to stderr. Tests: a fast-forward pull of a fresh
  commit → no block; a file deleted before the session → no block; a file deleted during the session → block; an
  own commit after the board update → block; no reflog → dirty files only.
- `empty` audit (DX-2, supersedes §5's one-line format and the age rule of CEO-12): candidate = open `todo` whose
  Goal, Understanding, Checklist and Log are all empty, no open reminder, `updated` 14+ days old and, when present,
  `created` 14+ days old. Output follows the existing per-task finding format: one line per task with id, title,
  `created`/`updated` dates and `ask the user; pm drop`, then one line `empty ids: T-114,T-115,…` that pastes into
  `pm drop`. `DAYS.empty = 14` joins `DAYS` (`audit.mjs:11`). Tests: per-task lines; id line; a task with a
  non-empty Understanding or Checklist is not `empty`; recent `updated` with old `created` is not `empty`.
- `pm drop` (DX-3): `--dry-run` prints what would drop, every refusal and the reminders it would discard, and writes
  nothing. The commit stages only the dropped task files (`commitPm` takes an optional path list). On success it
  prints the commit sha and `undo: git -C "<board dir>" revert --no-edit <sha>`; if the commit fails it says so and
  prints `pm set <id> status=<previous>` per id. Tests: dry run writes nothing; an unrelated dirty board file is
  not in the drop commit; the undo line; a failed commit (held `index.lock`) prints the manual restore.
- Unexpected failures (DX-16): the drop commit failure line also carries the first line of the git error and says
  the side effect (task files written, not committed); `main().catch` (`pm.mjs:533`) prints `e.stack` when
  `PM_DEBUG` is set. Test: the failure line contains the git error text.
- Upgrade (DX-4): the README changelog and the Install/Update section say: update and restart every session that
  uses the board before using `pm remind` (a 0.12.0 session reads an open `remind:` line as an unfinished checklist
  item); after a downgrade `remind:` lines stay as plain checklist text and `created`/`from` are ignored.
- Reminder ids (DX-5): `pm remind --clear T-123#2` is accepted alongside `pm remind T-123 --clear 2`; the summary's
  `Reminders:` line ends with `clear: pm remind --clear <id#n>`. Test: clearing by the printed id.
- Declined findings (DX-6, amends CEO-13): each declined finding is one Log line `- <date> · <worktree> ·
  later#<n>: <text>` on the current task, `n` counting that task's `later#` lines. A resolution appends
  `later#<n> kept`, `later#<n> → T-NNN` or `later#<n> dismissed`. `/close` step 1 asks one batched question over the
  unresolved `later#n` lines of the tasks this session touched: keep all (default) / pick numbers to turn into tasks
  / dismiss all. With no current task the finding is only named in the final report. Tests: wording of the triage
  branches and of `/close` step 1.
- Errors (DX-7): every new refusal or error is one line `what — why — next command`, exit 1 through `fail`
  (`pm.mjs:80`). Required texts: unknown id → `T-999 not found — pm ready --all lists tasks`; another worktree's
  in_progress → `T-77 is in progress in worktree X (last log <date>) — finish it there, or pm set T-77 status=todo,
  then drop` (no `--force`); `--from T-999` → `--from T-999: no such task — nothing created`; `pm remind` errors name
  the valid numbers or the reason. Tests assert the next-command part of each.
- Docs (DX-8, DX-9, DX-10): SKILL.md holds the canonical triage row; summary RULES, done.md, close.md and retro use a
  short form that points to it. One decision table in SKILL.md and both READMEs: wait inside this task → `waiting`/
  `review`; reminder that outlives the task → `pm remind`; declined finding → `later#n`. `pm help` gets usage lines
  with one example each for `pm remind`, `pm drop`, `pm task new --from`, and says `--from` records origin, not a
  dependency (`--deps`). README gets a worked cleanup example (audit → dry run → drop → undo) and a reminder example
  (add → summary line → clear), the rollout order (CEO-18), and README:71 is corrected: "what's next?" offers the
  options (`pm next --options`), "take the next one" claims. Test: no shipped file contains "file leftovers" or
  "every leftover becomes".
- `pm task new` hint (DX-12, TASTE T8, provisional): no new flag; the hint line ends with "skip this if the user asked
  for the task". CEO-16 otherwise unchanged.
- Deferred, NOT in scope (DX-13, DX-14, DX-15): per-command `--help`, configurable audit thresholds, a Stop off
  switch, a one-time upgrade line in the summary, a product-wide timed onboarding walkthrough, stable error codes,
  `pm drop --force`.
<!-- /autoplan-accepted:dx -->

<!-- autoplan-accepted:eng -->
- Stop internals (ENG-1, refines DX-1): the reflog entry parser also returns the entry time (seconds, from the
  `<name> <email> <time> <tz>` part). SessionStart stores `reflogOffset` (current size of `logs/HEAD`) in
  `session-<id>`; `onSafetyNote` refreshes it with `start`/`head`. Stop reads from that offset on its own (the
  capture cursor is never used) and counts `TAKEN` entries with `time*1000 > max(start, updated)`; an entry in the
  same second as the board update does not count. A reflog shorter than the offset (gc, recreated worktree) →
  commits count as none. Tests: same-second boundary; truncated reflog; `captureCommits` advancing its cursor
  before the decision does not hide a session commit.
- Stop deletions (ENG-2, supersedes DX-1's dirty-path snapshot): no path set is stored. A deleted path counts when
  the mtime of its nearest existing ancestor directory is newer than `max(start, updated)`. Tests: deleted before
  the session → no block; deleted after the board update → block; deleted, then a board update, then Stop → no
  block; modified before the session and deleted during it → block.
- Safety note (ENG-3, bug fix): `onSafetyNote` appends its `auto:` line through `autoWrite`, so it never counts as a
  manual board update. Test: a safety note, then 20+ minutes with no new work → no block; with a new own commit →
  block.
- `pm drop` transaction (ENG-4, supersedes DX-3's staging and recovery and DX-16's "written, not committed" side
  effect): inside `withLock(pm, 'claim')` (CEO-19) it takes `withLock(pm, 'commit')`, which `commitPm` also takes
  (lock order is always claim → commit, as `takeNext` → `persist`; drop calls an inner commit that does not
  re-lock), in order: refusal checks (CEO-11) →
  commit pending edits of the target files as `pm: sync before drop` (failure → stop, nothing written) →
  `captureCommits` for this worktree's in_progress targets → write the files → `git commit -m "pm: drop …" --
  <paths>` → on failure restore every target file to its pre-drop bytes from memory and print the git error's
  first line and "nothing was dropped" (DX-16's failure line, corrected) → `startCapture` → print the sha and the
  undo line. `--dry-run` stops after the
  refusal checks. Tests: a pre-staged unrelated file is not in the drop commit; a pending target edit lands in the
  sync commit; reverting the drop commit restores the exact pre-drop files; a held `index.lock` leaves the files
  byte-identical; a commit made just before dropping this worktree's in_progress task is linked to it; a
  concurrent `pm log` waits for the lock.
- Validate (ENG-5): `depends on dropped` is reported only when the dependent itself is open (`isOpen`). Tests: drop
  a dependency together with its dependent → validate clean; a done task whose dependency is dropped later → no
  problem; an open dependent → still reported.
- Metric (ENG-6, defines CEO-14): "dropped without a manual Log line" = a dropped task whose Log has no ` · did: `
  line; `later#`, `remind`, `auto:`, `retro:` and `dropped:` lines do not count. Test on a fixture board.
- Summary cap (ENG-7): the header, the `Epic X:` line and the `Reminders:` line are never cut; the cut removes other
  lines from the end as today; each `Reminders:` entry text is cut to 60 characters with `…`. Test: a 50-line
  summary keeps both lines.
- Reconcile (ENG-8): epic lines are computed once after the whole batch, one per epic. Test: two tasks of one epic
  closed in one reconcile → one line, correct count.
- Reminders module (ENG-9): `scripts/lib/reminders.mjs` owns the reminder line syntax (`isReminderLine`,
  `parseReminders` with stable numbering), and the Russian + English title word list (`isReminderTitle`) used by
  the `pm task new` hint and the `reminder-task` audit. Tests: real ATS titles (flag/release/wait wording) as
  positives, ordinary titles ("ask for X" in another sense) as negatives, both languages.
- `pm remind --clear` (ENG-10) prints the text of each line it ticked; help and README say numbers are positions
  among the task's `remind:` lines. Test: a hand-deleted ticked line shifts later numbers and the echo shows the
  actual text.
- Audit count (ENG-11): the SessionStart `auditLine` count excludes `reminder-task`; `pm audit` still lists it.
- Input (ENG-12): `pm remind` text, `--why` and `later#n` text become one line (newlines → spaces), lose a leading
  `- [ ]`, `- [x]`, `---` or `#`, and are cut to 200 characters; empty after cleanup → error. `PM_DEBUG` output of
  Stop has paths and counts only. Tests: each sanitizing case.
- Build order (ENG-13): step 1 folds the CEO/DX/Eng accepted bullets into §1–§7 (done when no §1–§7 line
  contradicts an accepted bullet); `pm set <id> status=dropped` keeps working and prints a one-line hint to use
  `pm drop <id> --why` (ENG-15).
- Tests (ENG-14): lock failure uses a pre-created `index.lock` file (same on every OS); dates come from
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and `fs.utimesSync`, never sleeps. Performance check (manual, test plan):
  `time node scripts/pm.mjs hook stop` on a large repo before/after stays within +20 ms.
<!-- /autoplan-accepted:eng -->
## Review record

Autoplan run 2026-10-28. Base branch `master`. UI scope: no (1 term match, threshold 2). DX scope: yes
(`dxRequired`, developer tool used by agents). Outside voice: Codex `ready`.

### CEO phase — Step 0 (mode SELECTIVE EXPANSION, autoplan override)

**System audit.** Branch `ZizzX/feat-epic-remaining-tasks` = `master` (0 commits ahead, no diff, no stash). No
TODO/FIXME in `scripts`, `commands`, `skills`, `hooks`. No CLAUDE.md, no TODOS.md in the repo; work is tracked on
the pm board itself. Hot files last 30 days: `skills/pm/SKILL.md`, `scripts/pm.mjs`, `scripts/lib/summary.mjs`,
READMEs (3 commits each), `tasks.mjs`, `store.mjs`, `hooks.mjs` (2). Prior specs: `2026-10-22-close-learnings-audit-design.md`
(added `/close`, `pm audit`, learnings) is the direct predecessor; this plan edits the same texts. No gstack
learnings for this project. Retrospective: 0.11.0 added "file leftovers as tasks" to `/done` and `/close`; the
pile grew after it — this plan partly reverts that 0.11.0 choice.

Taste calibration — good references: `scripts/lib/audit.mjs` (findings as data, `--fix` only for mechanical
items, every other finding names the command), `onSafetyNote` in `hooks.mjs:155-179` (session-scoped change
window). Avoid: `lastBoardUpdate`+`codeChangedSince` (`hooks.mjs:52-64`, compares unrelated clocks), the
"what's left?" asked twice in `commands/done.md:17-20`.

Landscape (in-distribution knowledge; no web search run): Linear/Jira triage inboxes, GitHub "convert to issue",
and agent-memory plugins all default to *capture everything*; the tried-and-true counterweight is a triage step
with an explicit owner decision (Linear Triage, GTD "do it if <2 minutes"). Layer 3: for an agent the capture
cost is zero and the review cost is the user's, so the default must flip to "resolve in the conversation".
EUREKA: the 2-minute rule applies to agents with the user's yes as the gate — fixing costs the agent seconds,
a task costs the user a later decision.

**0A Premises.**
1. The plugin's own instructions produce most of the pile — supported (five instruction sites + Stop hook; 82%
   of open ATS tasks are of the instructed kinds). Accepted.
2. Text changes move agent behavior — partly assumed; agents follow the session-start RULES line strongly (it
   is the only always-present rule). Mitigated: the plan also changes code (Stop hook, hint, audit). Accepted.
3. Reminders are not tasks — supported by the user's 23.10 rule on flags. Accepted.
4. "Ask first" is wanted even for small in-area fixes — stated by the user. Accepted.
5. Epic progress text helps manage epics — stated by the user. Accepted.
Real problem: the board's signal-to-noise. Do-nothing cost: hand purges every ~2 weeks, `pm next --options`
offers junk first, and the agent re-reads dozens of title-only tasks every session.

**0B Existing code leverage.** Stop fix → reuse `session-<id>` state, `committedSince`, `dirtyFilesSince`
(`hooks.mjs:30-50,107,164-167`). Reminders → reuse the task's `## Checklist` body section (`TEMPLATE_BODY`,
`tasks.mjs:10`) and the existing `waiting`/`review` statuses. Epic counts → lift `summary.mjs:83-84` into a
helper. Audit → two more checks in the `runAudit` loop (`audit.mjs:31-67`). Drop → `setFields` +
`appendLogLine` + `persist`. Provenance → `newTask` data (`tasks.mjs:117-129`). Nothing is rebuilt.

**0C Dream state.**
```
  CURRENT                         THIS PLAN                          12-MONTH IDEAL
  title-only tasks pile up;  ---> default "resolve in the      ---> the board holds only real work;
  user purges by hand;            conversation"; reminders on       every task has origin + goal;
  Stop nudge lies; epic           their parent; honest Stop;        epics end explicitly; audit shows
  progress invisible              epic counts; audit + pm drop      a drop-never-started rate near 0
```

**0D.** No approach choice needed: the requested plan (A) is the smallest that covers the user's three asks.

**0E Mode.** SELECTIVE EXPANSION (autoplan override; would also be the recommendation: added capability to an
existing system, ~20 files touched incl. tests — over the 15-file line only because of docs and tests).

**0F/0G — HOLD checks.** Complexity: >8 files, 0 new classes, 2 new commands (`pm drop`, `pm remind`). The
minimum for the goal is §1+§3+§4; §5 (cleanup) and §6 (provenance) are the user's "solve the pile" ask, so they
stay. The weakest item is the `reminder-task` heuristic (word lists, false positives) — kept as list-only
(TASTE, see T2).

**Cherry-pick candidates (delight scan).**

| # | Proposal | Effort | Decision | Principle |
|---|----------|--------|----------|-----------|
| E1 | `pm task new` prints a one-line hint when this worktree has a task in progress and no `--from` | S | ACCEPTED | P2 in blast radius, non-blocking |
| E2 | Summary "hygiene" line (N empty tasks) | S | SKIPPED | P4 duplicates the weekly audit line |
| E3 | `pm drop --empty-older 14d` bulk selector | S | SKIPPED | P4 + non-goal: every drop names its ids |
| E4 | Epic progress bar in board.html | M | DEFERRED | outside blast radius (UI) |
| E5 | `pm handoff "<text>"` printing a paste-ready prompt for a separate session | S | DEFERRED | P5 the agent writes one paragraph without a command |
| E6 | Last task of an epic closed → `pm done` reminds to update the epic's focus line; `/close` step 3 asks the direction | S | ACCEPTED | P2 in blast radius |
| E7 | Audit stat: share of tasks dropped never started | S | DEFERRED | measurement before the change lands is noise |

TODOS.md: the repo has none and tracks work on its pm board; deferred items go to "NOT in scope" (P5).

**Decision ledger (CEO).**

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| CEO-1 mode | Step 0E | — | SELECTIVE EXPANSION | approved | autoplan override |
| CEO-2 reminders storage (§2) | builder latitude in "What is left to the builder" | `remind:` field or body section | `- [ ] remind: …` lines under `## Checklist` | approved (TASTE T1) | autoplan auto-decision P4/P5 |
| CEO-9 reminders hold the task open? (§2) | spec review 1: merge auto-close, reconcile and `review-no-pr` audit all bypass or misfire on a reminder-held task (`merged.mjs:242-262,284`, `audit.mjs` review-no-pr) | `pm done` → review while open | reminders never hold a task; visible in `Reminders:` until cleared | approved (TASTE T3) | P5 explicit + P3 pragmatic; reverses the earlier provisional CEO-2 detail |
| CEO-13 retain declined findings | native P4 + Codex 3 (both): "No → final report" loses findings | final report only | `later:` Log line + one `/close` pass | approved (TASTE T4) | P1; not a new task type |
| CEO-14 success metric | native P1 + Codex 1/7 (both): no way to tell if the rule worked | E7 deferred | `pm audit` stats line | approved | P1, reverses the E7 deferral on new evidence |
| CEO-15 epic wording | Codex 5: "finished" claims an outcome | "the direction is finished" | "no open tracked tasks" + open reminders | approved | P5 |
| CEO-16 hint bypass | native P2: agents file junk with `--epic` | quiet with --from/--epic/--deps | quiet with --from/--deps; reminder titles always hinted | approved | P1 |
| CEO-17 Stop simplification | native C2/R3 + Codex 7: attribution rules too clever | author-email filter (CEO-12) | non-merge commits by author time | approved (TASTE T5) | P5 explicit over clever |
| CEO-18 rollout order | native R4 | none | clean boards after install | approved | P6 |
| CEO-UC1 stage the release | native C2/C3/order + Codex 7/recommendation (both) | everything in 0.13.0 (user: solve the pile too) | 0.13.0 = Stop fix, triage text + `later:`, hint, provenance, epic progress, metric; `pm remind`, `pm drop`, `reminder-task` heuristic after the metric shows need | USER CHALLENGE — not applied | final gate |
| CEO-T6 `pm handoff` | native A3 (core of the ask) vs Codex 4 (separate sessions cost attention) | E5 deferred | — | deferred (TASTE T6) | models disagree |
| CEO-T7 ask before every in-area fix | native P3 suggests auto-fix tiny same-file findings | ask first (user's words) | — | kept (TASTE T7) | the user's explicit direction |
| CEO-12 spec-review 3 fixes | spec review 3: DoD vs remind lines, pm remind edge cases, Reminders format, foreign commits in Stop, empty age rule, all-dropped epic, --from option | — | applied by author after the loop | approved | mechanical P1/P5; not re-reviewed (3-launch cap) |
| CEO-11 spec-review 2 fixes | spec review 2: drop matrix, commit subject, summary cap, reminders on dropped tasks, null head, epic of pm done, blocked part | — | applied | approved | mechanical P1/P5 |
| CEO-10 spec-review fixes | spec review 1 findings C1-C8, K1-K5, L1-L4, F1-F5 | — | applied as baseline edits + accepted bullets | approved | mechanical P1/P5 |
| CEO-3 E1 hint | blast radius `pm.mjs` | none | accepted | approved | P2 auto-decision |
| CEO-4 E6 epic-finished prompt | blast radius `pm.mjs`, `close.md` | none | accepted | approved | P2 auto-decision |
| CEO-5 E2,E3 | duplicates | — | skipped | declined | P4 |
| CEO-6 E4,E5,E7 | outside radius / premature | — | deferred | deferred | P3 |
| CEO-7 context section 0 | reviewers see only Implementation plan | none | add §0 summary of Intent | approved | mechanical, baseline edit |
| CEO-8 `reminder-task` audit heuristic | §5 | list-only heuristic | keep | approved (TASTE T2) | P1 completeness vs P5 |

<!-- autoplan-accepted:ceo -->
- §0 "Context for reviewers" is added at the top of the Implementation plan: a summary of the Intent, evidence,
  non-goals and anti-goals; it adds no behavior.
- Reminders are `- [ ] remind: <text>` lines under the task's `## Checklist` and never hold a task open (§2 as
  amended: `pm remind` add/list/clear with stable numbers, `pm remind` without id lists the board, summary
  `Reminders:` line). Tests: add; a task without `## Checklist` gets the section before `## Log`; list numbers stay
  the same after a clear; clear one; clear all; a done task with an open reminder appears in `Reminders:` and
  disappears after clear; merge auto-close and `pm reconcile` are unaffected by open reminders.
- `pm task new` without `--from`, `--epic` or `--deps`, while this worktree has a task in progress: after the
  created id it prints one hint line naming that task (the lowest id if several): fix it now or offer a separate
  session; `--from <id>` records the origin. Never blocks; exit code 0. Tests: hint with a task in progress; none
  without one; none with `--from`; none with `--epic` or `--deps` (a "break it down" run stays quiet).
- The epic-finished prompt is part of §4's single `pm done` epic line (one line, not two); `commands/close.md`
  step 3 adds: epic finished → ask the user which direction is next, then update or remove its focus line.
  Tests: last task → done prints the focus-line hint; last task → review prints `1 left (1 in review)`; not last →
  the count line; `pm reconcile` closing an epic's last task prints the line.
- Stop hook tests, in addition to §3: a commit in the session followed by a board update after it, 20+ minutes
  later → no block; `session_id` present but no state file → no block; the existing test asserting the old
  message is updated to the new one.
- `pm drop` tests: refuses another worktree's in_progress task; drops this worktree's own; refuses when an open
  task outside the set depends on an id and names it; succeeds when the dependent is in the set; clears a `next`
  mark; one board commit with the `pm: drop` prefix that `pm show` reads.
- `pm remind` and `pm drop` get usage lines in `pm help` (`pm.mjs` usage block), rows in `skills/pm/SKILL.md`
  ("remind … after …" → `pm remind` on the task it belongs to; "drop these" → `pm drop` only with the ids the user
  confirmed) and lines in README.md / README.ru.md.
- Deferred items (E4 board.html epic progress bar, E5 `pm handoff`) are listed under "NOT in scope"; E7 (the
  drop-never-started stat) is no longer deferred — CEO-14 makes it the `pm audit` stats line. No TODOS.md is created.
- Spec review 2 fixes (all CEO-11):
  - Reminders: a dropped task is excluded from `Reminders:`; `pm drop` prints the open reminders it discards. A
    task with an open reminder is never `empty` in the audit. `pm remind` add and clear count as a manual board
    write (they bump `updated`).
  - `pm drop`: ids comma- or space-separated; `--why` required; all-or-nothing — any refusal drops nothing and
    lists every reason. Droppable: todo, waiting, review, and this worktree's own in_progress. Refused: unknown id,
    done, already dropped, another worktree's in_progress, an open dependent outside the set.
  - Stop: a null `head` in the state file → commits count as none (dirty files only); no git repository → no
    block.
  - `pm done` reports the epic of the task it closed, not the worktree's.
  - `epicProgress` adds `blocked` = todo with an unmet dependency; printed parts are ready, blocked, in
    progress, waiting, in review, and they sum to `open`.
  - Summary placement: the epic line goes after this worktree's task lines, before `Elsewhere:`; `Reminders:`
    goes right after `Waiting:`. Test: a summary over the 40-line cap still shows the epic line.
  Tests: each refusal reason of `pm drop` and all-or-nothing; dropped task gone from `Reminders:`; `empty`
  skips a task with an open reminder; null head; done reports the task's epic; blocked part; cap test.
- Spec review 3 fixes (CEO-12, author-applied after the loop's last review; not re-reviewed):
  - Definition of done: `commands/done.md` step 2 and the `skills/pm/SKILL.md` done row say "checklist closed —
    open `remind:` lines do not count". Test: a wording assertion on both files.
  - `pm remind` edge cases: the new line is appended at the end of the `## Checklist` section; empty text,
    an unknown id or a dropped task → error, nothing written; `--clear` with a number out of range → error
    listing the valid numbers; `--clear` on an already ticked line → no-op with a note. The board-wide list prints
    one line per open reminder: `T-123#2 <text>`.
  - `Reminders:` summary line: one entry per open reminder, `T-123#1 <text>`, at most 3 entries, then
    `+N more (pm remind)`.
  - Stop commits: only non-merge commits in `<head>..HEAD` whose author email is the local `git config
    user.email` (all non-merge commits when it is unset), compared by author time (`%at`), so a pull, merge or
    rebase inside the session does not count. "No state file" is an existence check, not `readState`'s default.
  - `pm remind` writes the task file like any other manual CLI write (it counts in `manualMtime` and sets
    `updated` to today); Stop counts it only for a task of this worktree, as today.
  - `empty` audit, one rule for §5 and §6: open `todo`, empty Goal, empty Log, no open reminder, and its age —
    `created` when present, else `updated` — is 14+ days.
  - An epic whose tasks are all dropped: `Epic X: no tasks left (N dropped)`; with some done: `(N done)`.
  - `pm task new --from` is added to the CLI's string options (`pm.mjs:174`).
  Tests: each `pm remind` error case and the ticked no-op; `T-123#n` format and the 3-entry cap; a commit by
  another author and a merge commit inside the session do not block; a rebased own commit (old author time) does
  not block; `empty` skips a task whose `created` is recent even if `updated` is old.
- Dual-voice decisions (CEO-13..18; native CEO subagent + Codex both reviewed the plan):
  - Declined findings are retained, not forgotten (CEO-13): triage branch 1 "No" and branch 2 declined → one Log
    line on the current task, `- <date> · <worktree> · later: <text>` (existing `appendLogLine`, no new
    command). `/close` step 1 lists this session's `later:` lines once and asks per line: keep (stays in the
    Log), make it a task (`pm task new --from <id>`), or dismiss (`later dismissed` line). Tests: wording of the
    triage branches and of `/close` step 1.
  - Success metric (CEO-14, promotes E7): `pm audit` prints one `stats` line, not a finding: tasks created in the
    last 30 days (by `created`), how many were dropped without a manual Log line, how many are `empty` at 14+
    days. Boards without `created` print nothing. Test: counts on a fixture board; absent without `created`.
  - Epic wording (CEO-15): "no open tracked tasks", never "the direction is finished"; the epic line adds
    `· N open reminders` when that epic has any. Applies to the summary, `pm done`, `pm next`.
  - `pm task new` hint (CEO-16): quiet only with `--from` or `--deps` (not `--epic`); a title matching the
    reminder word list always gets the hint, even with an epic. Tests updated accordingly.
  - Stop commits (CEO-17, supersedes the author-email rule of CEO-12): non-merge commits in `<head>..HEAD` whose
    author time (`%at`) is newer than `updated`; no author filter. Test: a merge commit does not block; an own
    commit after the board update blocks.
  - Rollout order (CEO-18): the user cleans the ATS/Wizzard boards only after 0.13.0 is installed there, with
    `pm audit` → confirmed ids → `pm drop`; the plan's Release section says so.
- CEO review-section requirements (CEO-19): `pm drop` runs under `withLock(pm, 'claim')` like `takeNext`;
  repeated ids are deduped; `pm task new --from` validates the id before `newTask` reserves a file; Stop tests set
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and `fs.utimesSync` explicitly (no sleeps); `validate` keeps
  accepting unknown optional fields so 0.12.0 and 0.13.0 can share a synced board. Tests: drop vs claim under the
  lock; repeated id; `--from` unknown id leaves no new file; a 0.12.0-shaped board validates.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"51bd178eb45e1607eed28f73d407a57a7b6810d06f94fcc1b4b6535bc5ead997","replacements":[{"oldText":"### 1. Finding triage replaces \"file leftovers as tasks\" (protocol text)","newText":"### 0. Context for reviewers (summary of the Intent above; no behavior of its own)\n\n- Problem (user, 2026-10-28): agents file reminders, one-line fixes and leftovers as separate tasks; nobody\n  reaches them. Wanted: found and fixable -> fix now after asking (say what the answer changes); unrelated ->\n  offer a separate session started now; the current epic says \"no tasks left\" or \"N left\".\n- Evidence: the user's ATS board has 296 tasks, 65 open; 53 of the 65 (82%) are reminders/waits (26),\n  mid-work findings (20) or close-time leftovers (7). 48 of 65 have an empty Log, 27 are untouched 14+ days. The\n  user purged by hand three times (44 dropped, 40 never started). A 23.10 user rule \"no flag tasks\" left five\n  older flag tasks open. Follow-ups that got done were tiny (T-067, T-177: one line). Tasks have no\n  created/parent field.\n- Sources in this repo: summary.mjs:12 (RULES printed every session: \"file leftovers as tasks\"),\n  commands/done.md:17-20 (asked twice, every leftover -> pm task new), commands/close.md:13,17,\n  skills/pm/SKILL.md:44,71, skills/retro/SKILL.md:28,38. Stop hook hooks.mjs:61-64 compares the HEAD commit time\n  with the newest manual board write of this worktree's tasks; a worktree with no tasks has updated=0, so any\n  HEAD fires \"create/claim a task\" (three false nudges in one session with a clean tree).\n- Epic gap: with 0 open tasks the header still says epic X, the Epics: line drops X, pm next fails with\n  \"nothing ready in epic X\", pm done says nothing about the epic.\n- Non-goals: no auto-drop (every drop is the user's yes), no new task types or priorities, no scheduler, no\n  change to epic creation/archive; cleaning the user's boards is a rollout step, not code.\n- Anti-goals: losing tasks the user wants; fixing unrelated things without asking; more questions than today;\n  a hard gate on pm task new.\n\n### 1. Finding triage replaces \"file leftovers as tasks\" (protocol text)"},{"oldText":"- A reminder that outlives the task (\"remove flag X after the prod tag\"): `pm remind T-NNN \"<text>\"` appends a\n  `remind:` entry to the task that created the flag. `pm done` on that task with open reminders moves it to\n  `review` instead of `done` and prints them; `pm remind T-NNN --clear <n>` (or `--clear all`) resolves them, and\n  a task in `review` with no reminders and no open PR closes on the next `pm done`. The summary shows\n  `Reminders: T-123 remove flag X after prod tag` for this epic (max 3, then `+N`).","newText":"- A reminder that outlives the task (\"remove flag X after the prod tag\"): `pm remind T-NNN \"<text>\"` appends an\n  unchecked line `- [ ] remind: <text>` under that task's `## Checklist` (the section is created before `## Log`\n  when missing). Reminders never hold a task open: the task closes as usual (`pm done`, merge, `pm reconcile`),\n  and its open reminders stay visible in the summary's `Reminders:` line until cleared. `pm remind T-NNN` lists\n  them numbered over all its `remind:` lines (a ticked line keeps its number, so numbers never shift);\n  `pm remind T-NNN --clear <n|all>` ticks them (`- [x] remind: …`); `pm remind` with no id lists every open\n  reminder on the board; `pm show` prints the task's numbered list.\n- Summary `Reminders:` line: every task with an open reminder, any status, this worktree's epic first:\n  `T-123 remove flag X after prod tag (pm remind T-123 --clear 1)`; at most 3, then `+N more (pm remind)`.\n  board.html shows them as raw text lines of the Checklist block (`board.mjs:189`; no board code change)."},{"oldText":"listed as candidates to fold into their parent's `remind:` or drop.","newText":"listed as candidates to fold into the task they came from (`pm remind` on it) or drop."},{"oldText":"- Whether `remind:` is a frontmatter list or a `## Reminders` body section — whichever `frontmatter.mjs` handles\n  without a new parser.\n","newText":""},{"oldText":"- `pm done` (`pm.mjs:446-454`): after the outcome line, `epic X: 2 left (1 ready)` or `epic X: that was the last\n  task — nothing left; it moves to the Archive`. No epic → nothing extra.","newText":"- `pm done` (`pm.mjs:446-454`): after the outcome line, one epic line computed after the change: open > 0 →\n  `epic X: 2 left (1 ready, 1 in review)`; open = 0 → `epic X: that was the last task — nothing left. Update or\n  remove its focus line in PLAN.md; /close asks which direction is next.` A task that went to `review` is still\n  open (it closes at its merge), so it is counted. `pm reconcile` prints the same line for each epic whose last\n  task it closed; after a session-start auto-close the summary's `Epic X: no tasks left` line says it. No epic →\n  nothing extra."},{"oldText":"One helper `epicProgress(tasks, epic)` in `scripts/lib/tasks.mjs` → `{ open, ready, inProgress, waiting, review,\ndone, total }` (dropped excluded from total, as `summary.mjs:83` does today).","newText":"One helper `epicProgress(tasks, epic)` in `scripts/lib/tasks.mjs` → `{ open, ready, inProgress, waiting, review,\ndone, total }`: `total` excludes dropped (as `summary.mjs:83` does today); `open` = `isOpen` (todo,\nin_progress, waiting, review); `ready` = the epic's tasks in `readyQueue`. Printed parts, in this order, zero\nparts omitted: ready, in progress, waiting, in review."},{"oldText":"- `onStop` uses the session state SessionStart already writes (`session-<id>`: `start`, `head`, `hooks.mjs:107`)\n  — the same window `onSafetyNote` uses (`:164-167`): changed = `committedSince(cwd, head)` non-empty OR\n  `dirtyFilesSince(cwd, max(start, updated))` non-empty. No session state (no `session_id`) → do not block.","newText":"- `onStop` uses the session state SessionStart already writes (`session-<id>`: `start`, `head`, `hooks.mjs:107`).\n  Changed = a commit in `<head>..HEAD` whose commit time is newer than `updated`, OR a dirty file whose mtime is\n  newer than `max(start, updated)`. No `session_id`, or no state file for it → do not block (by design).\n  `onSafetyNote` resets `start`/`head` after each note (`hooks.mjs:175`), so the Stop window then starts at that\n  note — intended, the note already logged those files. `codeChangedSince` is removed."},{"oldText":"- `pm drop <ids> --why \"<reason>\"`: sets `status=dropped`, appends `- <date> · <worktree> · dropped: <reason>` to\n  each Log, one board commit `pm: drop T-1, T-2 (<reason>)`. Refuses `in_progress` tasks of another worktree.","newText":"- `pm drop <ids> --why \"<reason>\"`: sets `status=dropped`, appends `- <date> · <worktree> · dropped: <reason>` to\n  each Log, one board commit `pm: drop T-1, T-2` (ids only; the reason lives in each Log line). Refuses `in_progress` tasks of another worktree\n  (this worktree's own may be dropped). Refuses when an open task outside the set depends on one of the ids and\n  names it (`T-200 depends on T-114 — drop it too, or pm set T-200 depends_on=…`). A `next` mark on a dropped\n  task is cleared. `show.mjs` reads the `pm: drop` subject like `pm: reconcile closed` (a `, `-separated id list). A command rather than\n  `pm set status=dropped` because a purge is many ids, one reason, one commit (the user's purges were 12–16\n  tasks each)."},{"oldText":"- `test/merged.test.mjs` / `test/cli.test.mjs`: `pm done` epic line; `pm done` with open reminders → `review`.","newText":"- `test/merged.test.mjs` / `test/cli.test.mjs`: `pm done` epic line (done, review, last task); `pm reconcile` epic\n  line; `pm task new` hint cases; open reminders do not change `pm done` or the merge auto-close."}]} -->

**0H.** CEO scope summary saved: `~/.gstack/projects/ZizzX-claude-project-memory/ceo-plans/2026-10-28-no-junk-tasks-epic-progress.md`.
Spec review loop: 3 launches (scores 6, 7, 7; FAIL each), 43 issues found, 34 fixed and not re-raised, 9 reported
by the last review and then applied by the author without re-review (CEO-12). Metrics appended to
`~/.gstack/analytics/spec-review.jsonl`. Document approval: A (approve both documents and continue) —
autoplan auto-decision, recommended option.

**0I Temporal interrogation** (human team / CC+gstack):
```
  HOUR 1 (foundations): epicProgress + blocked part; created/from in newTask; strings option --from.
                        Know: isOpen, readyQueue, byEpic, activeEpic (tasks.mjs:237-263).        ~1h / ~10min
  HOUR 2-3 (core):      Stop rewrite (author-filtered %at commits, existence check, null head);
                        pm remind (Checklist append/tick, stable numbering); pm drop matrix.
                        Ambiguity: Checklist section parsing on old tasks without the section.     ~4h / ~30min
  HOUR 4-5 (integration): summary placement under MAX_LINES; pm done/reconcile epic line with the
                        closed task's epic; pm next reasons; audit empty/reminder-task; show.mjs
                        `pm: drop` subject. Surprise: show.mjs boardHistory greps ids in subjects.  ~4h / ~30min
  HOUR 6+ (polish):     protocol texts (summary RULES, SKILL.md, done.md, close.md, retro), help,
                        READMEs en/ru, version bump, CI matrix (Windows paths in Stop tests).       ~4h / ~30min
```
Feasibility blockers: none. Pending choices for the implementer: exact wording only.

### CEO phase — dual voices

Native CEO subagent: completed (INPUT ceo 15543a5c…, 239/239 lines read). Codex: completed
(`OUTSIDE_STATUS: completed provider=codex host=claude`), recommendation "narrow the release and validate
deferred-work handling before adding reminders".

```
CEO DUAL VOICES — CONSENSUS TABLE:
  Dimension                            Claude              Codex               Consensus
  1. Premises valid?                    partly (P1: prose   partly (82% by      CONFIRMED concern: prose rule
                                        rule failed once)   origin, not value)  needs a metric (CEO-14)
  2. Right problem to solve?            yes, over-built     yes, product        CONFIRMED right problem,
                                                            boundary open       scope too wide
  3. Scope calibration correct?         no — stage it       no — stage it       CONFIRMED → USER CHALLENGE UC1
  4. Alternatives sufficiently explored? no (inbox/TTL,     no (external        CONFIRMED gap: listed in NOT in
                                        event-located)      tracker)            scope with reasons
  5. Competitive/market risks covered?  platform risk med   tracker overlap     CONFIRMED (medium): stay small
  6. 6-month trajectory sound?          pile moves into     reminders without   CONFIRMED → CEO-13/14, UC1
                                        reminders           lifecycle
```
Single-voice items: native P3 (auto-fix tiny findings without asking) → TASTE T7, kept as the user said;
native A3 vs Codex 4 on `pm handoff` → TASTE T6, deferred; native A1 inbox-with-TTL → rejected (NOT in scope).

### CEO phase — Review Sections

Current scope: Mode SELECTIVE EXPANSION; approved CEO-1..18 (autoplan auto-decisions); UC1 pending at the gate.

**Section 1 — Architecture.** All changes stay inside the existing CLI + hooks + protocol-text architecture; no
new module. New coupling: `summary.mjs`, `pm.mjs` (done/next/reconcile/epics) and `audit.mjs` all read one new
helper `epicProgress` in `tasks.mjs` (justified: today the same count lives inline in `summary.mjs:83-84`).
```
  hooks.json ─► hooks.mjs ─ onSessionStart ─► writeState(session-<id>: start, head)
                          └ onStop ──────────► readState(session) ─► git log --no-merges <head>..HEAD (%at)
                                                                   └► dirtyFilesSince(max(start, updated))
  pm.mjs ─ task new (--from, created, hint) ─► tasks.mjs newTask
        ├ done / reconcile / next / epics ──► tasks.mjs epicProgress ◄── summary.mjs buildSummary
        ├ remind (Checklist lines) ─────────► tasks.mjs (body edit) ──► summary Reminders:
        ├ drop (all-or-nothing) ────────────► setFields + appendLogLine + persist ─► show.mjs (pm: drop)
        └ audit ────────────────────────────► audit.mjs (+empty, +reminder-task, +stats)
  protocol text: summary RULES · skills/pm/SKILL.md · commands/done.md · commands/close.md · skills/retro
```
Data paths for `epicProgress`: happy (tasks of epic) → counts; nil (no epic) → no line; empty (all dropped) →
"(N dropped)"; error (unreadable task file) → `listTasks` already throws for the whole command, unchanged.
Scaling: boards of ~300 files are read every command today; one more pass over the in-memory list is O(n).
Rollback: plugin version pin back to 0.12.0; board files gain only optional fields and Checklist lines that
0.12.0 ignores. 1 issue (coupling made explicit), resolved by the shared helper.

**Section 2 — Error & Rescue Map.**
```
  CODEPATH                    | WHAT CAN GO WRONG                     | CLASS / RESULT
  onStop git log <head>..HEAD | head unknown (gc'd, other clone)      | git error → tryGit null
                              | no git repo                           | tryGit null
                              | state file missing / head null        | existence check / null
  pm remind                   | unknown/dropped id, empty text        | fail() usage error
                              | --clear out of range / already ticked | fail() / no-op note
  pm drop                     | any refusal reason                    | fail() all-or-nothing, lists reasons
                              | persist (git commit) fails            | existing persist error path
  pm task new --from          | unknown id                            | fail() before the id is reserved
  epicProgress                | epic with only dropped tasks          | "(N dropped)"

  CLASS                 | RESCUED? | ACTION                         | USER SEES
  tryGit null (Stop)    | Y        | treat as "no commits"; no block | nothing (by design)
  fail() usage errors   | Y        | exit 1, nothing written         | one-line reason
  drop refusal          | Y        | nothing written                 | every reason listed
  persist failure       | Y        | existing message                | "[pm] … commit failed"
```
GAP (WARNING, accepted): Stop's "no block" paths are silent by design; `PM_DEBUG` already prints hook errors.
`--from` must be validated before `newTask` reserves the id (else an orphan file) — recorded as a requirement in
Implementation Tasks. 0 critical gaps.

**Section 3 — Security & Threat Model.** New inputs: `--why`, reminder text, `--from` id, `pm drop` ids.
Ids are validated by `readTask` (`ID_RE`, `tasks.mjs:80-85`), so no path traversal. Free text goes into markdown
bodies and a git commit subject; the drop subject carries ids only (CEO-11), so no subject injection; Log text
is already free-form today. No secrets, no network, no new dependency. git commands use argument arrays
(`tryGit([...])`), no shell interpolation. No issues found beyond confirming the id-only subject.

**Section 4 — Data flow & interaction edge cases.**
```
  pm remind T-1 "text" → validate id/status/text → find ## Checklist (create before ## Log) → append "- [ ] remind:"
     shadow: nil text → error · dropped task → error · no Checklist → create · duplicate text → allowed (own number)
  pm drop A,B --why r → validate all (status, worktree, dependents) → if any fail: list, write nothing
     → setFields ×N → appendLogLine ×N → one persist commit "pm: drop A, B"
     shadow: id repeated in args → dedupe · concurrent claim → withLock('claim') like takeNext
  onStop → state exists? → git log --no-merges %at > updated? or dirty mtime > max(start,updated)? → block once / 20 min
```
Async: `pm drop` and `pm claim` can race on the same task; requirement: take the existing `withLock(pm,'claim')`
(as `takeNext` does, `pm.mjs:117`). Interaction edge cases: double `pm done` on the last task → second call
fails as today; `pm remind --clear all` twice → no-op note. 1 gap (lock) → requirement added.

**Section 5 — Code quality.** DRY: epic counts move to one helper (removes the inline copy at `summary.mjs:83`).
`codeChangedSince` removed. Risk: `pm.mjs` grows two subcommands; keep each as a small function like `takeNext`.
Reminder parsing must reuse the existing section regex style of `blurb` (`pm.mjs:131-136`) rather than a new
parser. Over-engineering flag: the `reminder-task` heuristic (T2) — kept list-only. 2 notes, no blocking issue.

**Section 6 — Tests.** Diagram of new codepaths → tests (all unit/integration via `node --test`, no E2E):
```
  Stop window ............... hooks.test.mjs: 8 cases (regression, commit, merge, dirty new/old, no session, no state, null head)
  epicProgress + lines ...... summary/epics/next/merged tests: open>0, 0 done, 0 dropped, review, blocked, cap
  pm remind ................. tasks.test.mjs: add, create section, numbering, clear one/all, errors, ticked no-op
  pm drop ................... tasks/cli tests: each refusal, all-or-nothing, own in_progress, next cleared, subject parse
  pm task new hint/--from ... cli.test.mjs: hint on/off matrix, --from validation, created field
  audit ..................... audit.test.mjs: empty, reminder-task, stats, --fix untouched
  protocol text ............. summary.test.mjs RULES + wording assertions on done.md / close.md / SKILL.md
```
2am-Friday test: the Stop regression (old HEAD, clean tree, no tasks → no block). Hostile QA: `pm drop` with a
dependent outside the set. Chaos: state file deleted mid-session. Flakiness: Stop tests depend on mtimes and
author time → use explicit `GIT_AUTHOR_DATE` and `fs.utimesSync`, never sleep. 0 gaps after the obligations.

**Section 7 — Performance.** One extra `git log` per Stop (bounded to `<head>..HEAD`); `epicProgress` O(n) on an
in-memory list; `audit` adds two passes. Summary must stay ≤ 40 lines (placement rule CEO-11). No issues.

**Section 8 — Observability.** The product's observability is the board itself: `pm: drop` commit, `dropped:`
and `later:` Log lines, `created`/`from`. The CEO-14 `stats` line is the feature's health metric (is the
drop-never-started share falling?). Debuggability 3 weeks later: `pm show` prints provenance and the drop
reason. 1 gap closed by CEO-14.

**Section 9 — Deployment & rollout.** No migration: new fields optional, old tasks valid. Partial deploy: two
machines on 0.12.0 and 0.13.0 share a synced board — 0.12.0 ignores `created`/`from` and Checklist lines,
`validate` must not reject unknown fields (it does not today). Rollback: reinstall 0.12.0. Post-deploy check:
start a session in a worktree with no tasks and an old HEAD → no Stop nudge; run `pm audit` on the ATS board →
`empty` + `stats` lines. Rollout order CEO-18. 1 risk flagged (mixed versions), handled.

**Section 10 — Long-term trajectory.** Debt: protocol text in five files must stay consistent (a wording test
guards the key sentences). Reversibility 4/5 (text and optional fields; only `pm drop` writes irreversibly, and
git revert of the board commit undoes it). The `created` field enables the metric that decides the next
release (UC1). Platform potential: `later:` lines + `/close` checkpoint are the hook for a future handoff.
1-year question: a new engineer sees one helper, two commands, and a triage rule in SKILL.md — obvious.

**Section 11 — Design.** SKIPPED (no UI scope).

### CEO phase — required outputs

**NOT in scope.**
- E2 summary hygiene line — skipped, duplicates the weekly audit line.
- E3 `pm drop --empty-older` — skipped, every drop names its ids.
- E4 board.html epic progress bar — deferred, UI outside blast radius.
- E5 `pm handoff` — deferred (TASTE T6, models disagree).
- Inbox status with TTL (native A1) — rejected: a staging status is another pile; the user wants fewer tasks.
- External tracker integration (Codex 6) — rejected for now: the board is the product; revisit with the metric.
- Cleaning the ATS/Wizzard boards — a rollout step for the user (CEO-18), not code.
- If UC1 is approved: `pm remind`, `pm drop`, `reminder-task` heuristic move to the next release.
(No TODOS.md: the repo tracks work on its pm board.)

**What already exists.** Session window: `onSessionStart` state + `committedSince`/`dirtyFilesSince`
(`hooks.mjs:30-50,107`). Epic counts: `summary.mjs:83-84`, `isOpen`, `readyQueue`, `byEpic`, `activeEpic`
(`tasks.mjs:237-263`). Checklist section in `TEMPLATE_BODY` (`tasks.mjs:10`). Status changes: `setFields`;
Log lines: `appendLogLine`; board commits: `persist`/`commitPm`. Audit framework: `runAudit` findings with
`--fix` only for mechanical items. Undo: `git revert` of a board commit (SKILL.md undo row). All reused.

**Dream state delta.** After this plan: the default flips to resolve-in-conversation, false nudges stop, epics
show progress, the pile can be cleared with confirmed ids, and `created` makes the result measurable. Left for the
12-month ideal: proof from the metric that the junk rate fell, a handoff that starts the second session for the
user (T6), and board.html progress (E4).

**Error & Rescue Registry.** See Section 2 tables: 9 failure rows, all rescued, 0 critical gaps.

**Failure Modes Registry.**
```
  CODEPATH          | FAILURE MODE                         | RESCUED? | TEST? | USER SEES?          | LOGGED?
  onStop            | rebased/pulled commits counted       | Y        | Y     | no false nudge      | n/a
  onStop            | state missing → never blocks         | Y        | Y     | silent (by design)  | PM_DEBUG
  pm drop           | drops a task others depend on        | Y        | Y     | refusal + names     | Log line
  pm drop vs claim  | race on the same task                | Y (lock) | Y     | one wins, one fails | —
  pm remind         | reminders pile up unseen             | partial  | Y     | Reminders: +N more  | —  ← WARNING (UC1)
  triage text       | agent ignores the rule               | metric   | N     | stats line          | stats ← WARNING
  summary           | new lines push others past 40 lines  | Y        | Y     | "… N more lines"    | —
```
0 CRITICAL GAPS; 2 WARNINGS (reminder lifecycle, prose-rule adherence) — both feed UC1 and CEO-14.

**Implementation Tasks (CEO).**
- [ ] **C1 (P1, human ~2h / CC ~15min)** — hooks — Stop window per CEO-17/CEO-11/CEO-12 + new message; remove
  `codeChangedSince`. Files: `scripts/lib/hooks.mjs`, `test/hooks.test.mjs`. Verify: `node --test test/hooks.test.mjs`.
- [ ] **C2 (P1, ~2h / ~15min)** — protocol — triage rule + `later:` lines in RULES, SKILL.md, done.md,
  close.md, retro SKILL.md. Verify: wording assertions in `test/summary.test.mjs`.
- [ ] **C3 (P1, ~3h / ~20min)** — epic progress helper + summary/done/next/reconcile/epics lines. Files:
  `scripts/lib/tasks.mjs`, `summary.mjs`, `scripts/pm.mjs`. Verify: summary/epics/next/merged tests.
- [ ] **C4 (P1, ~2h / ~15min)** — provenance + hint: `created`, `--from` (validated before reserving the id),
  hint matrix. Verify: cli/tasks tests.
- [ ] **C5 (P2, ~2h / ~15min)** — audit `empty`, `reminder-task`, `stats`. Verify: `test/audit.test.mjs`.
- [ ] **C6 (P2, ~3h / ~20min)** — `pm drop` under `withLock('claim')`, `show.mjs` subject. Verify: tasks/cli/show tests.
- [ ] **C7 (P2, ~3h / ~20min)** — `pm remind`. Verify: tasks tests. (C5 heuristic, C6, C7 move to the next
  release if UC1 is approved.)
- [ ] **C8 (P2, ~1h / ~10min)** — help, READMEs en/ru, version 0.13.0, rollout note. Verify: `node --test`.

**Completion Summary (CEO).**
```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | 0 ahead of master; 0.11.0 texts are the     |
  |                      | junk source; Stop compares unrelated clocks |
  | Step 0               | 5 premises accepted; 7 candidates (2 acc.)  |
  | Section 1  (Arch)    | 1 issue found                               |
  | Section 2  (Errors)  | 9 error paths mapped, 0 GAPS                |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 9 edge cases mapped, 1 unhandled → fixed    |
  | Section 5  (Quality) | 2 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 1 gap found → CEO-14                        |
  | Section 9  (Deploy)  | 1 risk flagged                              |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 1           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (8 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 9 rows, 0 CRITICAL GAPS                     |
  | Failure modes        | 7 total, 0 CRITICAL GAPS                    |
  | TODOS.md updates     | 0 items (repo has no TODOS.md)              |
  | Scope proposals      | 7 proposed, 2 accepted (+E7 promoted)       |
  | CEO plan             | written                                     |
  | Outside voice        | codex completed                             |
  | Lake Score           | N/A (no coverage questions asked)           |
  | Diagrams produced    | 4 (architecture, data flow, error, tests)   |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 1 (UC1, for the final gate)                 |
  +====================================================================+
```

### Phase 2 — Design review: SKIPPED (no UI scope; 1 term match, threshold 2). Not a completed review.

### Phase 2.5 — DX review (mode DX POLISH, autoplan override)

Methodology `autoplan-dx-methodology-0PLoX0/methodology.md` read 1–2143/2143 (chunks 1–327, 328–811, 812–1355,
1356–1727, 1728–2143). gstack updated itself to 1.91.307.0 during this phase (10:35–10:41); the fresh bundle
`autoplan-dx-methodology-UmxPgn/methodology.md` (1905 lines) was diffed against the read one and every changed
line from the review sections on (400–1905) was read; the changes before line 400 are preamble (skip-listed). The
review below applies the new rules: the agent as a second persona lens, the agent-ready-v1 error contract in
Pass 3, the "Agents Are Users" coverage row and the `dx_rubric` field. Checkpoint `autoplan-dx-fNUsVh/dx-implementation.md` (sha 68dbfa82…). Timing step skipped:
no RUN_ID/timing root survived compaction.

Guard note (user decision D2 = A, 2026-10-29): the autoplan phase-publication hook waits 2 s for its own tool call
in the session journal, but Claude Code now writes that record only after the PreToolUse hook returns (a 50 ms
journal watcher saw the Read appear 2.2 s later, after the result). Phase files are therefore read through Bash and
the native DX dispatch carries one leading line, so the guard does not track this phase. Reports are still published.

#### Step 0 — DX scope

- Product type: Claude Code plugin (skill + commands + hooks) with a Node CLI (`pm`). Two readers: the agent reads
  every CLI line literally; the developer reads the session summary and answers the agent's questions.
- Persona:
  ```
  TARGET DEVELOPER PERSONA
  Who:       solo developer running 2–5 Claude Code sessions in Orca worktrees of one repo, one shared pm board
  Context:   daily feature work; the board is the cross-session memory; agents write it, the human skims it
  Tolerance: zero setup for the new behavior; one short question per finding; a board cleanup in minutes
  Expects:   the plugin updates itself, nothing is lost without a yes, every message says what to do next
  ```
  Inferred from README "Why"/"Quick start" and the user's ATS/Wizzard boards (P6); not asked (autoplan).
  Second lens (methodology 1.91.307.0): the AI coding agent — reads every CLI line literally, cannot ask, retries.
- Initial DX completeness of the plan: 5/10. Strong on behavior and tests, thin on message text, undo, upgrade
  notes and examples.
- TTHW (feature clock): start = 0.13.0 installed and sessions restarted; useful result = (a) a session whose
  summary shows the epic line and no false Stop nag, (b) a 60-task board cleaned. (a) 0 extra steps (estimated).
  (b) today a hand purge, ~30 min per round (estimated from three manual purges of 12–16 tasks); target < 5 min:
  `pm audit` → user confirms ids → `pm drop --dry-run` → `pm drop`. Tier: Competitive (2–5 min), estimated, not
  measured.

Developer perspective (empathy narrative, first person):
> I update the plugin and restart. The summary now says `Epic import: 2 left of 9 (1 ready, 1 in review)`, which
> is the number I used to count by hand. Mid-task the agent asks "Fix now? one line in parser.mjs, adds it to this
> PR" — I say yes and it is gone; no new card. Later it finds a flaky test in another module and hands me a
> paragraph to paste into a new session. At /close it asks once about two `later` notes; I keep both. On Friday I
> run the audit: 23 cards with only a title, each with its age. I tick the ones I don't recognize, see the dry run,
> drop them, and the output gives me the revert command. What would hurt: a Stop nag after I only pulled master,
> an audit line `T-114, T-115, …` I can't check, a drop I can't see how to undo, and a 0.12 session in another
> worktree refusing to close a task because of a `remind:` line it does not understand.

Competitive DX benchmark (DX choices; times not comparable across boundaries):

| Tool | Start → result | Time + evidence | DX choice | Source |
|------|----------------|-----------------|-----------|--------|
| Beads (`bd`) | agent finds work → issue filed | reported, n/a | agent files every finding, `discovered-from` link | mintlify.com/steveyegge/beads |
| Linear | stale issue → closed | configured period | auto-close to Canceled after N months, auto-archive | linear.app/docs/archive-issues |
| GitHub `actions/stale` | stale issue → closed | days, configured | label, then close | (in-distribution knowledge) |
| project-memory 0.12.0 | finding → card | per finding | protocol says file every leftover as a task | summary.mjs:12, done.md:17-20 |
| project-memory 0.13.0 (plan) | finding → fixed or new session | one question | fix now / new session / `later#n`; drop only on the user's yes, with dry run + undo | this plan |

Magical moment: the first `pm done` that prints `epic X: that was the last task — nothing left` and the first
session where a finding is fixed in the same diff after one question. Vehicle: existing summary and `pm done`
output (P5, lowest effort). No new channel.

Developer journey map (after this review):

| Stage | Developer does | Friction | Status |
|-------|----------------|----------|--------|
| 1. Discover | sees `[pm] update available` | none new | ok (existing) |
| 2. Evaluate | reads the changelog "what changes for you" | was missing | fixed (DX-10) |
| 3. Install | `update the plugin`, restarts every session on the board | mixed 0.12/0.13 sessions | fixed (DX-4) |
| 4. Hello world | first summary: epic line, no false Stop nag | Stop counted pulls/old deletions | fixed (DX-1) |
| 5. Integrate | agent triage, `pm remind`, `later#n` at /close | reminder ids not pasteable; per-note questions | fixed (DX-5, DX-6) |
| 6. Debug | reads a refusal or a Stop message | no next command; silent Stop branches | fixed (DX-7, DX-1) |
| 7. Upgrade | 0.12 board validates; old sessions restarted | no downgrade note | fixed (DX-4) |
| 8. Scale | `pm audit` empty list + stats line, `pm drop` 12–16 ids | ids not checkable, no preview | fixed (DX-2, DX-3) |
| 9. Migrate | cleans ATS/Wizzard after install; undo if wrong | undo not printed | fixed (DX-3, CEO-18) |

First-time developer confusion report (grounded in README/CLI; estimated timeline):
```
T+0:00  Summary shows Epic import: no open tracked tasks. OK.
T+0:30  Agent: "Fix now?" — clear. Declined → "later#1" in the Log; fine.
T+1:00  pm audit: "empty: 23 tasks … T-114, T-115, …" — which are they? (addressed: DX-2 per-task lines)
T+2:00  pm drop T-114,T-115 --why "stale" — what if I'm wrong? (addressed: DX-3 dry run + undo line)
T+3:00  Reminders: T-123#2 remove flag — pm remind --clear T-123#2 fails (addressed: DX-5)
```

#### Dual voices

Claude SUBAGENT (DX, native `model-router:analyst`, INPUT dx 68dbfa82… matches the snapshot): 14 issues, 3 high —
D1 audit ids not checkable; D2 no preview/undo for `pm drop`; D10 `/close` per-note questions; mediums D3 reminder
ids, D4 three parking places, D5 hint off switch, D6 stale §1–§7 text vs amendments, D7 refusals without a fix,
D8 `--from` message, D9 silent Stop branches, D11 protocol duplicated in 7 files, D12 no worked examples, D13 no
escape for another worktree's in_progress, D14 hard-coded thresholds; plus mixed 0.12/0.13 reading of `remind:`
and a silent behavior change at upgrade.

Codex SAYS (DX, `OUTSIDE_STATUS: completed provider=codex`, score 6/10): 7 concerns, 3 high — (1) `pm drop` undo
promise vs `commitPm` (`store.mjs:25` stages the whole board, returns false on failure); (2) mixed-version
compatibility checks syntax not behavior; (3) Stop still false: a fast-forward pull brings non-merge commits with
recent author time, and `dirtyFilesSince` counts every deleted file (`hooks.mjs:41`); mediums (4) `later:` notes
lack identity and a no-task fallback; (5) product TTHW unproven, README Quick start (`:71`) contradicts the phrase
table (`:113`) on "what's next?"; (6) focused help/examples, `T-123#2` not accepted as input; (7) `empty` message
vs predicate. Recommendation: revise before release and stage delivery.

Verified against code: `commitPm` runs `git add -A` and returns false after two failed attempts (`store.mjs:25-35`);
`dirtyFilesSince` pushes deleted paths unconditionally (`hooks.mjs:40-42`); `gitlink.mjs:8` already filters reflog
entries to commits created in this worktree (`TAKEN`, `reflogSince`); `--help` prints the global usage
(`pm.mjs:523`); README `:71` vs `:113` contradict; 0.12.0 code does not parse Checklist, but `commands/done.md:13`
("checklist is closed") makes a 0.12.0 agent treat `- [ ] remind:` as unfinished; audit findings are one line per
task id (`audit.mjs:36-83`) with fixed `DAYS` constants (`audit.mjs:11`).

```
DX DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Getting started < 5 min?          yes     unproven  DISAGREE (product-wide onboarding; plan path 0 steps)
  2. API/CLI naming guessable?         gaps    gaps   CONFIRMED (reminder ids, help, --from vs --deps)
  3. Error messages actionable?        gaps    gaps   CONFIRMED (no next command; silent commit failure)
  4. Docs findable & complete?         gaps    gaps   CONFIRMED (examples, decision table)
  5. Upgrade path safe?                gaps    gaps   CONFIRMED (mixed 0.12/0.13 sessions)
  6. Dev environment friction-free?    gaps    gaps   CONFIRMED (Stop accuracy and diagnostics)
CONFIRMED = native + outside agree. 5/6 confirmed, 1 disagreement → gate (T9).
Single-voice high findings: Codex (1) commit/undo and (3) Stop false positives — both verified in code above.
```

#### Decision ledger (auto-decided, 6 principles)

| # | Finding (source) | Current | Decision | Principle |
|---|------------------|---------|----------|-----------|
| DX-1 | Stop counts pulled commits and old deletions (Codex 3, verified); silent branches (native D9) | `<head>..HEAD` author time (CEO-17); deletions always count | session commits from the reflog (`TAKEN`), deletions only if not dirty at session start, message names counts, `PM_DEBUG` prints inputs | P1, P4 reuse |
| DX-2 | `empty` ids not checkable (native D1); message vs predicate (Codex 7) | one line `T-114, T-115, …`; age = created else updated | per-task lines like other findings + one pasteable id line; all four sections empty; created and updated both 14+ days | P1, P5 |
| DX-3 | no preview/undo (native D2); commit stages whole board, fails silently (Codex 1, verified) | revert "the board commit" | `--dry-run`; stage only dropped files; print sha + `undo:` line; report commit failure with manual restore | P1 |
| DX-4 | mixed 0.12/0.13 sessions (both) | validate-only test (CEO-19) | release note: update + restart all sessions on the board first; downgrade note | P1, P5 |
| DX-5 | `T-123#2` not pasteable (both) | `pm remind T --clear n` only | accept `pm remind --clear T-123#2`; summary shows the clear command | P5 consistency |
| DX-6 | `/close` asks per note (native D10); no identity/no-task fallback (Codex 4) | `later:` lines, one question per line | `later#n` numbered per task, resolution line references n, one batched question, no task → final report only | P5, anti-goal |
| DX-7 | refusals without next command (native D7, D8, D13) | message text unspecified | one template `what — why — next command`, exit 1; documented escape instead of `--force` | P1, P5 |
| DX-8 | three parking places; help (native D4, Codex 6) | spread over §1/§2/CEO-13 | one decision table in SKILL.md + README; `pm help` usage with one example each; `--from` is not a dependency | P5 |
| DX-9 | protocol text in 7 places (native D11) | edits per file | canonical row in SKILL.md, short pointers elsewhere, grep test for old phrases | P1 |
| DX-10 | examples, rollout, README contradiction (native D12, Codex 5) | "mentions the triage once" | worked cleanup + reminder examples; rollout order and upgrade note in README; fix README:71 | P1 |
| DX-11 | §1–§7 text stale vs amendments (native D6) | amendments appended | accepted bullets supersede §1–§7; builder folds them in before coding | P5 |
| DX-12 | hint has no off switch (native D5) | quiet with `--from`/`--deps` | no new flag; hint ends "skip if the user asked for this task" | TASTE T8 (P5 vs flexibility) |
| DX-13 | configurable thresholds, Stop off switch (native D14) | fixed `DAYS` | deferred, NOT in scope | P3 |
| DX-14 | silent behavior change at upgrade (native) | none | changelog "what changes for you" (DX-10); one-time summary line deferred | P5 |
| DX-15 | product TTHW walkthrough (Codex 5) | README Quick start | out of plan scope; TASTE T9 at the gate (recommend defer) | P3 |
| DX-16 | unexpected-failure path lacks context/trace (agent-ready-v1, Pass 3) | `pm: <message>`, no stack | drop commit failure prints the git error's first line and the side effect; `PM_DEBUG` prints `e.stack` in `main().catch` | P1, P4 reuse |

#### Passes 1–8 (rating before → after the accepted changes)

1. Getting started 7 → 8. The new behavior needs no step; the cleanup path is audit → dry run → drop. Gap to 10:
   a measured cleanup on a real board (rollout, CEO-18).
2. API/CLI 5 → 8. Pasteable reminder ids, `--dry-run`, consistent audit line format, `--from` vs `--deps` stated.
   Gap: per-command help (deferred).
3. Errors 4 → 7. Template `what — why — next command`, exit 1, commit failure reported, Stop message states what it
   saw, `PM_DEBUG`. Gap: no stable error codes (the CLI has none today; out of scope).
4. Docs 5 → 8. Decision table, worked examples, rollout and upgrade notes, README:71 fixed.
5. Upgrade 4 → 7. Release note with restart-all and downgrade notes; 0.12 board validates. Gap: no behavioral
   cross-version test (an old agent protocol cannot be run in CI).
6. Dev environment 5 → 8. Stop counts only this worktree's commits and session deletions; deterministic tests with
   fixed dates. Gap: no Stop off switch (deferred).
7. Community 5 → 5. No change in scope (MIT, GitHub, README in two languages). No issues to fix in this plan.
8. DX measurement 6 → 7. `pm audit` stats line (CEO-14) measures created/dropped/empty; Stop debug line. Gap:
   no TTHW timer (not needed for a CLI used daily).

Pass 2 agent ergonomics (observational): non-interactive by default — yes, no new prompt; structured output — no
(`pm` prints text lines, no `--json`; unchanged); layered `--help` — no (global usage only, `pm.mjs:523`; deferred).

Pass 3 error path matrix (agent-ready-v1; channel = stderr + exit 1 through `UsageError`/`main().catch`,
`pm.mjs:79-80,533-536`; the CLI has no error codes today):
```
ERROR PATH MATRIX (agent-ready-v1)
Path                          | Class      | what | fix  | recovery | code | context | trace | redaction | channel | Cap
pm drop: other worktree busy  | validation | pass | pass | N/A      | gap  | N/A     | N/A   | pass      | pass    | —
pm remind --clear out of range| usage      | pass | pass | N/A      | gap  | N/A     | N/A   | pass      | pass    | —
pm task new --from unknown id | validation | pass | pass | N/A      | gap  | N/A     | N/A   | pass      | pass    | —
pm drop: board commit fails   | unexpected | pass | pass | pass     | gap  | pass*   | pass* | pass      | pass    | —
```
Before DX-7/DX-16 the three usage paths had no fix text (CAP6:fix) and the commit failure printed nothing
(`commitPm` returns false, CAP6:recovery/context/trace). `*` = after DX-16: the failure line carries the first
line of the git error and its side effect (files written, not committed), and `PM_DEBUG` prints the stack from
`main().catch`. Missing stable codes are a gap, not a cap; they stay deferred (no codes anywhere in the CLI).

Claude Code skill checklist: AskUserQuestion design — triage asks one batched question (ok); state storage —
board files + session state (ok); progressive consent — every drop needs the user's yes (ok); auto-upgrade —
existing update notice (ok); error recovery — drop commit failure now reported (fixed); agent-readable errors —
template with next command (fixed, no codes); session continuity — `later#n` survives sessions (fixed); bounded
autonomy — no auto-drop, no auto-fix without a question (ok).

```
+====================================================================+
|              DX PLAN REVIEW — SCORECARD                            |
+====================================================================+
| Dimension            | Score  | Prior  | Trend  |
| Getting Started      |  8/10  |  7/10  |  ↑     |
| API/CLI/SDK          |  8/10  |  5/10  |  ↑     |
| Error Messages       |  7/10  |  4/10  |  ↑     |
| Documentation        |  8/10  |  5/10  |  ↑     |
| Upgrade Path         |  7/10  |  4/10  |  ↑     |
| Dev Environment      |  8/10  |  5/10  |  ↑     |
| Community            |  5/10  |  5/10  |  =     |
| DX Measurement       |  7/10  |  6/10  |  ↑     |
| TTHW (cleanup)       | ~5 min (target) | ~30 min (est.) | ↑ |
| Competitive Rank     | Competitive (estimated)                     |
| Magical Moment       | designed via existing summary / pm done     |
| Product Type         | Claude Code plugin + CLI                    |
| Mode                 | POLISH                                      |
| Overall DX           |  7/10  |  5/10  |  ↑     |
+====================================================================+
| Zero Friction: covered · Learn by Doing: covered (examples) ·      |
| Fight Uncertainty: covered · Opinionated + Escape Hatches: covered |
| (escape in messages, no --force) · Code in Context: covered ·      |
| Magical Moments: covered · Agents Are Users: partial (next-command |
| errors, no prompts; no --json, no layered --help, no codes: deferred)|
+====================================================================+
```
Community 5/10 is below 6 but out of this plan's scope; no adoption impact for a single-user plugin release.

```
DX IMPLEMENTATION CHECKLIST
[ ] New behavior visible in the first session after update + restart, no extra step
[ ] Board cleanup audit → dry run → drop in < 5 min on a 60-task board
[ ] Every new error/refusal meets agent-ready-v1: what — why — next command, exit 1 (codes deferred)
[ ] Stop message states what it saw; PM_DEBUG prints the decision inputs
[ ] pm remind --clear accepts T-123#n as printed
[ ] pm drop --dry-run writes nothing; success prints the sha and the undo command
[ ] SKILL.md + README decision table: wait / remind / later#n
[ ] README worked examples (cleanup, reminder), rollout order, upgrade + downgrade notes
[ ] README Quick start "what's next?" matches the phrase table
[ ] grep test: no shipped file says "file leftovers" / "every leftover becomes"
[ ] Changelog lines in README.md and README.ru.md
```

NOT in scope (DX): per-command `--help`; configurable audit thresholds and a Stop off switch (DX-13); one-time
upgrade line in the summary (DX-14); product-wide timed onboarding walkthrough (DX-15, T9); stable error codes;
`--force` for `pm drop`.

What already exists: `undoLines` (`undo.mjs:81`) for the undo line shape; `reflogSince` + `TAKEN`
(`gitlink.mjs:8`) for session commits; `PM_DEBUG` (`hooks.mjs:93`); audit per-task finding format and `DAYS`
(`audit.mjs:11-83`); `UsageError`/`fail` exit path (`pm.mjs:80`); the update notice (README Install).

TODOS.md: none (repo has no TODOS.md; deferred items live in NOT in scope).

#### Implementation Tasks (DX)

- [ ] **D1 (P1, human: ~3h / CC: ~20min)** — hooks — Stop counts session commits from the reflog and session deletions only
  - Surfaced by: Codex 3, native D9 — `hooks.mjs:40-42`, `gitlink.mjs:8`
  - Files: scripts/lib/hooks.mjs, scripts/lib/gitlink.mjs, test/hooks.test.mjs
  - Verify: node --test test/hooks.test.mjs (pull, old deletion, own commit, reftable cases)
- [ ] **D2 (P1, human: ~2h / CC: ~15min)** — pm drop — dry run, staged paths, sha + undo line, commit failure
  - Surfaced by: native D2, Codex 1 — `store.mjs:25-35`
  - Files: scripts/pm.mjs, scripts/lib/store.mjs, test/tasks.test.mjs
  - Verify: node --test (dry run writes nothing; unrelated dirty file not in commit; failure message)
- [ ] **D3 (P1, human: ~1h / CC: ~10min)** — audit — `empty` per-task lines + id line, four empty sections, both ages
  - Surfaced by: native D1, Codex 7 — `audit.mjs:36-83`
  - Files: scripts/lib/audit.mjs, test/audit.test.mjs
  - Verify: node --test test/audit.test.mjs
- [ ] **D4 (P2, human: ~1h / CC: ~10min)** — later notes — `later#n`, resolution lines, one batched /close question
  - Surfaced by: native D10, Codex 4
  - Files: commands/close.md, skills/pm/SKILL.md, test (wording)
  - Verify: wording tests
- [ ] **D5 (P2, human: ~1h / CC: ~10min)** — remind/errors — `--clear T-123#n`, error template with next command
  - Surfaced by: native D3, D7, D8, D13; Codex 6
  - Files: scripts/pm.mjs, scripts/lib/tasks.mjs, tests
  - Verify: node --test (each error asserts its next command)
- [ ] **D6 (P2, human: ~2h / CC: ~15min)** — docs — decision table, examples, rollout/upgrade notes, README:71, grep test
  - Surfaced by: native D4, D11, D12; Codex 2, 5, 6
  - Files: skills/pm/SKILL.md, README.md, README.ru.md, commands/*.md, scripts/pm.mjs (usage), test
  - Verify: node --test; read README sections
- [ ] **D7 (P2, human: ~1h / CC: ~10min)** — spec — fold accepted bullets into §1–§7 before coding
  - Surfaced by: native D6
  - Files: docs/superpowers/specs/2026-10-28-no-junk-tasks-epic-progress-design.md
  - Verify: no §1–§7 line contradicts an accepted bullet

<!-- autoplan-accepted:dx -->
- Precedence (DX-11): where an accepted bullet (CEO or DX) contradicts §1–§7, the accepted bullet wins; the builder
  folds them into §1–§7 before coding, and wording tests use the accepted text.
- Stop (DX-1, supersedes the commit rule of CEO-17): a session commit is a reflog entry of this worktree whose
  subject matches `TAKEN` (`gitlink.mjs:8`: commit, amend, cherry-pick, revert; pulls, merges, rebases, resets
  skipped), read with `reflogSince`, whose time is newer than `max(start, updated)`. SessionStart also stores the
  set of dirty paths in `session-<id>` (`onSafetyNote` refreshes it with `start`/`head`); a deleted path counts only
  when it was not dirty at that point. No reflog file (reftable) → commits count as none, dirty files only. The
  block message states what it saw, e.g. `[pm] This session made 2 commits and changed 3 files; the board was not
  updated for 20+ minutes. Log progress on this worktree's task (pm log), or reply that there is nothing to
  track.` With `PM_DEBUG` set, Stop prints its inputs and decision to stderr. Tests: a fast-forward pull of a fresh
  commit → no block; a file deleted before the session → no block; a file deleted during the session → block; an
  own commit after the board update → block; no reflog → dirty files only.
- `empty` audit (DX-2, supersedes §5's one-line format and the age rule of CEO-12): candidate = open `todo` whose
  Goal, Understanding, Checklist and Log are all empty, no open reminder, `updated` 14+ days old and, when present,
  `created` 14+ days old. Output follows the existing per-task finding format: one line per task with id, title,
  `created`/`updated` dates and `ask the user; pm drop`, then one line `empty ids: T-114,T-115,…` that pastes into
  `pm drop`. `DAYS.empty = 14` joins `DAYS` (`audit.mjs:11`). Tests: per-task lines; id line; a task with a
  non-empty Understanding or Checklist is not `empty`; recent `updated` with old `created` is not `empty`.
- `pm drop` (DX-3): `--dry-run` prints what would drop, every refusal and the reminders it would discard, and writes
  nothing. The commit stages only the dropped task files (`commitPm` takes an optional path list). On success it
  prints the commit sha and `undo: git -C "<board dir>" revert --no-edit <sha>`; if the commit fails it says so and
  prints `pm set <id> status=<previous>` per id. Tests: dry run writes nothing; an unrelated dirty board file is
  not in the drop commit; the undo line; a failed commit (held `index.lock`) prints the manual restore.
- Unexpected failures (DX-16): the drop commit failure line also carries the first line of the git error and says
  the side effect (task files written, not committed); `main().catch` (`pm.mjs:533`) prints `e.stack` when
  `PM_DEBUG` is set. Test: the failure line contains the git error text.
- Upgrade (DX-4): the README changelog and the Install/Update section say: update and restart every session that
  uses the board before using `pm remind` (a 0.12.0 session reads an open `remind:` line as an unfinished checklist
  item); after a downgrade `remind:` lines stay as plain checklist text and `created`/`from` are ignored.
- Reminder ids (DX-5): `pm remind --clear T-123#2` is accepted alongside `pm remind T-123 --clear 2`; the summary's
  `Reminders:` line ends with `clear: pm remind --clear <id#n>`. Test: clearing by the printed id.
- Declined findings (DX-6, amends CEO-13): each declined finding is one Log line `- <date> · <worktree> ·
  later#<n>: <text>` on the current task, `n` counting that task's `later#` lines. A resolution appends
  `later#<n> kept`, `later#<n> → T-NNN` or `later#<n> dismissed`. `/close` step 1 asks one batched question over the
  unresolved `later#n` lines of the tasks this session touched: keep all (default) / pick numbers to turn into tasks
  / dismiss all. With no current task the finding is only named in the final report. Tests: wording of the triage
  branches and of `/close` step 1.
- Errors (DX-7): every new refusal or error is one line `what — why — next command`, exit 1 through `fail`
  (`pm.mjs:80`). Required texts: unknown id → `T-999 not found — pm ready --all lists tasks`; another worktree's
  in_progress → `T-77 is in progress in worktree X (last log <date>) — finish it there, or pm set T-77 status=todo,
  then drop` (no `--force`); `--from T-999` → `--from T-999: no such task — nothing created`; `pm remind` errors name
  the valid numbers or the reason. Tests assert the next-command part of each.
- Docs (DX-8, DX-9, DX-10): SKILL.md holds the canonical triage row; summary RULES, done.md, close.md and retro use a
  short form that points to it. One decision table in SKILL.md and both READMEs: wait inside this task → `waiting`/
  `review`; reminder that outlives the task → `pm remind`; declined finding → `later#n`. `pm help` gets usage lines
  with one example each for `pm remind`, `pm drop`, `pm task new --from`, and says `--from` records origin, not a
  dependency (`--deps`). README gets a worked cleanup example (audit → dry run → drop → undo) and a reminder example
  (add → summary line → clear), the rollout order (CEO-18), and README:71 is corrected: "what's next?" offers the
  options (`pm next --options`), "take the next one" claims. Test: no shipped file contains "file leftovers" or
  "every leftover becomes".
- `pm task new` hint (DX-12, TASTE T8, provisional): no new flag; the hint line ends with "skip this if the user asked
  for the task". CEO-16 otherwise unchanged.
- Deferred, NOT in scope (DX-13, DX-14, DX-15): per-command `--help`, configurable audit thresholds, a Stop off
  switch, a one-time upgrade line in the summary, a product-wide timed onboarding walkthrough, stable error codes,
  `pm drop --force`.
<!-- /autoplan-accepted:dx -->

### Phase 3 — Eng review (FULL_REVIEW, autoplan override: never reduce scope)

Methodology `autoplan-eng-methodology-dQLHt3/methodology.md` read 1–2165/2165 (chunks 1–301, 302–755, 756–1199,
1200–1581, 1582–1988, 1989–2165). Checkpoint `autoplan-eng-583vze/eng-implementation.md` (sha c1520426…). Phase
files read through Bash per D2 = A; the updated guard (gstack 1.91.307.0) now rejects this session's journal
("identity checks"), so the guard does not track this phase either.

#### Step 0 — Scope challenge

- What exists per sub-problem: summary RULES (`summary.mjs:10-13`), protocol texts (`skills/pm/SKILL.md`,
  `commands/done.md`, `commands/close.md`, `skills/retro/SKILL.md`), Stop (`hooks.mjs:133-153`), session state and
  safety note (`hooks.mjs:107,155-179`), reflog capture (`gitlink.mjs:8,36-90`), auto-write tracking
  (`store.mjs:152-166`), board commit (`store.mjs:25-35`), locks (`store.mjs:73`), status transitions
  (`tasks.mjs:140-160`), validate (`tasks.mjs:265-280`), audit (`audit.mjs:10-114`), undo block (`undo.mjs:81`).
- Complexity: ~13 changed source/doc files + ~8 test files, 1 new module (`scripts/lib/reminders.mjs`, ENG-9)
  [estimated]. The gate trips (8+ files). Structure question `plan-eng-review-structure` auto-decided (autoplan,
  P2 never reduce): Original arrangement — no smaller arrangement keeps the accepted feature list; release staging
  stays the CEO User Challenge UC1 for the final gate. Result: scope accepted as-is.
- Search: no new infrastructure pattern; the lock, reflog and autoWrite patterns already exist in the repo
  [Layer 1].
- TODOS: the repo has no TODOS.md and CEO's accepted bullet says none is created (binding decision); deferred items
  live in NOT in scope below. This overrides the autoplan default "auto-write TODOS.md".
- Distribution: no new artifact; version bump 0.13.0 in `.claude-plugin/plugin.json` + `marketplace.json` (§7).

Reality rows:
```
premise                                         | receipt                         | verdict
RULES says "file leftovers as tasks"            | summary.mjs:12                  | true
done.md files every leftover as a task          | commands/done.md:17-20          | true
Stop compares HEAD time with board update       | hooks.mjs:61-64,147             | true
reflog entries carry no time in the parser      | gitlink.mjs:36-58               | true
capture cursor advanced before Stop decides     | hooks.mjs:137, gitlink.mjs:75   | true
safety-note auto line is not an autoWrite       | hooks.mjs:171 (appendLogLine)   | true (bug)
commitPm stages the whole board                 | store.mjs:27 (git add -A)       | true
validate flags any task depending on dropped    | tasks.mjs:272-273               | true
leaving waiting clears waiting_on               | tasks.mjs:151                   | true
manual Log line = " · did: " only               | tasks.mjs:234                   | true
summary cut drops lines from the end            | summary.mjs:87-91               | true
ATS board 296 tasks, 44 dropped                 | ATS pm/tasks, re-counted 10-29  | true
ATS 65 open / 48 empty Log / 27 stale (10-28)   | re-counted 10-29: 63 / 45 / 32  | drifted (board moved)
82% of open are reminders/findings/leftovers    | manual classification 10-28     | unverified (manual)
REALITY: premise-table finding 13 premises, 1 drifted, unverified=1 summary.mjs:12
REALITY: already-done pass no commit on origin/master since 2026-10-28 touches the named files (git log) scripts/lib/hooks.mjs:133
REALITY: surface-check pass every existing command/flag named in the plan is in pm help; remind/drop/--from/--dry-run are proposed scripts/pm.mjs:3
REALITY: binding-decisions pass no branch decisions logged; CEO/DX accepted blocks honored (no TODOS.md) docs/superpowers/specs/2026-10-28-no-junk-tasks-epic-progress-design.md:238
REALITY: numbers finding board counts re-measured, drifted from the earlier snapshot docs/superpowers/specs/2026-10-28-no-junk-tasks-epic-progress-design.md:1187; category split is a manual estimate docs/superpowers/specs/2026-10-28-no-junk-tasks-epic-progress-design.md:1188; effort numbers are estimates docs/superpowers/specs/2026-10-28-no-junk-tasks-epic-progress-design.md:1382
REALITY: deferred-asks pass no linked issue; the user's four asks (epic count, no junk, ask first, separate session) all map to §1/§4 docs/superpowers/specs/2026-10-28-no-junk-tasks-epic-progress-design.md:6
REALITY: pr-count pass one PR per wave (no ship-policy); UC1 staging would make two PRs, cost one extra review/CI cycle .claude-plugin/plugin.json:1
```

#### Dual voices

Claude SUBAGENT (eng, native `model-router:analyst`, INPUT eng c1520426… matches the snapshot): 13 findings — high:
(1) `reflogSince` is byte-offset based, drops the time, and its cursor is consumed by `captureCommits`;
(2) the dirty-path snapshot grows state and session files are never pruned; (3) `pm drop` writes then commits
non-atomically, `commitPm` stages everything, `pm set` restore is unsafe; (4) safety-note writes vs Stop window
need a rule and test. Medium: (5) one `isReminderLine` for every checklist consumer; (6) reminder numbers vs hand
edits; (7) `reminder-task` noise in the SessionStart audit count; (8) cap drop order, long `Reminders:` entries;
(9) reconcile epic lines after the batch; (10) one shared word list. Low: (11) fold the spec; (12) Windows lock
tests; (13) min_version later. Security: sanitize remind/why text, cap length, PM_DEBUG prints paths only.

Codex SAYS (eng, `OUTSIDE_STATUS: completed provider=codex`, gpt-6-astra, VERDICT findings P1): 9 findings — high:
(1) the claim lock does not serialize drop against `pm set`/`pm log`/Stop `persist`; (2) a path list does not
isolate the drop commit from pre-staged or pre-edited files; (3) `validate` flags dependents of dropped tasks
whatever their status, so a permitted batch fails validation; (4) printed `pm set` recovery cannot restore
`waiting_on`, `next`, `review_at`. Medium: (5) dropping an active task skips commit capture; (6) the dirty-set
deletion rule still misfires (delete → log → Stop; dirty-before-start → deleted); (7) `reflogSince` lacks time,
cursor consumed; (8) `Reminders:` can be cut by the 40-line cap; (9) the metric's "manual Log line" is undefined
for `later#`/`dropped:` lines. Recommendation: revise before implementation.

Verified in code: all of Codex 1–9 and native 1–4 (receipts in the premise table; native 4 is a live bug:
`onSafetyNote` writes its `auto:` line without `autoWrite`, so a safety note resets the Stop window).

```
ENG DUAL VOICES — CONSENSUS TABLE:
  Dimension                           Claude  Codex  Consensus
  1. Architecture sound?               changes changes CONFIRMED (drop transaction, Stop internals undefined)
  2. Test coverage sufficient?         gaps    gaps   CONFIRMED (failure/recovery, reflog, cap, reconcile)
  3. Perf risks + budget/bench named?  risk    —      Claude only (state size; removed by ENG-2)
  4. Security threats covered?         gaps    —      Claude only (text sanitizing; ENG-12)
  5. Error paths handled?              gaps    gaps   CONFIRMED (drop failure recovery)
  6. Deployment risk manageable?       gaps    —      Claude only (Windows lock tests, mixed versions)
CONFIRMED = native + outside agree. 3/6 confirmed, 0 disagreements. Single-voice high findings: Codex 3
(validate) — verified in code; native 4 (safety note) — verified in code.
```

#### Decision ledger (auto-decided)

| # | Finding | Decision | Principle |
|---|---------|----------|-----------|
| ENG-1 | reflog API (native 1, Codex 7) | parser returns time; Stop keeps its own reflog byte offset in `session-<id>`; strict `time*1000 > max(start, updated)` | P1, P5 |
| ENG-2 | deletion rule (native 2, Codex 6) | replace DX-1's dirty-path snapshot by parent-directory mtime; nothing stored | P5, P3 |
| ENG-3 | safety note resets Stop (native 4, verified bug) | `onSafetyNote` writes its line through `autoWrite` | P1 |
| ENG-4 | drop atomicity/recovery/capture (native 3, Codex 1, 2, 4, 5) | one transaction under a board `commit` lock that `commitPm` also takes; pre-commit pending edits; `git commit -- <paths>`; automatic restore on failure; capture before | P1, P5 |
| ENG-5 | validate vs dropped (Codex 3, verified) | `depends on dropped` only for open dependents | P1 |
| ENG-6 | metric definition (Codex 9) | "no manual Log line" = no ` · did: ` line | P5 |
| ENG-7 | cap (native 8, Codex 8) | Epic and Reminders lines are protected from the cut; entry text ≤ 60 chars | P1 |
| ENG-8 | reconcile batch (native 9) | epic lines after the whole batch, one per epic | P1 |
| ENG-9 | word list / reminder parsing (native 5, 10) | one module `scripts/lib/reminders.mjs` | P4 DRY |
| ENG-10 | numbers vs hand edits (native 6) | `--clear` echoes the ticked text; numbering documented | P5 |
| ENG-11 | SessionStart audit noise (native 7) | `reminder-task` excluded from `auditLine` count | P3 |
| ENG-12 | text injection (native security) | sanitize remind/why/later text, ≤ 200 chars; PM_DEBUG paths and counts only | P1 |
| ENG-13 | spec folding (native 11) | first build step, checked | P5 |
| ENG-14 | Windows tests (native 12) | lock failure via a pre-created `index.lock`; GIT_*_DATE + utimesSync | P1 |
| ENG-15 | two ways to drop (design-twice red flag 6) | `pm set … status=dropped` keeps working, prints a one-line hint to `pm drop --why` | P5 |
| ENG-16 | min_version board check (native 13) | NOT in scope | P3 |

#### Section 1 — Architecture

```
                 SessionStart ──writes──► .state/session-<id> {start, head, reflogOffset}
                      │                              ▲            ▲
   summary.mjs ◄──────┤                              │ refresh    │ read
   (epic line,        │                  onSafetyNote ┘            │
    Reminders,        │                   └─autoWrite(auto: line)  │
    protected lines)  │                                            │
        ▲             ▼                                   onStop ──┤── reflogSince(offset)+time ─ TAKEN filter
        │        tasks.mjs ── epicProgress, validate(open deps)    │── dirty files mtime / parent-dir mtime
        │           ▲   ▲                                          └── lastBoardUpdate (manualMtime)
   reminders.mjs ───┘   │
   (words, isReminderLine, parse)
        ▲               │
   pm.mjs: remind ──────┤          pm.mjs: drop ──► withLock('commit') ─┬─ sync commit of pending target edits
           task new --from (hint)                                       ├─ captureCommits (own in_progress)
           done/reconcile (epic line)                                   ├─ write files (status, Log, next)
           audit (empty, reminder-task, stats)                          ├─ git commit -- <paths>  (fail → restore)
                                                                        └─ startCapture, print sha + undo
   store.mjs: commitPm ──► withLock('commit') (shared by persist from every command and hook)
```
Coupling: `reminders.mjs` is the only owner of reminder syntax and words (avoids red flag 8, hand-synced list).
Design-twice (new module `reminders.mjs`): shape A — functions inside `tasks.mjs`; shape B — own module used by
tasks/summary/audit/pm. Pick B: one small surface (`isReminderLine`, `parseReminders`, `isReminderTitle`) hides
the syntax, numbering and two-language word list. Red flags: two ways to drop (ENG-15); split ownership of
`session-<id>` stays inside `hooks.mjs` (ok); no importable internals added. Realistic failure per new path:
Stop — reflog truncated by `gc` → commits not counted (dirty files still are); drop — `index.lock` held → restore,
nothing dropped; remind — hand-edited checklist → numbers shift, `--clear` echoes the text.

#### Section 2 — Code quality

- [INFORMATIONAL] (confidence 9/10) `scripts/lib/hooks.mjs:171` — `appendLogLine(pm, t.id, line, today())` without
  `autoWrite` makes the auto line count as manual (ENG-3).
- [INFORMATIONAL] (confidence 9/10) `scripts/lib/store.mjs:27` — `git(['add', '-A'], pm)` in `commitPm` cannot
  isolate a drop commit (ENG-4).
- [INFORMATIONAL] (confidence 9/10) `scripts/lib/tasks.mjs:273` — `else if (byId.get(d).data.status === 'dropped')`
  flags closed dependents too (ENG-5).
- Shared code: the reminder word list has two proposed callers (task-new hint, `reminder-task` audit) and the line
  syntax three (remind, summary, audit) → one module (ENG-9); capture lifecycle reuses `captureCommits`/
  `startCapture` exactly as `pm set` does (`pm.mjs:204-206`); the undo line reuses the `undoLines` shape.
Dispositions: all accepted (auto).

#### Section 3 — Test review (framework: `node --test`, `test/*.test.mjs`)

```
CODE PATHS                                              USER FLOWS
[+] hooks.mjs onStop                                     [+] Agent finishes a turn
  ├── [GAP] own commit after board update → block          ├── [GAP] pulled master, no own work → no nag
  ├── [GAP] ff pull / merge / rebase → no block            ├── [GAP] deleted a file this session → nag
  ├── [GAP] reflog truncated → dirty only                  └── [GAP] safety note then 20 min → nag only for new work
  ├── [GAP] same-second commit and board update
  ├── [GAP] deletion: parent dir mtime old / new           [+] Close a task / epic
  ├── [GAP] safety note (autoWrite) then Stop              ├── [GAP] last task → epic line + focus hint
  ├── [★★ TESTED] stop_hook_active (existing)              ├── [GAP] reconcile two tasks of one epic → one line
  └── [GAP] no session / no state file / null head         └── [GAP] review task counted as open
[+] pm drop (transaction)                                [+] Board cleanup
  ├── [GAP] each refusal + all-or-nothing                  ├── [GAP] audit → ids line → dry run → drop → undo
  ├── [GAP] dry run writes nothing                         └── [GAP] revert of drop commit restores exact files
  ├── [GAP] pending target edit pre-committed
  ├── [GAP] pre-staged unrelated file not in commit      [+] Reminders
  ├── [GAP] commit fails (index.lock) → files restored     ├── [GAP] add → summary → clear by T-123#n
  ├── [GAP] own in_progress: commits captured first        └── [GAP] hand-deleted line → --clear echoes text
  └── [GAP] validate clean after dropping dep + dependent
[+] tasks.mjs epicProgress / validate                    [+] Summary
  ├── [GAP] parts sum to open; blocked; all dropped        ├── [GAP] over 40 lines keeps Epic + Reminders
  └── [GAP] closed dependent of dropped → no problem       └── [★★ TESTED] RULES line (update text)
[+] reminders.mjs                                        [+] Protocol texts
  ├── [GAP] ru/en titles: positives and negatives          └── [GAP] grep: no "file leftovers" / "every leftover becomes"
  └── [GAP] parse numbering with ticked lines
[+] audit: empty (per-task + id line), reminder-task (not in auditLine), stats (did: definition) — [GAP] each
[+] input sanitizing remind/why/later — [GAP] newline, "- [ ]", "---", 201 chars
COVERAGE: 2/34 paths tested today (existing); all 32 gaps get a test in the plan (unit, node:test). No [→E2E]
(single-process CLI; fixtures with real git repos are the integration level). No [→EVAL] (protocol text has no
LLM eval suite in this repo; wording tests stand in).
```
Regression rule: existing behavior at risk — Stop's block/no-block contract, `pm done` outcome line, merge
auto-close, `validate` problems, summary layout, audit `--fix`. Each has an existing test file; the plan keeps
them green and adds the rows above (CRITICAL to keep: `test/hooks.test.mjs`, `test/merged.test.mjs`,
`test/summary.test.mjs`, `test/audit.test.mjs`).
Tests made obsolete: the `test/hooks.test.mjs` assertion of the old Stop message (updated, not deleted).
Test plan artifact: written to `~/.gstack/projects/ZizzX-claude-project-memory/` (see path in the Completion
Summary).

#### Section 4 — Performance

- [INFORMATIONAL] (confidence 7/10) `scripts/lib/hooks.mjs:133` — Stop runs at every turn end. New work: one
  reflog read from the session offset (bytes since session start), one `stat` per deleted path's parent dir.
  Budget: Stop stays within the current `git status` cost (+≤ 20 ms) [estimated]; check: `time node
  scripts/pm.mjs hook stop` on the ATS repo before and after (manual, in the test plan). The dirty-path snapshot
  (DX-1) is dropped, so session state stays O(1).
- `pm audit` scans all tasks once (296 on ATS) — unchanged order. `pm drop` holds the `commit` lock for one
  sync commit + one commit; other writers wait (≤ 10 s lock wait, `store.mjs:73`).

#### Failure modes registry

| Path | Realistic failure | Test | Handling | User sees | Critical gap |
|------|-------------------|------|----------|-----------|--------------|
| Stop commits | reflog gc-truncated | yes (ENG-1) | dirty-only fallback | maybe no nag | no |
| Stop deletions | file deleted before session, dir untouched | yes (ENG-2) | parent-dir mtime | no false nag | no |
| Stop window | safety note resets window | yes (ENG-3) | autoWrite | nag for new work only | no |
| pm drop commit | index.lock held | yes (ENG-4) | restore files, error line | clear error, nothing dropped | no |
| pm drop concurrency | pm log in another session | yes (lock) | commit lock | wait ≤ 10 s | no |
| validate | dropped dep + dependent | yes (ENG-5) | open-only rule | no false problem | no |
| summary cap | busy worktree | yes (ENG-7) | protected lines | epic + reminders visible | no |
| reconcile | two tasks one epic | yes (ENG-8) | batch then lines | one correct line | no |
| remind | hand-edited numbers | yes (ENG-10) | echo ticked text | sees what was cleared | no |
| text input | newline/frontmatter in text | yes (ENG-12) | sanitize | clean single line | no |
Critical gaps: 0.

NOT in scope (Eng): board `min_version` check (ENG-16); per-command `--help`, configurable thresholds, Stop off
switch, upgrade summary line, onboarding walkthrough, error codes, `pm drop --force` (DX); E4 board.html epic bar,
E5 `pm handoff` (CEO).

What already exists (reuse): `withLock` (`store.mjs:73`), `autoWrite`/`manualMtime` (`store.mjs:152-166`),
`TAKEN`/`reflogSince` (`gitlink.mjs:8,36`), `captureCommits`/`startCapture` (`gitlink.mjs:66-90`), `undoLines`
(`undo.mjs:81`), audit `add(kind,id,detail,fix)` and `DAYS` (`audit.mjs:11-83`), `state-old` audit finding +
`--fix` for stale `.state` files (`audit.mjs:72`), `fail`/`UsageError` (`pm.mjs:79-80`).

Worktree parallelization: Lane A — protocol texts and docs (`skills/`, `commands/`, README) — independent.
Lane B — Stop (`scripts/lib/hooks.mjs`, `gitlink.mjs`). Lane C — board CLI (`pm.mjs`, `tasks.mjs`, `store.mjs`,
`audit.mjs`, `summary.mjs`, `reminders.mjs`). Conflict flag: `store.mjs` (B reads autoWrite, C changes
`commitPm`) → run C's `store.mjs` change first. Order: fold spec (ENG-13) → launch A + B + C → merge → release.
For one developer: sequential A → C → B is fine.

#### Implementation Tasks (Eng)

- [ ] **E1 (P1, human: ~4h / CC: ~25min)** — hooks — Stop: reflog offset + time, parent-dir deletions, autoWrite note
  - Surfaced by: ENG-1/2/3 — `gitlink.mjs:36-58`, `hooks.mjs:38,171`
  - Files: scripts/lib/hooks.mjs, scripts/lib/gitlink.mjs, test/hooks.test.mjs
  - Verify: node --test test/hooks.test.mjs
- [ ] **E2 (P1, human: ~4h / CC: ~25min)** — pm drop — transaction under the commit lock with restore and capture
  - Surfaced by: ENG-4 — `store.mjs:25-35`, `pm.mjs:204-206`, `tasks.mjs:151`
  - Files: scripts/pm.mjs, scripts/lib/store.mjs, scripts/lib/tasks.mjs, test/tasks.test.mjs
  - Verify: node --test (failure restore byte-identical; revert restores exact pre-drop files)
- [ ] **E3 (P1, human: ~30min / CC: ~5min)** — validate — dropped dependency only for open dependents
  - Surfaced by: ENG-5 — `tasks.mjs:273`
  - Files: scripts/lib/tasks.mjs, test/tasks.test.mjs
  - Verify: node --test test/tasks.test.mjs
- [ ] **E4 (P2, human: ~2h / CC: ~15min)** — reminders — `scripts/lib/reminders.mjs` (words, parse, isReminderLine) + sanitizing
  - Surfaced by: ENG-9/10/12
  - Files: scripts/lib/reminders.mjs, scripts/pm.mjs, scripts/lib/audit.mjs, scripts/lib/summary.mjs, test/reminders.test.mjs
  - Verify: node --test
- [ ] **E5 (P2, human: ~1h / CC: ~10min)** — summary/reconcile/audit — protected lines, batch epic lines, auditLine, metric
  - Surfaced by: ENG-6/7/8/11
  - Files: scripts/lib/summary.mjs, scripts/lib/merged.mjs, scripts/lib/audit.mjs, tests
  - Verify: node --test
- [ ] **E6 (P2, human: ~30min / CC: ~5min)** — tests — Windows-safe lock failure, fixed dates
  - Surfaced by: ENG-14
  - Files: test/*.test.mjs
  - Verify: CI matrix ubuntu/macos/windows × node 20/22

<!-- autoplan-accepted:eng -->
- Stop internals (ENG-1, refines DX-1): the reflog entry parser also returns the entry time (seconds, from the
  `<name> <email> <time> <tz>` part). SessionStart stores `reflogOffset` (current size of `logs/HEAD`) in
  `session-<id>`; `onSafetyNote` refreshes it with `start`/`head`. Stop reads from that offset on its own (the
  capture cursor is never used) and counts `TAKEN` entries with `time*1000 > max(start, updated)`; an entry in the
  same second as the board update does not count. A reflog shorter than the offset (gc, recreated worktree) →
  commits count as none. Tests: same-second boundary; truncated reflog; `captureCommits` advancing its cursor
  before the decision does not hide a session commit.
- Stop deletions (ENG-2, supersedes DX-1's dirty-path snapshot): no path set is stored. A deleted path counts when
  the mtime of its nearest existing ancestor directory is newer than `max(start, updated)`. Tests: deleted before
  the session → no block; deleted after the board update → block; deleted, then a board update, then Stop → no
  block; modified before the session and deleted during it → block.
- Safety note (ENG-3, bug fix): `onSafetyNote` appends its `auto:` line through `autoWrite`, so it never counts as a
  manual board update. Test: a safety note, then 20+ minutes with no new work → no block; with a new own commit →
  block.
- `pm drop` transaction (ENG-4, supersedes DX-3's staging and recovery and DX-16's "written, not committed" side
  effect): inside `withLock(pm, 'claim')` (CEO-19) it takes `withLock(pm, 'commit')`, which `commitPm` also takes
  (lock order is always claim → commit, as `takeNext` → `persist`; drop calls an inner commit that does not
  re-lock), in order: refusal checks (CEO-11) →
  commit pending edits of the target files as `pm: sync before drop` (failure → stop, nothing written) →
  `captureCommits` for this worktree's in_progress targets → write the files → `git commit -m "pm: drop …" --
  <paths>` → on failure restore every target file to its pre-drop bytes from memory and print the git error's
  first line and "nothing was dropped" (DX-16's failure line, corrected) → `startCapture` → print the sha and the
  undo line. `--dry-run` stops after the
  refusal checks. Tests: a pre-staged unrelated file is not in the drop commit; a pending target edit lands in the
  sync commit; reverting the drop commit restores the exact pre-drop files; a held `index.lock` leaves the files
  byte-identical; a commit made just before dropping this worktree's in_progress task is linked to it; a
  concurrent `pm log` waits for the lock.
- Validate (ENG-5): `depends on dropped` is reported only when the dependent itself is open (`isOpen`). Tests: drop
  a dependency together with its dependent → validate clean; a done task whose dependency is dropped later → no
  problem; an open dependent → still reported.
- Metric (ENG-6, defines CEO-14): "dropped without a manual Log line" = a dropped task whose Log has no ` · did: `
  line; `later#`, `remind`, `auto:`, `retro:` and `dropped:` lines do not count. Test on a fixture board.
- Summary cap (ENG-7): the header, the `Epic X:` line and the `Reminders:` line are never cut; the cut removes other
  lines from the end as today; each `Reminders:` entry text is cut to 60 characters with `…`. Test: a 50-line
  summary keeps both lines.
- Reconcile (ENG-8): epic lines are computed once after the whole batch, one per epic. Test: two tasks of one epic
  closed in one reconcile → one line, correct count.
- Reminders module (ENG-9): `scripts/lib/reminders.mjs` owns the reminder line syntax (`isReminderLine`,
  `parseReminders` with stable numbering), and the Russian + English title word list (`isReminderTitle`) used by
  the `pm task new` hint and the `reminder-task` audit. Tests: real ATS titles (flag/release/wait wording) as
  positives, ordinary titles ("ask for X" in another sense) as negatives, both languages.
- `pm remind --clear` (ENG-10) prints the text of each line it ticked; help and README say numbers are positions
  among the task's `remind:` lines. Test: a hand-deleted ticked line shifts later numbers and the echo shows the
  actual text.
- Audit count (ENG-11): the SessionStart `auditLine` count excludes `reminder-task`; `pm audit` still lists it.
- Input (ENG-12): `pm remind` text, `--why` and `later#n` text become one line (newlines → spaces), lose a leading
  `- [ ]`, `- [x]`, `---` or `#`, and are cut to 200 characters; empty after cleanup → error. `PM_DEBUG` output of
  Stop has paths and counts only. Tests: each sanitizing case.
- Build order (ENG-13): step 1 folds the CEO/DX/Eng accepted bullets into §1–§7 (done when no §1–§7 line
  contradicts an accepted bullet); `pm set <id> status=dropped` keeps working and prints a one-line hint to use
  `pm drop <id> --why` (ENG-15).
- Tests (ENG-14): lock failure uses a pre-created `index.lock` file (same on every OS); dates come from
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` and `fs.utimesSync`, never sleeps. Performance check (manual, test plan):
  `time node scripts/pm.mjs hook stop` on a large repo before/after stays within +20 ms.
<!-- /autoplan-accepted:eng -->

Eng completion summary:
- Step 0: Scope Challenge — scope accepted as-is (structure auto-decided: original arrangement; staging = UC1)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=1 verdict=complete`), 1 unverified premise (manual category split)
- Architecture Review: 4 issues found (ENG-1, ENG-2, ENG-4, ENG-15)
- Code Quality Review: 3 issues found (ENG-3, ENG-5, ENG-9)
- Test Review: diagram produced, 32 gaps identified (all get tests)
- Performance Review: 1 issue found (Stop budget, manual check)
- NOT in scope: written · What already exists: written
- TODOS.md updates: 0 (binding CEO decision: no TODOS.md; deferred items under NOT in scope)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review (UC1 and taste T1–T9 belong to the final gate)
- Outside voice: codex completed (9 findings, P1)
- Parallelization: 3 lanes, 2 parallel (A, B) / C sequenced after its `store.mjs` change
- Lake Score: N/A (no completeness-scored answers in this phase)
- Test plan: `~/.gstack/projects/ZizzX-claude-project-memory/a.isapov-ZizzX-feat-epic-remaining-tasks-eng-review-test-plan-20261029-105540.md`

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| CEO-1 | CEO | mode SELECTIVE EXPANSION | mechanical | override | autoplan rule | other modes |
| CEO-2 | CEO | reminders as `- [ ] remind:` Checklist lines | taste T1 | P4/P5 | no new parser, visible on board.html | frontmatter list, `## Reminders` |
| CEO-3 | CEO | E1 `pm task new` hint | auto | P2 | in blast radius | none |
| CEO-4 | CEO | E6 epic-finished prompt | auto | P2 | in blast radius | separate line |
| CEO-5 | CEO | E2, E3 skipped | auto | P4 | duplicates | — |
| CEO-6 | CEO | E4, E5, E7 deferred (E7 later promoted) | auto | P3 | outside radius | build now |
| CEO-7 | CEO | §0 context for reviewers | mechanical | P5 | reviewers see only Implementation | — |
| CEO-8 | CEO | keep `reminder-task` audit heuristic | taste T2 | P1 vs P5 | list only, never acts | drop heuristic |
| CEO-9 | CEO | reminders never hold a task open | taste T3 | P5, P3 | merge auto-close/reconcile would misfire | done → review while open |
| CEO-10..12 | CEO | spec review 1–3 fixes | mechanical | P1/P5 | reviewer findings | — |
| CEO-13 | CEO | declined findings kept (`later:`) | taste T4 | P1 | both voices: findings lost | final report only |
| CEO-14 | CEO | `pm audit` stats line metric | auto | P1 | both voices: no measure | none |
| CEO-15 | CEO | "no open tracked tasks" wording | auto | P5 | "finished" claims an outcome | "direction finished" |
| CEO-16 | CEO | hint quiet only with --from/--deps | auto | P1 | `--epic` was a bypass | quiet with --epic |
| CEO-17 | CEO | Stop by author time (superseded by DX-1/ENG-1) | taste T5 | P5 | simpler than email filter | email filter |
| CEO-18 | CEO | clean boards after install | auto | P6 | rollout order | — |
| CEO-19 | CEO | lock, dedupe, --from validation, date-fixed tests | mechanical | P1 | review sections | — |
| DX-1 | DX | Stop: session commits via reflog, diagnostics | auto | P1, P4 | pulls counted (Codex, verified) | author-time rule |
| DX-2 | DX | `empty` per-task lines + id line | auto | P1, P5 | ids not checkable | one aggregated line |
| DX-3 | DX | `pm drop --dry-run`, sha + undo (recovery superseded by ENG-4) | auto | P1 | no preview/undo | revert by hand |
| DX-4 | DX | restart-all upgrade note | auto | P1, P5 | 0.12 reads remind: as open | behavioral cross-version test |
| DX-5 | DX | `--clear T-123#n` | auto | P5 | printed id not pasteable | number only |
| DX-6 | DX | `later#n`, one batched /close question | auto | P5 | anti-goal: more questions | per-line questions |
| DX-7 | DX | error template what — why — next command | auto | P1 | agent-ready contract | free text |
| DX-8..10 | DX | decision table, examples, README fixes, grep test | auto | P1, P5 | docs gaps | — |
| DX-11 | DX | accepted bullets supersede §1–§7 | auto | P5 | stale text | rewrite now |
| DX-12 | DX | no flag for the hint | taste T8 | P5 | fewer knobs | `--standalone` |
| DX-13, 14 | DX | thresholds, off switch, upgrade line deferred | auto | P3 | new channels | build now |
| DX-15 | DX | product onboarding walkthrough deferred | taste T9 | P3 | outside plan scope | add now |
| DX-16 | DX | git error line + PM_DEBUG stack | auto | P1, P4 | agent-ready context/trace | — |
| ENG-1 | Eng | own reflog offset + entry time | auto | P1, P5 | API lacks time; cursor consumed | reuse capture cursor |
| ENG-2 | Eng | deletions by parent-dir mtime | auto | P5, P3 | dirty-set misfires, grows state | dirty-path snapshot |
| ENG-3 | Eng | safety note via autoWrite (bug) | auto | P1 | resets Stop window | — |
| ENG-4 | Eng | drop transaction, claim → commit locks, restore | auto | P1, P5 | both voices: not atomic | `pm set` restore |
| ENG-5 | Eng | validate: dropped deps only for open tasks | auto | P1 | batch drop broke validate | — |
| ENG-6 | Eng | metric: no ` · did: ` line | auto | P5 | undefined term | any Log line |
| ENG-7 | Eng | protected Epic/Reminders lines | auto | P1 | cap hides them | — |
| ENG-8 | Eng | reconcile epic lines after batch | auto | P1 | double/wrong lines | per task |
| ENG-9 | Eng | `reminders.mjs` module | auto | P4 | one owner of syntax + words | inside tasks.mjs |
| ENG-10 | Eng | `--clear` echoes text | auto | P5 | hand edits shift numbers | text match flag |
| ENG-11 | Eng | auditLine excludes reminder-task | auto | P3 | heuristic noise | — |
| ENG-12 | Eng | sanitize remind/why/later text | auto | P1 | file structure injection | raw text |
| ENG-13, 15 | Eng | fold spec first; `pm set status=dropped` hint | auto | P5 | two ways to drop | remove pm set path |
| ENG-14 | Eng | Windows-safe lock tests | auto | P1 | CI matrix | skip on win32 |
| ENG-16 | Eng | min_version check deferred | auto | P3 | mixed versions rare | build now |

## Gate decisions (2026-10-29, reply `rec`, gate_rev 1)

APPROVED. uc1 = c; d1–d9 = a (every recommendation); plan1 = a.

One release 0.13.0, built as two PRs (uc1c):

- **PR1 — core.** Step 0: fold the CEO/DX/Eng accepted bullets into §1–§7 (ENG-13). Then §1 triage protocol text +
  `later#n` and the one batched `/close` question (CEO-13, DX-6), docs for these (DX-8..10 minus remind/drop),
  §3 Stop (DX-1, ENG-1, ENG-2, ENG-3), §4 epic progress (CEO-15, ENG-7 epic line, ENG-8), §6 `created`/`--from`
  and the `pm task new` hint (CEO-16, DX-12) with `scripts/lib/reminders.mjs` word list (ENG-9), the `pm audit`
  stats line (CEO-14, ENG-6), `validate` open-only rule (ENG-5), error template for the new messages (DX-7),
  input sanitizing for `later#n` text (ENG-12), Windows-safe tests (ENG-14). No version bump.
- **PR2 — cleanup tools.** §2 `pm remind` + `Reminders:` line (DX-5, ENG-7 reminders line, ENG-10, ENG-12),
  §5 `pm audit` `empty` and `reminder-task` (DX-2, ENG-11), `pm drop` transaction (DX-3, ENG-4, DX-16), their docs and
  README examples, upgrade/downgrade notes (DX-4), version 0.13.0 + changelog, rollout order (CEO-18).
- PR2 depends on PR1 (shared `reminders.mjs`, error template, sanitizing helper).
