import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeHome, git, tryGit, normPath } from './paths.mjs';
import { readState, writeState } from './store.mjs';

const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATE = 'update';
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 5_000;
export const MODES = ['ask', 'auto', 'never'];

// Two leading numbers are not enough: 0.3.0 and 0.3.1 differ in the last one only.
const parse = (v) => /^\d+\.\d+\.\d+/.exec(String(v ?? '').trim())?.[0].split('.').map(Number) ?? null;

// true when `a` is a newer release than `b`; anything unparsable means "no update".
export function isNewer(a, b) {
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
}

export function readPlugin(dir) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    return json?.name ? json : null;
  } catch {
    return null;
  }
}

// The version actually running is the copy next to this script, never a constant in the code.
export const runningPlugin = () => readPlugin(PLUGIN_ROOT);

// Source 1: what Claude Code has already fetched. A marketplace holding the plugin at its root
// is our own layout; a plugin nested deeper in someone else's marketplace is simply not found.
export function marketplaceEntry(name, home = claudeHome()) {
  let known;
  try {
    known = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), 'utf8'));
  } catch {
    return null;
  }
  for (const [key, entry] of Object.entries(known ?? {})) {
    const plugin = entry?.installLocation ? readPlugin(entry.installLocation) : null;
    if (plugin?.name === name) return { key, version: plugin.version ?? null, dir: entry.installLocation };
  }
  return null;
}

// Scope of the installation that is actually running. `claude plugin update` defaults to
// `user`, so a project-, local- or managed-scope install would be missed without it.
export function installedScope(name, key, home = claudeHome(), root = PLUGIN_ROOT) {
  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8'));
  } catch {
    return null;
  }
  const entries = installed?.plugins?.[`${name}@${key}`];
  if (!Array.isArray(entries) || !entries.length) return null;
  const here = entries.filter((e) => e?.installPath && normPath(e.installPath) === normPath(root));
  // Entries carry no project path, so two scopes sharing one install directory are indistinguishable:
  // name a scope only when it is unambiguous, else say nothing and let the command default to user.
  if (here.length === 1) return here[0].scope ?? null;
  if (here.length) return null;
  return entries.length === 1 ? entries[0].scope ?? null : null;
}

// The two commands that install the update, with this machine's own marketplace key.
// Claude runs these; a person can also type them as /plugin … inside Claude Code.
export function updateCommands(plugin = runningPlugin(), home = claudeHome()) {
  const entry = plugin?.name ? marketplaceEntry(plugin.name, home) : null;
  if (!entry) return [];
  const scope = installedScope(plugin.name, entry.key, home);
  return [
    `claude plugin marketplace update ${entry.key}`,
    `claude plugin update ${plugin.name}@${entry.key}${scope ? ` --scope ${scope}` : ''}`,
  ];
}

// Source 2, GitHub only: the plugin.json of the default branch. Any other forge gets no network check.
export function rawUrl(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  const m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(String(url ?? ''));
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/.claude-plugin/plugin.json` : null;
}

export async function fetchLatest(repository) {
  const url = rawUrl(repository);
  if (!url) return null;
  try {
    const fixture = process.env.PM_UPDATE_FIXTURE; // test seam: nothing is requested
    const json = fixture ? JSON.parse(fs.readFileSync(fixture, 'utf8'))[url] : await (await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })).json();
    return parse(json?.version) ? json.version : null;
  } catch {
    return null;
  }
}

export const networkCheckEnabled = (cwd) => tryGit(['config', '--get', 'pm.updateCheckNetwork'], cwd) !== 'false';

// Runs after the summary is printed, so a slow or hanging request never delays a session start;
// its result is read by the next one.
function refreshInBackground(pm) {
  if (process.env.PM_NO_BACKGROUND) return;
  spawn(process.execPath, [PM_SCRIPT, '_update-check', pm], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export async function refreshLatest(pm, plugin = runningPlugin(), now = Date.now()) {
  const version = await fetchLatest(plugin?.repository);
  writeState(pm, STATE, { checkedAt: now, version }); // a failed request is cached as "nothing new"
  return version;
}

// { current, latest, source } when a newer version exists, else null. Never throws, never blocks.
export function updateAvailable({ pm, cwd, now = Date.now(), plugin = runningPlugin() }) {
  if (!plugin?.version) return null;
  const cached = readState(pm, STATE);
  if (networkCheckEnabled(cwd) && now - (cached.checkedAt ?? 0) > DAY_MS) refreshInBackground(pm);
  const found = [
    { latest: marketplaceEntry(plugin.name)?.version, source: 'marketplace' },
    { latest: cached.version, source: 'release' },
  ].filter((c) => isNewer(c.latest, plugin.version));
  if (!found.length) return null;
  const best = found.reduce((a, b) => (isNewer(b.latest, a.latest) ? b : a));
  return { current: plugin.version, latest: best.latest, source: best.source };
}

// --- preferences: git config --global, the way pm.syncMemory already works ---

export const SNOOZE_DAYS = 7;

export const notifyMode = (cwd) => {
  const mode = tryGit(['config', '--get', 'pm.updateNotify'], cwd);
  return MODES.includes(mode) ? mode : 'ask';
};

// The snooze records the version it was made for ("<date> <version>"), so a release newer than
// that one is announced anyway. A bare date snoozes whatever comes.
export function snoozed(cwd, latest, today) {
  const [until, version] = (tryGit(['config', '--get', 'pm.updateSnoozeUntil'], cwd) ?? '').trim().split(/\s+/);
  if (!until) return false;
  if (version && isNewer(latest, version)) return false;
  return today <= until; // ISO dates compare as plain strings
}

export function setMode(cwd, mode) {
  if (!MODES.includes(mode)) throw new Error(`bad mode "${mode}"; use ${MODES.join(' | ')}`);
  git(['config', '--global', 'pm.updateNotify', mode], cwd);
  tryGit(['config', '--global', '--unset-all', 'pm.updateSnoozeUntil'], cwd); // absent is exit 5, not an error here
  return mode;
}

export function snooze(cwd, latest, days = SNOOZE_DAYS, now = Date.now()) {
  const until = new Date(now + days * DAY_MS).toLocaleDateString('sv-SE');
  git(['config', '--global', 'pm.updateSnoozeUntil', `${until}${latest ? ` ${latest}` : ''}`], cwd);
  return until;
}

// The one line for the session summary, or '' when there is nothing to say.
export function updateLine({ pm, cwd, now = Date.now(), today = new Date(now).toLocaleDateString('sv-SE'), plugin = runningPlugin() }) {
  const mode = notifyMode(cwd);
  if (mode === 'never') return '';
  const found = updateAvailable({ pm, cwd, now, plugin });
  if (!found || snoozed(cwd, found.latest, today)) return '';
  const head = `[pm] update available: ${found.current} → ${found.latest}`;
  return mode === 'auto'
    ? `${head} — pm.updateNotify=auto: update it now without asking, then report the version and that a restart is needed`
    : `${head} — say "update the plugin", "later", "never" or "update it yourself"`;
}
