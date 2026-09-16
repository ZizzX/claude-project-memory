import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeHome, tryGit } from './paths.mjs';
import { readState, writeState } from './store.mjs';

const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const STATE = 'update';
const DAY_MS = 86_400_000;
const TIMEOUT_MS = 5_000;

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
export function marketplaceVersion(name, home = claudeHome()) {
  let known;
  try {
    known = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), 'utf8'));
  } catch {
    return null;
  }
  for (const entry of Object.values(known ?? {})) {
    const plugin = entry?.installLocation ? readPlugin(entry.installLocation) : null;
    if (plugin?.name === name) return plugin.version ?? null;
  }
  return null;
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
    { latest: marketplaceVersion(plugin.name), source: 'marketplace' },
    { latest: cached.version, source: 'release' },
  ].filter((c) => isNewer(c.latest, plugin.version));
  if (!found.length) return null;
  const best = found.reduce((a, b) => (isNewer(b.latest, a.latest) ? b : a));
  return { current: plugin.version, latest: best.latest, source: best.source };
}
