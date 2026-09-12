import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setup, cli, sh, PM } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

test('cli: the full local workflow', () => {
  const { root } = setup();
  assert.match(cli(['init'], root).out, /^created: /);
  assert.match(cli(['init'], root).out, /^exists: /);
  assert.match(cli(['task', 'new', '--title', 'Parser', '--milestone', 'M1'], root).out, /^T-001 created/);
  assert.match(cli(['task', 'new', '--title', 'Docs', '--deps', 'T-001'], root).out, /^T-002 created/);
  assert.equal(cli(['ready'], root).out, 'T-001 Parser');
  assert.match(cli(['claim', 'T-001'], root).out, new RegExp(`claimed by ${path.basename(root)}`));
  assert.equal(cli(['log', 'T-001', '--did', 'tokenizer', '--next', 'edge cases'], root).code, 0);
  assert.equal(cli(['set', 'T-001', 'status=done'], root).code, 0);
  assert.equal(cli(['ready'], root).out, 'T-002 Docs');
  assert.match(cli(['decision', '--title', 'Use CSV', '--why', 'simple', '--rejected', 'JSON', '--tasks', 'T-001'], root).out, /^D-001 recorded/);
  assert.equal(cli(['validate'], root).out, 'ok');
  assert.match(cli(['board'], root).out, /board\.html$/);
  assert.match(cli(['summary'], root).out, /Ready: T-002 Docs/);
  const log = sh(['log', '--format=%s'], pmDir(root));
  for (const s of ['pm: init', 'pm: task new T-001', 'pm: claim T-001', 'pm: log T-001', 'pm: set T-001 status=done', 'pm: decision D-001']) {
    assert.match(log, new RegExp(s));
  }
});

test('cli: errors exit 1 with a message', () => {
  const { root } = setup();
  const noBoard = cli(['ready'], root);
  assert.equal(noBoard.code, 1);
  assert.match(noBoard.err, /no board here/);
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  const bad = cli(['set', 'T-001', 'status=doing'], root);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /bad status/);
  assert.equal(cli(['task', 'new'], root).code, 1);
  assert.equal(cli(['nope'], root).code, 1);
  cli(['set', 'T-001', 'depends_on=T-404'], root);
  const v = cli(['validate'], root);
  assert.equal(v.code, 1);
  assert.match(v.out, /depends on unknown T-404/);
});

test('cli: task new rejects a non-numeric --order instead of storing NaN', () => {
  const { root } = setup();
  cli(['init'], root);
  const bad = cli(['task', 'new', '--title', 'x', '--order', 'first'], root);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /order must be a number/);
  assert.equal(fs.existsSync(path.join(pmDir(root), 'tasks', 'T-001.md')), false);
});

test('cli: concurrent task creation never reuses an id', async () => {
  const { root } = setup();
  cli(['init'], root);
  const run = (title) => new Promise((resolve) => {
    spawn(process.execPath, [PM, 'task', 'new', '--title', title], { cwd: root, env: process.env }).on('exit', resolve);
  });
  await Promise.all(Array.from({ length: 6 }, (_, i) => run(`t${i}`)));
  const files = fs.readdirSync(path.join(pmDir(root), 'tasks')).filter((f) => f.startsWith('T-'));
  assert.equal(files.length, 6);
  assert.equal(cli(['validate'], root).out, 'ok');
});
