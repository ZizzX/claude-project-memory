# Update notification for plugin users

**Goal:** a user running an old version of the plugin learns about a new one in the session summary and
chooses what happens next, instead of finding out when a fix they read about does not work.

**Shape (after gstack):** a cheap check produces a machine-readable line → the line appears in the session
summary → the SKILL.md protocol tells Claude to offer the options → the answer is stored, so nobody is
asked twice.

## 1. Detecting a new version

Two sources, in this order, both failing silently:

| # | Source | Cost | Catches |
|---|---|---|---|
| 1 | the marketplace copy: `<claude-home>/plugins/known_marketplaces.json` → `installLocation` → `.claude-plugin/plugin.json` | two local file reads | an update already fetched by Claude Code but not installed |
| 2 | the release itself: `plugin.json` of the repository's default branch over HTTPS, at most once a day | one request, cached | a release the marketplace copy has not seen yet |

The running version is the `.claude-plugin/plugin.json` next to the executing script (the cache copy), never
a constant in the code. Compared with a plain semver compare; anything unparsable means "no update".

The network check is opt-out (`pm.updateCheckNetwork=false`), runs at most once per day, has a short timeout,
and never delays the summary. **Source 1 alone is a complete mode, not a degraded one:** with no network, a
proxy in the way, or the check switched off, the marketplace copy still announces everything Claude Code has
already fetched. A failed request is indistinguishable from "no new version" and is never reported as an error.

## 2. The line

One line in the summary, next to `[pm] sync conflict …` and `[pm] board problems: …`:

```
[pm] update available: 0.3.0 → 0.3.1 — say "update the plugin", "later", "never" or "update it yourself"
```

Printed only when an update exists, the user has not said "never", and any snooze has expired.

## 3. The five options (SKILL.md protocol)

| The user says | Claude does |
|---|---|
| "update the plugin", "обнови плагин" | runs `claude plugin marketplace update <marketplace>` and `claude plugin update <plugin>@<marketplace>`, reports the version that landed and says a full restart (or `/reload-plugins`) is needed |
| "later", "позже" | `git config --global pm.updateSnoozeUntil <today + 7 days>` — silent until then |
| "I'll do it myself", "сам обновлю" | prints the two commands, then behaves like "later" |
| "never", "не напоминай" | `git config --global pm.updateNotify never` — silent for every repository until the user asks again |
| "update it yourself, do not ask", "обновляй сам" | `git config --global pm.updateNotify auto` — from then on Claude updates as soon as it sees the line, without asking, and reports the version that landed and that a restart is needed |

## 4. Where the answer is stored

`git config --global`, the way `pm.syncMemory` already works — a per-user setting, not a per-repository one,
and no new state format:

- `pm.updateNotify` — `ask` (default), `auto` (update without asking) or `never`;
- `pm.updateSnoozeUntil` — a date; a snooze older than the version it was made for is ignored, so a newer
  release is still announced;
- `pm.updateCheckNetwork` — `true` (default) or `false`;
- the last network check and its result live in the plugin's own state, not in the config.

## 5. Out of scope

- Updating without the user having asked for it. `auto` is the user's own standing yes, recorded once and
  revocable; without it the plugin never changes what is installed (the same rule as D-011 for destructive
  git: print, ask, then act). An `auto` run still says what happened, it is never silent.
- Release notes in the summary. The line stays one line; what changed is in the repository.
