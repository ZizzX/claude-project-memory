# project-memory

A Claude Code plugin that gives every git repository a memory Claude actually uses:
an accepted **plan**, a **task board** with statuses, order and dependencies, a **decision log**
(what, why, what was rejected) and a **session handoff** — so a new session, in any worktree,
starts knowing where work stopped and what the next step is.

- **Automatic.** Hooks inject a short board summary at every session start, nudge Claude when a
  plan file changes, remind it when code changed but the board did not, and write a safety note
  before context compaction or session end.
- **Autonomous.** Claude creates tasks, moves statuses, logs work and records decisions itself,
  ending each turn that changed the board with a one-line diff.
- **Worktree-friendly.** The board lives outside your branches, one per repo, shared by all
  worktrees on the machine.
- **Local by default.** Nothing leaves your machine unless you enable sync for a project.
- **Zero dependencies.** Node ≥ 20 and git. Windows, macOS, Linux.

## Install

```
/plugin marketplace add ZizzX/claude-project-memory
/plugin install project-memory@project-memory
```

## Use

Just work. In a repo with a board, every session starts with a summary like:

```
[pm] my-app · focus: M1 import pipeline · board: file:///…/pm/board.html
Your worktree (feature-csv):
  T-003 CSV import [in_progress] → next: handle empty rows (2026-09-12, feature-csv)
Ready: T-004 validation · T-006 export
Waiting: T-005 ← answer about date format
Decisions: D-004 Store board outside branches · D-003 Own format
```

Useful phrases: "what's next?", "break it down", "remember …", "we're done",
"continue in a new session", "the plan changes", "undo T-007". Run `/pm` to see the protocol.
Open `board.html` in a browser for a kanban view that refreshes itself.

A board is created the first time you start non-trivial work in a repo (or say "create a board").

## Where things live

```
~/.claude/projects/<repo-key>/pm/     (or $CLAUDE_CONFIG_DIR/projects/…)
  PLAN.md  tasks/T-NNN.md  decisions.md  BOARD.md  board.html
```

It is a small git repository: every board change is a commit, so any change can be reverted.

## Sync across machines (opt-in)

Say "enable board sync" (or run `pm sync on`). Claude shows where the board will be pushed and waits
for your yes. The board is pushed to branch `pm` of the project's own remote, and Claude Code's
auto-memory for the project moves into the board and syncs with it.

On another machine, install the plugin and open the project: the summary says the repo has a shared
board; say "connect the board". Nothing is ever connected automatically.

### Privacy

- Nothing is pushed until you enable sync for that project.
- With sync on, the board **and the project's auto-memory** are pushed to branch `pm` of the project's
  remote. If that repository is public, they become public — use `pm sync on --remote <private-url>`.
- Keep memory local while syncing the board: `git config pm.syncMemory false` before enabling sync.
  This flag is only read when sync turns on — setting it afterwards does not unlink memory that is
  already synced; undo that by hand (move `pm/memory` back and remove the link).
- `pm sync off` stops syncing and keeps the local board.

## Coexisting with other memory tools

If you use other resume/memory mechanisms (session checkpoints, context-save skills, memory MCP
servers), consider disabling them once `/pm` works for you, so there is a single answer to
"where did we stop?". Plans written by superpowers, gstack, plan mode or dev-cycle are picked up
by the board automatically.

## Development

```
node --test                          # run all tests
claude --plugin-dir .                # try the plugin without installing
```

## License

MIT
