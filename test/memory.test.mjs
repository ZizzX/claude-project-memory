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

test('re-running the copy loop never overwrites already-moved content', () => {
  const root = project();
  const mem = memoryDir(root);
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'a.md'), 'local v1\n');
  cli(['init'], root);
  const pm = pmDir(root);
  fs.mkdirSync(path.join(pm, 'memory'));
  fs.writeFileSync(path.join(pm, 'memory', 'a.md'), 'board a\n');

  const r1 = linkMemory(root, pm);
  assert.deepEqual(r1.clashes, ['a.md']);
  const hostFile = path.join(pm, 'memory', `a.${os.hostname()}.md`);
  assert.equal(fs.readFileSync(hostFile, 'utf8'), 'local v1\n');
  assert.equal(isLink(mem), true);

  // Simulate an interrupted retry: remove just the link (the copy already landed in the
  // board) and put back a source folder whose file differs yet again.
  fs.rmSync(mem, { recursive: true });
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'a.md'), 'local v2\n');

  const r2 = linkMemory(root, pm);
  assert.deepEqual(r2.clashes, ['a.md']);
  // nothing already in the board was touched by the retry
  assert.equal(fs.readFileSync(hostFile, 'utf8'), 'local v1\n');
  assert.equal(fs.readFileSync(path.join(pm, 'memory', 'a.md'), 'utf8'), 'board a\n');
  // the newly differing content sits beside it under a fresh name
  assert.equal(fs.readFileSync(path.join(pm, 'memory', `a.${os.hostname()}-2.md`), 'utf8'), 'local v2\n');
});

test('directory entries are merged, not duplicated', () => {
  const root = project();
  const mem = memoryDir(root);
  fs.mkdirSync(path.join(mem, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(mem, 'sub', 'same.md'), 'same content\n');
  fs.writeFileSync(path.join(mem, 'sub', 'diff.md'), 'local diff\n');
  cli(['init'], root);
  const pm = pmDir(root);
  fs.mkdirSync(path.join(pm, 'memory', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(pm, 'memory', 'sub', 'same.md'), 'same content\n');
  fs.writeFileSync(path.join(pm, 'memory', 'sub', 'diff.md'), 'board diff\n');

  const r = linkMemory(root, pm);
  assert.deepEqual(r.clashes, ['sub/diff.md']); // the identical file is not a clash
  assert.deepEqual(
    fs.readdirSync(path.join(pm, 'memory')).sort(),
    ['sub'], // merged into the existing "sub", not duplicated as a second directory
  );
  assert.deepEqual(
    fs.readdirSync(path.join(pm, 'memory', 'sub')).sort(),
    ['diff.md', `diff.${os.hostname()}.md`, 'same.md'].sort(),
  );
  assert.equal(fs.readFileSync(path.join(pm, 'memory', 'sub', 'same.md'), 'utf8'), 'same content\n');
  assert.equal(fs.readFileSync(path.join(pm, 'memory', 'sub', 'diff.md'), 'utf8'), 'board diff\n');
  assert.equal(fs.readFileSync(path.join(pm, 'memory', 'sub', `diff.${os.hostname()}.md`), 'utf8'), 'local diff\n');
});
