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

test('cli: pm prefix shows and sets the task id prefix, committed to the board', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'old'], root);
  assert.equal(cli(['prefix'], root).out, 'T');
  assert.equal(cli(['prefix', 'PM'], root).out, 'task prefix: PM — new tasks start at PM-002');
  assert.equal(cli(['prefix'], root).out, 'PM');
  assert.match(cli(['task', 'new', '--title', 'new', '--deps', 'T-001'], root).out, /^PM-002 created/);
  assert.match(sh(['log', '--format=%s'], pmDir(root)), /pm: prefix PM/);
  const bad = cli(['prefix', 'pm'], root);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /bad prefix/);
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

test('cli: help lists the commands and the phrases to say, and exits 0', () => {
  const { root } = setup();
  for (const arg of ['help', '--help', '-h']) {
    const r = cli([arg], root);
    assert.equal(r.code, 0, arg);
    assert.match(r.out, /^usage: pm <command>\n/);
    assert.match(r.out, /ready \[--epic KEY \| --all\]/);
    assert.match(r.out, /"what's next\?"/);
    assert.match(r.out, /Protocol Claude follows: \/pm/);
  }
  assert.equal(cli([], root).code, 1, 'no command is still a usage error');
  for (const args of [['init', '--help'], ['ready', '-h'], ['task', 'new', '--help']]) {
    const r = cli(args, root);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.out, /^usage: pm <command>\n/, args.join(' '));
  }
  assert.equal(fs.existsSync(pmDir(root)), false, '`pm init --help` must not create a board');
});

test('pm ready lists the next task first', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['task', 'new', '--title', 'b'], root);
  cli(['next', 'T-002'], root);
  assert.match(cli(['ready'], root).out, /^T-002 b ← next\nT-001 a$/m);
});

test('pm help names learn, next, audit and the close phrases', () => {
  const { root } = setup();
  const { out } = cli(['help'], root);
  for (const re of [/^\s+learn add /m, /^\s+next \[/m, /^\s+audit \[--fix\]/m, /\/close/, /"what did we learn"/, /"слил"/]) assert.match(out, re);
});

test('pm task new records when and from what a task was created; pm show reads both ways', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'parent'], root);
  const child = cli(['task', 'new', '--title', 'child', '--from', 'T-001'], root);
  assert.equal(child.code, 0, child.err);
  const file = fs.readFileSync(path.join(pmDir(root), 'tasks', 'T-002.md'), 'utf8');
  assert.match(file, /^created: \d{4}-\d{2}-\d{2}$/m);
  assert.match(file, /^from: T-001$/m);
  assert.doesNotMatch(file, /^depends_on: \[T-001\]/m, '--from is the origin, not a dependency');
  assert.match(cli(['show', 'T-002'], root).out, /^created: \d{4}-\d{2}-\d{2} · from: T-001$/m);
  assert.match(cli(['show', 'T-001'], root).out, /^spawned: T-002 \(todo\)$/m);
  const bad = cli(['task', 'new', '--title', 'orphan', '--from', 'T-999'], root);
  assert.equal(bad.code, 1);
  assert.equal(bad.err, '--from T-999: no such task — nothing created — pm ready --all lists tasks');
  assert.equal(fs.readdirSync(path.join(pmDir(root), 'tasks')).filter((f) => f.endsWith('.md')).length, 2, 'no id was reserved');
});

test('pm task new hints when this worktree is busy, or when the title reads like a reminder; never blocks', () => {
  const { root } = setup();
  cli(['init'], root);
  const quiet = cli(['task', 'new', '--title', 'a'], root);
  assert.equal(quiet.out.split('\n').length, 1, 'nothing in progress here');
  cli(['task', 'new', '--title', 'b'], root);
  cli(['claim', 'T-002'], root);
  cli(['claim', 'T-001'], root);
  const busy = cli(['task', 'new', '--title', 'c'], root);
  assert.equal(busy.code, 0);
  assert.equal(busy.out.split('\n')[1], 'hint: T-001 is in progress here — a finding of that work: fix it now (ask first) or offer a separate session; --from T-001 records the origin. Skip this if the user asked for the task.', 'the lowest id');
  assert.match(cli(['task', 'new', '--title', 'd', '--epic', 'A'], root).out, /\nhint: T-001 is in progress here/, '--epic alone does not quiet it');
  for (const extra of [['--from', 'T-001'], ['--deps', 'T-001']]) {
    assert.equal(cli(['task', 'new', '--title', 'e', ...extra], root).out.split('\n').length, 1, `quiet with ${extra[0]}`);
  }
  const reminder = cli(['task', 'new', '--title', 'Remove the SEARCH_V2 flag after the prod tag', '--from', 'T-001'], root);
  assert.equal(reminder.code, 0);
  assert.equal(reminder.out.split('\n')[1], 'hint: "Remove the SEARCH_V2 flag after the prod tag" reads like a reminder — a wait inside a task is its status (waiting / review), not a new task. Skip this if the user asked for the task.');
});
