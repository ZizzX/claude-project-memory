import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';
import { parse } from '../scripts/lib/frontmatter.mjs';
import { CAP } from '../scripts/lib/learn.mjs';

const today = new Date().toLocaleDateString('sv-SE');
const learning = (root, id) => fs.readFileSync(path.join(pmDir(root), 'learnings', `${id}.md`), 'utf8');
const task = (root, id) => fs.readFileSync(path.join(pmDir(root), 'tasks', `${id}.md`), 'utf8');
const config = (root) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(pmDir(root), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
};

function board(n = 2) {
  const { root } = setup();
  cli(['init'], root);
  for (let i = 0; i < n; i += 1) cli(['task', 'new', '--title', `t${i}`], root);
  return root;
}

const add = (root, extra = []) =>
  cli(['learn', 'add', '--title', 'CI translation keys fail while local passes', '--pattern', 'i18n.missing-key-in-ci',
    '--symptom', 'Unable to find <key> in the DOM only in CI', '--fix', 'rebuild locales before e2e', '--apply', 'run pnpm locales:build first', ...extra], root);

test('learn add creates L-001 with the three sections and a retro line on the task', () => {
  const root = board();
  const r = add(root, ['--tasks', 'T-001']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^L-001 recorded/);
  const text = learning(root, 'L-001');
  const { data, body } = parse(text);
  assert.equal(data.id, 'L-001');
  assert.equal(data.pattern, 'i18n.missing-key-in-ci');
  assert.equal(data.status, 'active');
  assert.equal(data.seen, '1');
  assert.equal(data.first, today);
  assert.equal(data.last, today);
  assert.deepEqual(data.tasks, ['T-001']);
  assert.match(body, /## Symptom\nUnable to find <key> in the DOM only in CI\n\n## Fix\nrebuild locales before e2e\n\n## Apply\nrun pnpm locales:build first\n/);
  assert.match(task(root, 'T-001'), new RegExp(`^- ${today} · [^·]+ · retro: L-001$`, 'm'));
});

test('learn add with a known pattern bumps seen and unions tasks', () => {
  const root = board();
  add(root, ['--tasks', 'T-001']);
  const r = cli(['learn', 'add', '--title', 'other words', '--pattern', 'i18n.missing-key-in-ci', '--tasks', 'T-002'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^L-001 seen 2 \(T-001, T-002\) — same lesson; edit the Fix if it changed/);
  assert.ok(!fs.existsSync(path.join(pmDir(root), 'learnings', 'L-002.md')));
  assert.match(task(root, 'T-002'), /retro: L-001$/m);
});

test('repeat on the same day is a no-op', () => {
  const root = board();
  add(root, ['--tasks', 'T-001']);
  const r = add(root, ['--tasks', 'T-001']);
  assert.match(r.out, /already recorded today/);
  assert.equal(parse(learning(root, 'L-001')).data.seen, '1');
  assert.equal(task(root, 'T-001').split('retro: L-001').length, 2, 'one retro line');
});

test('a retired learning is reactivated, a promoted one is not written', () => {
  const root = board();
  add(root);
  cli(['learn', 'retire', 'L-001', '--why', 'locales moved'], root);
  assert.equal(parse(learning(root, 'L-001')).data.status, 'retired');
  const r = add(root);
  assert.match(r.out, /L-001 reactivated/);
  assert.equal(parse(learning(root, 'L-001')).data.status, 'active');
  assert.equal(parse(learning(root, 'L-001')).data.retired_why, '');
  cli(['learn', 'promote', 'L-001', '--to', 'CLAUDE.md#i18n'], root);
  const p = add(root);
  assert.match(p.out, /L-001 is promoted to CLAUDE\.md#i18n — nothing written/);
  assert.equal(parse(learning(root, 'L-001')).data.status, 'promoted');
});

test('bad pattern is refused', () => {
  const root = board();
  const r = cli(['learn', 'add', '--title', 'x', '--pattern', 'NoDots'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /pattern must look like area\.symptom/);
});

test('similar patterns are hinted', () => {
  const root = board();
  add(root);
  const r = cli(['learn', 'add', '--title', 'another i18n thing', '--pattern', 'i18n.plural-forms'], root);
  assert.match(r.out, /^L-002 recorded/);
  assert.match(r.out, /similar: L-001 i18n\.missing-key-in-ci/);
});

test('learn find matches title, pattern and body; list shows active only', () => {
  const root = board();
  add(root);
  cli(['learn', 'add', '--title', 'Flaky e2e', '--pattern', 'e2e.flaky-login', '--fix', 'retry once'], root);
  cli(['learn', 'retire', 'L-002', '--why', 'fixed upstream'], root);
  assert.match(cli(['learn', 'find', 'locales'], root).out, /^L-001 /);
  assert.match(cli(['learn', 'find', 'MISSING-KEY'], root).out, /^L-001 /);
  assert.equal(cli(['learn', 'find', 'nothing-like-this'], root).out, '(no match)');
  assert.match(cli(['learn', 'list'], root).out, /^L-001 · seen 1 · \d{4}-\d\d-\d\d · CI translation keys fail while local passes$/);
  assert.match(cli(['learn', 'list', '--all'], root).out, /L-002 · retired/);
  assert.match(cli(['learn', 'show', 'L-001'], root).out, /## Apply/);
});

test('learn none writes the checkpoint; learn check reports missing ids and exits 1', () => {
  const root = board(3);
  cli(['set', 'T-003', 'status=done'], root);
  const r = cli(['learn', 'check', 'T-001,T-002'], root);
  assert.equal(r.code, 1);
  assert.equal(r.out, 'no retro today: T-001, T-002 — pm learn add … --tasks <id> or pm learn none <id>');
  cli(['learn', 'none', 'T-001'], root);
  cli(['learn', 'none', 'T-003'], root);
  assert.match(task(root, 'T-001'), new RegExp(`^- ${today} · [^·]+ · retro: none$`, 'm'));
  assert.match(task(root, 'T-003'), /retro: none$/m, 'a closed task can take the checkpoint');
  assert.equal(cli(['learn', 'check', 'T-001,T-003'], root).out, 'ok');
  assert.equal(cli(['learn', 'check', 'T-001,T-002'], root).code, 1);
});

test('cap refuses the next learning past CAP', () => {
  const root = board(1);
  const dir = path.join(pmDir(root), 'learnings');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= CAP; i += 1) {
    const id = `L-${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\nid: ${id}\ntitle: t${i}\npattern: a.b${i}\nstatus: active\nseen: 1\nfirst: 2026-01-01\nlast: 2026-01-01\ntasks: []\npromoted_to: ""\nretired_why: ""\n---\n## Symptom\n\n## Fix\n\n## Apply\n`);
  }
  const r = cli(['learn', 'add', '--title', 'one more', '--pattern', 'z.z'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`${CAP} active learnings — retire or promote first`));
});

test('promotion hint at seen 3 across 2 tasks', () => {
  const root = board(3);
  add(root, ['--tasks', 'T-001']);
  assert.doesNotMatch(add(root, ['--tasks', 'T-002']).out, /promote\?/);
  const r = add(root, ['--tasks', 'T-003']);
  assert.match(r.out, /promote\? pm learn promote L-001 --to <file#section>/);
});

test('title with colon round-trips', () => {
  const root = board(1);
  cli(['learn', 'add', '--title', 'Ошибка: ключ #42 не найден', '--pattern', 'i18n.key-42'], root);
  assert.equal(parse(learning(root, 'L-001')).data.title, 'Ошибка: ключ #42 не найден');
  assert.match(cli(['learn', 'list'], root).out, /Ошибка: ключ #42 не найден/);
});

test('retroSince is written once', () => {
  const root = board(1);
  assert.equal(config(root).retroSince, undefined);
  cli(['learn', 'none', 'T-001'], root);
  assert.equal(config(root).retroSince, today);
  fs.writeFileSync(path.join(pmDir(root), 'config.json'), JSON.stringify({ ...config(root), retroSince: '2026-01-01' }));
  add(root);
  assert.equal(config(root).retroSince, '2026-01-01');
});

test('a learning with partial frontmatter does not break summary, add or audit', () => {
  const root = board(1);
  const dir = path.join(pmDir(root), 'learnings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'L-001.md'), '---\nid: L-001\ntitle: hand-written\nstatus: active\n---\n## Symptom\nx\n');
  fs.writeFileSync(path.join(dir, 'L-002.md'), '---\nid: L-002\ntitle: also by hand\npattern: a.c\nstatus: active\n---\n');
  const s = cli(['summary'], root);
  assert.match(s.out, /\nRules:/, s.err);
  assert.match(cli(['learn', 'add', '--title', 'y', '--pattern', 'a.b'], root).out, /^L-003 recorded/);
  const a = cli(['audit'], root);
  assert.equal(a.code, 0);
  assert.doesNotMatch(a.out, /undefined/);
});

test('unknown task in --tasks writes nothing', () => {
  const root = board(1);
  const r = cli(['learn', 'add', '--title', 'x', '--pattern', 'a.b', '--tasks', 'T-009'], root);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown task T-009/);
  assert.ok(!fs.existsSync(path.join(pmDir(root), 'learnings', 'L-001.md')));
  add(root, ['--tasks', 'T-001']);
  const bad = add(root, ['--tasks', 'T-009']);
  assert.equal(bad.code, 1);
  assert.equal(parse(learning(root, 'L-001')).data.seen, '1');
});
