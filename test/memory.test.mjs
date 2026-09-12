import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup, tmp, sh, cli } from './helpers.mjs';
import { pmDir, memoryDir } from '../scripts/lib/paths.mjs';
import { linkMemory, isLink } from '../scripts/lib/sync.mjs';

function project() {
  const { root } = setup();
  const remote = tmp('pm-remote-');
  sh(['init', '-q', '--bare', '-b', 'main'], remote);
  sh(['remote', 'add', 'origin', remote], root);
  return root;
}

test('sync on moves existing memory into the board and links it', () => {
  const root = project();
  const mem = memoryDir(root);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [a](a.md)\n');
  fs.writeFileSync(path.join(mem, 'a.md'), 'local a\n');
  cli(['init'], root);
  const pm = pmDir(root);
  fs.mkdirSync(path.join(pm, 'memory'));
  fs.writeFileSync(path.join(pm, 'memory', 'a.md'), 'board a\n');

  const out = cli(['sync', 'on', '--yes'], root).out;
  assert.match(out, /memory linked/);
  assert.match(out, /clashes kept as .*a\.md/);
  assert.equal(isLink(mem), true);
  assert.equal(fs.realpathSync(mem), fs.realpathSync(path.join(pm, 'memory')));
  assert.deepEqual(fs.readdirSync(path.join(pm, 'memory')).sort(), ['MEMORY.md', 'a.md', `a.${os.hostname()}.md`].sort());
  assert.equal(fs.readFileSync(path.join(pm, 'memory', 'a.md'), 'utf8'), 'board a\n');
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: link memory');
});

test('pm.syncMemory=false leaves memory untouched', () => {
  const root = project();
  const mem = memoryDir(root);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), 'x\n');
  sh(['config', 'pm.syncMemory', 'false'], root);
  cli(['init'], root);
  assert.doesNotMatch(cli(['sync', 'on', '--yes'], root).out, /memory linked/);
  assert.equal(isLink(mem), false);
});

test('linkMemory is idempotent and creates a missing link', () => {
  const root = project();
  cli(['init'], root);
  const pm = pmDir(root);
  assert.equal(linkMemory(root, pm).linked, true);
  assert.deepEqual(linkMemory(root, pm), { linked: true, moved: [], clashes: [] });
  assert.equal(isLink(memoryDir(root)), true);
});
