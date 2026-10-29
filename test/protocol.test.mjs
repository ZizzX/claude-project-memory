import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, setup } from './helpers.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const shipped = () => {
  const files = ['README.md', 'README.ru.md'];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.(md|mjs|json)$/.test(e.name)) files.push(rel);
    }
  };
  for (const dir of ['commands', 'skills', 'scripts', 'hooks']) walk(dir);
  return files;
};

test('no shipped file tells the agent to file leftovers as tasks', () => {
  for (const rel of shipped()) {
    assert.doesNotMatch(read(rel), /file leftovers|every leftover becomes|leftovers as tasks|leftovers as `pm task new/i, rel);
  }
});

test('the triage rule lives in one SKILL.md row; done, close, retro and RULES point to it', () => {
  const skill = read('skills/pm/SKILL.md');
  assert.match(skill, /^\| Found something outside the task[^|]*\| .*Fix now\?.*pm later.*separate session.*pm task new … --from/m);
  assert.match(skill, /\| Wait inside this task \| `waiting` .*\| Declined finding \| `later#n`/s, 'the decision table');
  assert.match(skill, /Epic X: no open tracked tasks/);
  assert.doesNotMatch(skill, /create\/claim one/);
  for (const rel of ['commands/done.md', 'commands/close.md', 'skills/retro/SKILL.md']) {
    assert.match(read(rel), /outside the task[^\n]*(triage|\/pm)/i, rel);
  }
  assert.match(read('scripts/lib/summary.mjs'), /found something outside the task: fix it now \(ask first\) or offer a new session — a task only when the user says so/);
});

test('/close asks one batched question over the later items', () => {
  const close = read('commands/close.md');
  assert.match(close, /`pm later`/);
  assert.match(close, /one question/i);
  assert.match(close, /keep all \(default\)/);
  assert.match(close, /no open tracked tasks/);
});

test('pm help shows pm later and pm task new --from, each with an example', () => {
  const { root } = setup();
  const help = cli(['help'], root).out;
  assert.match(help, /^ {2}later <id> "<text>"/m);
  assert.match(help, /e\.g\. pm later T-012 "/);
  assert.match(help, /--from <id>.*not a dependency/);
  assert.match(help, /e\.g\. pm task new --title "[^"]+" --from T-012/);
});

test('a hint never makes the agent drop a task on its own; /close creates tasks before resolving the rest', () => {
  const skill = read('skills/pm/SKILL.md');
  assert.doesNotMatch(skill, /drop the task unless/);
  assert.match(skill, /`hint:` line[^|]*ask the user/);
  const close = read('commands/close.md');
  assert.ok(close.indexOf('--from <id> --later <n>') < close.indexOf('--keep'), 'tasks first, then keep/dismiss the rest');
});
