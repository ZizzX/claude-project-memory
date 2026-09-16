import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp, cli } from './helpers.mjs';
import { readState, writeState } from '../scripts/lib/store.mjs';
import { isNewer, readPlugin, marketplaceEntry, updateCommands, installedScope, rawUrl, fetchLatest, refreshLatest, updateAvailable, networkCheckEnabled, updateLine, notifyMode, setMode, snooze, snoozed } from '../scripts/lib/update.mjs';

const PLUGIN = { name: 'project-memory', version: '0.3.0', repository: 'https://github.com/ZizzX/claude-project-memory' };
const URL_0_3_1 = 'https://raw.githubusercontent.com/ZizzX/claude-project-memory/HEAD/.claude-plugin/plugin.json';

function pluginDir(version, name = 'project-memory') {
  const dir = tmp('pm-plugin-');
  fs.mkdirSync(path.join(dir, '.claude-plugin'));
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
  return dir;
}

function marketplaces(home, entries) {
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), JSON.stringify(entries));
}

function withFixture(responses, fn) {
  const file = path.join(tmp(), 'update.json');
  fs.writeFileSync(file, JSON.stringify(responses));
  const prev = process.env.PM_UPDATE_FIXTURE;
  process.env.PM_UPDATE_FIXTURE = file;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.PM_UPDATE_FIXTURE;
    else process.env.PM_UPDATE_FIXTURE = prev;
  }
}

test('isNewer compares semver numerically; anything unparsable is "no update"', () => {
  assert.equal(isNewer('0.3.1', '0.3.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '0.99.99'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('0.4.0-beta', '0.3.0'), true); // the numbers still parse
  assert.equal(isNewer('nightly', '0.3.0'), false);
  assert.equal(isNewer('0.3.1', ''), false);
  assert.equal(isNewer('0.3.1', undefined), false);
});

test('readPlugin: a plugin.json next to the given root, or null', () => {
  assert.deepEqual(readPlugin(pluginDir('0.3.0')), { name: 'project-memory', version: '0.3.0' });
  assert.equal(readPlugin(tmp()), null);
});

test('marketplaceEntry finds the plugin by name and survives a missing or broken file', () => {
  const home = tmp('pm-home-');
  assert.equal(marketplaceEntry('project-memory', home), null);
  const dir = pluginDir('0.3.1');
  marketplaces(home, {
    other: { installLocation: pluginDir('9.9.9', 'something-else') },
    'project-memory': { installLocation: dir },
    gone: { installLocation: path.join(home, 'nowhere') },
  });
  assert.deepEqual(marketplaceEntry('project-memory', home), { key: 'project-memory', version: '0.3.1', dir });
  assert.equal(marketplaceEntry('not-installed', home), null);
  fs.writeFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), '{broken');
  assert.equal(marketplaceEntry('project-memory', home), null);
});

test('rawUrl: GitHub only', () => {
  assert.equal(rawUrl('https://github.com/ZizzX/claude-project-memory'), URL_0_3_1);
  assert.equal(rawUrl('https://github.com/ZizzX/claude-project-memory.git'), URL_0_3_1);
  assert.equal(rawUrl({ url: 'https://github.com/ZizzX/claude-project-memory' }), URL_0_3_1);
  assert.equal(rawUrl('https://gitlab.com/g/p'), null);
  assert.equal(rawUrl(undefined), null);
});

test('fetchLatest returns the released version, and null for junk or an unknown forge', async () => {
  await withFixture({ [URL_0_3_1]: { version: '0.3.1' } }, async () => {
    assert.equal(await fetchLatest(PLUGIN.repository), '0.3.1');
    assert.equal(await fetchLatest('https://gitlab.com/g/p'), null);
  });
  await withFixture({ [URL_0_3_1]: { version: 'nightly' } }, async () => {
    assert.equal(await fetchLatest(PLUGIN.repository), null);
  });
  await withFixture({}, async () => {
    assert.equal(await fetchLatest(PLUGIN.repository), null); // no response cached: a failed request
  });
});

test('the marketplace copy alone announces an update, with no network at all', () => {
  const { home } = setup();
  const pm = tmp();
  marketplaces(home, { 'project-memory': { installLocation: pluginDir('0.3.1') } });
  assert.deepEqual(updateAvailable({ pm, cwd: pm, plugin: PLUGIN }), { current: '0.3.0', latest: '0.3.1', source: 'marketplace' });
  assert.equal(updateAvailable({ pm, cwd: pm, plugin: { ...PLUGIN, version: '0.3.1' } }), null);
  assert.equal(updateAvailable({ pm, cwd: pm, plugin: { name: 'project-memory' } }), null);
});

test('the cached network result is used, and the newest of the two sources wins', () => {
  const { home } = setup();
  const pm = tmp();
  marketplaces(home, { 'project-memory': { installLocation: pluginDir('0.3.0') } });
  writeState(pm, 'update', { checkedAt: Date.now(), version: '0.4.0' });
  assert.deepEqual(updateAvailable({ pm, cwd: pm, plugin: PLUGIN }), { current: '0.3.0', latest: '0.4.0', source: 'release' });
  marketplaces(home, { 'project-memory': { installLocation: pluginDir('0.5.0') } });
  assert.deepEqual(updateAvailable({ pm, cwd: pm, plugin: PLUGIN }), { current: '0.3.0', latest: '0.5.0', source: 'marketplace' });
  writeState(pm, 'update', { checkedAt: Date.now(), version: null }); // a failed check reports nothing
  marketplaces(home, { 'project-memory': { installLocation: pluginDir('0.3.0') } });
  assert.equal(updateAvailable({ pm, cwd: pm, plugin: PLUGIN }), null);
});

test('refreshLatest caches the result, so the check runs at most once a day', async () => {
  const pm = tmp();
  await withFixture({ [URL_0_3_1]: { version: '0.3.1' } }, () => refreshLatest(pm, PLUGIN, 1000));
  assert.deepEqual(readState(pm, 'update'), { checkedAt: 1000, version: '0.3.1' });
  await withFixture({}, () => refreshLatest(pm, PLUGIN, 2000));
  assert.deepEqual(readState(pm, 'update'), { checkedAt: 2000, version: null });
});

test('the network check is opt-out per user', () => {
  const { root } = setup();
  assert.equal(networkCheckEnabled(root), true);
  fs.appendFileSync(path.join(root, '.git', 'config'), '[pm]\n\tupdateCheckNetwork = false\n');
  assert.equal(networkCheckEnabled(root), false);
});

// Preferences are per user (git config --global): a temp file keeps the real one untouched.
function withGlobalConfig(fn) {
  const file = path.join(tmp(), 'gitconfig');
  fs.writeFileSync(file, '');
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = file;
  try {
    return fn(file);
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }
}

// A board plus a marketplace copy one release ahead of PLUGIN.
function withUpdate(latest = '0.3.1') {
  const { home, root } = setup();
  const pm = tmp();
  marketplaces(home, { 'project-memory': { installLocation: pluginDir(latest) } });
  return { home, root, pm };
}

test('the line names both versions and the four things the user can say', () => {
  withGlobalConfig(() => {
    const { root, pm } = withUpdate();
    assert.equal(
      updateLine({ pm, cwd: root, plugin: PLUGIN }),
      '[pm] update available: 0.3.0 → 0.3.1 — say "update the plugin", "later", "never" or "update it yourself"',
    );
    assert.equal(updateLine({ pm, cwd: root, plugin: { ...PLUGIN, version: '0.3.1' } }), ''); // nothing newer
  });
});

test('never silences the line; auto tells Claude to update without asking', () => {
  withGlobalConfig(() => {
    const { root, pm } = withUpdate();
    assert.equal(setMode(root, 'never'), 'never');
    assert.equal(notifyMode(root), 'never');
    assert.equal(updateLine({ pm, cwd: root, plugin: PLUGIN }), '');
    setMode(root, 'auto');
    assert.match(updateLine({ pm, cwd: root, plugin: PLUGIN }), /^\[pm\] update available: 0\.3\.0 → 0\.3\.1 — pm\.updateNotify=auto: update it now/);
    setMode(root, 'ask');
    assert.equal(notifyMode(root), 'ask');
    assert.throws(() => setMode(root, 'sometimes'), /bad mode/);
  });
});

test('"later" is silent for a week, but a newer release than the snoozed one still speaks up', () => {
  withGlobalConfig(() => {
    const { home, root, pm } = withUpdate();
    const until = snooze(root, '0.3.1', 7, Date.parse('2026-09-16T12:00:00Z'));
    assert.equal(until, '2026-09-23');
    assert.equal(snoozed(root, '0.3.1', '2026-09-20'), true);
    assert.equal(snoozed(root, '0.3.1', '2026-09-24'), false); // expired
    assert.equal(snoozed(root, '0.4.0', '2026-09-20'), false); // a newer release than the snoozed one
    assert.equal(updateLine({ pm, cwd: root, now: Date.parse('2026-09-20T12:00:00Z'), plugin: PLUGIN }), '');
    marketplaces(home, { 'project-memory': { installLocation: pluginDir('0.4.0') } });
    assert.match(updateLine({ pm, cwd: root, now: Date.parse('2026-09-20T12:00:00Z'), plugin: PLUGIN }), /0\.3\.0 → 0\.4\.0/);
    assert.equal(setMode(root, 'ask'), 'ask'); // setting the mode clears the snooze
    assert.equal(snoozed(root, '0.3.1', '2026-09-20'), false);
  });
});

test('pm update reports the state and stores the answer', () => {
  withGlobalConfig(() => {
    const { root, home } = withUpdate();
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    const boot = cli(['init'], root);
    assert.equal(boot.code, 0, boot.err);
    assert.match(cli(['update'], root).out, /notify: ask/);
    assert.equal(cli(['update', 'never'], root).out, 'pm.updateNotify=never');
    assert.match(cli(['update'], root).out, /notify: never/);
    assert.match(cli(['update', 'later'], root).out, /^reminded again after \d{4}-\d{2}-\d{2}/);
    assert.equal(cli(['update', 'nonsense'], root).code, 1);
  });
});

test('updateCommands names this machine\'s marketplace key, or nothing when the plugin is not from one', () => {
  const home = tmp('pm-home-');
  assert.deepEqual(updateCommands(PLUGIN, home), []);
  marketplaces(home, { 'my-tools': { installLocation: pluginDir('0.3.1') } });
  assert.deepEqual(updateCommands(PLUGIN, home), [
    'claude plugin marketplace update my-tools',
    'claude plugin update project-memory@my-tools',
  ]);
});

// claude plugin update defaults to --scope user, so an install in another scope needs it spelled out.
test('updateCommands passes the scope of the installation that is running', () => {
  const home = tmp('pm-home-');
  const running = tmp('pm-cache-');
  marketplaces(home, { 'my-tools': { installLocation: pluginDir('0.3.1') } });
  assert.equal(installedScope('project-memory', 'my-tools', home, running), null); // no file yet
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 1,
    plugins: {
      'project-memory@my-tools': [
        { scope: 'user', installPath: path.join(tmp(), 'elsewhere') },
        { scope: 'project', installPath: running },
      ],
      'other@my-tools': [{ scope: 'local', installPath: running }],
    },
  }));
  assert.equal(installedScope('project-memory', 'my-tools', home, running), 'project');
  assert.equal(installedScope('project-memory', 'my-tools', home, tmp()), null); // several installs, none is this one
  assert.equal(installedScope('not-installed', 'my-tools', home, running), null);
  assert.equal(updateCommands(PLUGIN, home)[1], 'claude plugin update project-memory@my-tools'); // the running copy is neither entry
});

test('an ambiguous install says nothing, so the command keeps its default scope', () => {
  const home = tmp('pm-home-');
  const running = tmp('pm-cache-');
  marketplaces(home, { 'my-tools': { installLocation: pluginDir('0.3.1') } });
  fs.writeFileSync(path.join(home, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 1,
    plugins: {
      'project-memory@my-tools': [
        { scope: 'project', installPath: running }, // another project's install, same cache directory
        { scope: 'user', installPath: running },
      ],
    },
  }));
  assert.equal(installedScope('project-memory', 'my-tools', home, running), null);
  assert.equal(updateCommands(PLUGIN, home)[1], 'claude plugin update project-memory@my-tools');
});

test('pm update prints the two commands when there is something to install', () => {
  withGlobalConfig(() => {
    // The CLI runs this repo's plugin.json, so the release ahead is derived from it, not hardcoded.
    const { version } = readPlugin(path.resolve(import.meta.dirname, '..'));
    const [major, minor, patch] = version.split('.').map(Number);
    const latest = `${major}.${minor}.${patch + 1}`;
    const { root, home } = withUpdate(latest);
    fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
    assert.equal(cli(['init'], root).code, 0);
    const out = cli(['update'], root).out;
    assert.ok(out.includes(`${version} → ${latest} (marketplace)`), out);
    assert.match(out, /claude plugin update project-memory@project-memory/);
    assert.match(out, /restart Claude Code/);
  });
});
