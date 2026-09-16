import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp } from './helpers.mjs';
import { readState, writeState } from '../scripts/lib/store.mjs';
import { isNewer, readPlugin, marketplaceVersion, rawUrl, fetchLatest, refreshLatest, updateAvailable, networkCheckEnabled } from '../scripts/lib/update.mjs';

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

test('marketplaceVersion finds the plugin by name and survives a missing or broken file', () => {
  const home = tmp('pm-home-');
  assert.equal(marketplaceVersion('project-memory', home), null);
  marketplaces(home, {
    other: { installLocation: pluginDir('9.9.9', 'something-else') },
    'project-memory': { installLocation: pluginDir('0.3.1') },
    gone: { installLocation: path.join(home, 'nowhere') },
  });
  assert.equal(marketplaceVersion('project-memory', home), '0.3.1');
  assert.equal(marketplaceVersion('not-installed', home), null);
  fs.writeFileSync(path.join(home, 'plugins', 'known_marketplaces.json'), '{broken');
  assert.equal(marketplaceVersion('project-memory', home), null);
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
