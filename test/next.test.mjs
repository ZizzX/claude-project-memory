import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

const read = (root, id) => fs.readFileSync(path.join(pmDir(root), 'tasks', `${id}.md`), 'utf8');
const today = new Date().toLocaleDateString('sv-SE');

test('pm next marks one todo task per epic and claim clears it', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a', '--epic', 'A'], root);
  cli(['task', 'new', '--title', 'b', '--epic', 'A'], root);
  cli(['task', 'new', '--title', 'c', '--epic', ''], root);

  const r1 = cli(['next', 'T-001'], root);
  assert.equal(r1.code, 0, r1.err);
  assert.match(r1.out, /T-001 ← next/);
  assert.match(read(root, 'T-001'), new RegExp(`^next: ${today}$`, 'm'));

  cli(['next', 'T-002'], root);
  assert.match(read(root, 'T-002'), /^next: /m);
  assert.doesNotMatch(read(root, 'T-001'), /^next: /m, 'one next per epic');

  cli(['next', 'T-003'], root);
  assert.match(read(root, 'T-002'), /^next: /m, 'a repo-wide task is its own group');
  assert.match(read(root, 'T-003'), /^next: /m);

  cli(['claim', 'T-002'], root);
  assert.doesNotMatch(read(root, 'T-002'), /^next: /m, 'claim clears next');

  const r2 = cli(['next', 'T-002'], root);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /only a todo task/);

  cli(['next', '--clear'], root);
  assert.doesNotMatch(read(root, 'T-003'), /^next: /m);
});

test('waiting_since follows the waiting status', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['set', 'T-001', 'status=waiting', 'waiting_on=x'], root);
  assert.match(read(root, 'T-001'), new RegExp(`^waiting_since: ${today}$`, 'm'));
  cli(['set', 'T-001', 'status=todo'], root);
  assert.doesNotMatch(read(root, 'T-001'), /^waiting_since: /m);
});

test('pm prefix --start continues numbering', () => {
  const { root } = setup();
  cli(['init'], root);
  const r = cli(['prefix', 'PM', '--start', '61'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PM-061/);
  assert.match(cli(['task', 'new', '--title', 'a'], root).out, /^PM-061 created/);
  assert.match(cli(['task', 'new', '--title', 'b'], root).out, /^PM-062 created/);
});

test('old files gain no fields', () => {
  const { root } = setup();
  cli(['init'], root);
  const file = path.join(pmDir(root), 'tasks', 'T-001.md');
  fs.writeFileSync(file, '---\nid: T-001\ntitle: old\nstatus: todo\norder: 1\ndepends_on: []\nwaiting_on: ""\nworktrees: []\nmilestone: ""\nlinks: []\nupdated: 2026-09-01\nepic: ""\n---\n## Goal\n\n## Log\n');
  cli(['set', 'T-001', 'order=2'], root);
  const text = read(root, 'T-001');
  assert.doesNotMatch(text, /^(next|waiting_since): /m);
});

test('an old waiting file gains no waiting_since on an unrelated edit', () => {
  const { root } = setup();
  cli(['init'], root);
  const file = path.join(pmDir(root), 'tasks', 'T-001.md');
  fs.writeFileSync(file, '---\nid: T-001\ntitle: old\nstatus: waiting\norder: 1\ndepends_on: []\nwaiting_on: api\nworktrees: []\nmilestone: ""\nlinks: []\nupdated: 2026-09-01\nepic: ""\n---\n## Goal\n\n## Log\n');
  cli(['set', 'T-001', 'order=2'], root);
  assert.doesNotMatch(read(root, 'T-001'), /^waiting_since: /m);
});

test('pm prefix --start without a key applies to the current prefix', () => {
  const { root } = setup();
  cli(['init'], root);
  const r = cli(['prefix', '--start', '61'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /T-061/);
  assert.match(cli(['task', 'new', '--title', 'a'], root).out, /^T-061 created/);
});
