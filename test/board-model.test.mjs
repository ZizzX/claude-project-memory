import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmp } from './helpers.mjs';
import { newTask, setFields, claim, appendLog, appendLogLine, readTask, writeTask } from '../scripts/lib/tasks.mjs';
import { planFile, planTemplate } from '../scripts/lib/plan.mjs';
import { appendDecision, decisionsFile } from '../scripts/lib/decisions.mjs';
import { loadBoardSnapshot, buildBoardModel, renderBoardHtml, writeBoard } from '../scripts/lib/board.mjs';

const D = '2026-09-16';

function board() {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D).replace('## Current focus\n', '## Current focus\n- A: ship A\n'));
  fs.writeFileSync(decisionsFile(pm), '# Decisions\n');
  newTask(pm, { title: 'a-done', epic: 'A', date: D });
  setFields(pm, 'T-001', { status: 'done' }, D);
  newTask(pm, { title: 'a-work', epic: 'A', deps: ['T-001', 'T-004'], date: D });
  newTask(pm, { title: 'plain', date: D });
  newTask(pm, { title: 'b-closed', epic: 'B', date: D });
  setFields(pm, 'T-004', { status: 'done' }, '2026-09-15');
  claim(pm, 'T-002', 'wt', D, 'feat/T-002/x');
  setFields(pm, 'T-002', { pr: 'https://example.com/pr/1' }, D);
  const t = readTask(pm, 'T-002');
  t.body = '## Goal\ngoal text\n\n## Understanding\nline 1\nline 2\n\n## Checklist\n- [ ] one\n\n## Log\n';
  writeTask(t);
  for (const n of [1, 2, 3, 4]) appendLog(pm, 'T-002', { worktree: 'wt', did: `d${n}`, next: `n${n}`, date: D });
  newTask(pm, { title: 'b-dropped', epic: 'B', date: D });
  setFields(pm, 'T-005', { status: 'dropped' }, D);
  appendDecision(pm, { title: 'first', why: 'w', rejected: 'r', tasks: ['T-002'], date: D });
  appendDecision(pm, { title: 'second', why: 'w', rejected: 'r', tasks: ['T-003', 'T-002'], date: D });
  return pm;
}

test('model: columns, archive, epics, focus and decisions from one snapshot', () => {
  const m = buildBoardModel(loadBoardSnapshot(board()));
  assert.equal(m.name, 'demo');
  assert.equal(m.hasEpics, true);
  assert.deepEqual(m.focus, ['A: ship A']);
  assert.deepEqual(Object.fromEntries(m.columns.map((c) => [c.key, c.cards.map((x) => x.id)])), {
    todo: [], ready: ['T-003'], in_progress: ['T-002'], waiting: [], done: ['T-001'],
  });
  assert.deepEqual(m.archive, [{ epic: 'B', done: 1, updated: '2026-09-15' }]);
  assert.deepEqual(m.epics, [{ key: 'A', open: 1, total: 2 }, { key: 'B', open: 0, total: 1 }], 'dropped tasks are not counted, as in pm epics');
  assert.deepEqual(m.decisions.map((d) => [d.id, d.tasks]), [['D-002', ['T-003', 'T-002']], ['D-001', ['T-002']]], 'newest first');
  assert.doesNotMatch(JSON.stringify(m), /<\w/, 'no markup in the model');
});

test('model card: details, deps with status, last log entries, decisions', () => {
  const m = buildBoardModel(loadBoardSnapshot(board()));
  const c = m.columns.find((x) => x.key === 'in_progress').cards[0];
  assert.deepEqual(c.deps, [{ id: 'T-001', status: 'done', onBoard: true }, { id: 'T-004', status: 'done', onBoard: false }]);
  assert.equal(c.goal, 'goal text');
  assert.equal(c.understanding, 'line 1\nline 2');
  assert.equal(c.checklist, '- [ ] one');
  assert.equal(c.log.length, 3);
  assert.match(c.log[2], /did: d4 · next: n4$/);
  assert.equal(c.next, 'n4');
  assert.equal(c.branch, 'feat/T-002/x');
  assert.equal(c.pr, 'https://example.com/pr/1');
  assert.deepEqual(c.worktrees, ['wt']);
  assert.deepEqual(c.decisions, ['D-001', 'D-002']);
  const done = m.columns.find((x) => x.key === 'done').cards[0];
  assert.deepEqual([done.next, done.goal, done.log, done.decisions, done.pr], ['', '', [], [], '']);
});

test('model: a task body without sections and an empty board', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  const empty = buildBoardModel(loadBoardSnapshot(pm));
  assert.deepEqual([empty.hasEpics, empty.focus, empty.archive, empty.epics, empty.decisions], [false, [], [], [], []]);
  assert.ok(empty.columns.every((c) => c.cards.length === 0));
  newTask(pm, { title: 'bare', date: D });
  const t = readTask(pm, 'T-001');
  t.body = 'free text\n';
  writeTask(t);
  appendLogLine(pm, 'T-001', '- note', D);
  const c = buildBoardModel(loadBoardSnapshot(pm)).columns.find((x) => x.key === 'ready').cards[0];
  assert.deepEqual([c.goal, c.log], ['', []]);
});

test('writeBoard replaces the views atomically and leaves no temp file', () => {
  const pm = board();
  writeBoard(pm);
  writeBoard(pm);
  assert.deepEqual(fs.readdirSync(pm).filter((f) => f.endsWith('.tmp')), []);
  assert.match(fs.readFileSync(`${pm}/board.html`, 'utf8'), /<\/html>\n$/);
});

test('writeBoard falls back to a plain write when the rename is refused', (t) => {
  const pm = board();
  writeBoard(pm);
  t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EPERM' });
  });
  fs.writeFileSync(`${pm}/board.html`, 'stale');
  writeBoard(pm);
  assert.match(fs.readFileSync(`${pm}/board.html`, 'utf8'), /<\/html>\n$/);
  assert.deepEqual(fs.readdirSync(pm).filter((f) => f.endsWith('.tmp')), []);
});

const html = (pm) => renderBoardHtml(buildBoardModel(loadBoardSnapshot(pm)), '2026-09-16 12:00');

test('html: task text is escaped, only an http(s) PR becomes a link', () => {
  const pm = board();
  const t = readTask(pm, 'T-003');
  t.body = '## Goal\n<script>alert(1)</script> "q" \'s\n\n## Log\n';
  writeTask(t);
  setFields(pm, 'T-003', { pr: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>' }, D);
  const h = html(pm);
  assert.equal(h.match(/<script>/g).length, 1, 'only the page script');
  assert.match(h, /<div class="text">&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;q&quot; &#39;s<\/div>/);
  assert.match(h, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(h, /href="javascript/);
  assert.match(h, /PR javascript:alert\(1\)/);
  assert.match(h, /PR <a href="https:\/\/example.com\/pr\/1" rel="noopener noreferrer">/);
});

test('html: header, expandable cards, dependency links, decisions and epic lanes', () => {
  const h = html(board());
  assert.match(h, /<p class="generated">generated 2026-09-16 12:00<\/p><ul class="focus"><li>A: ship A<\/li><\/ul>/);
  assert.match(h, /<details class="card" id="T-002" data-epic="A" data-col="in_progress"><summary><b>T-002<\/b>/);
  assert.match(h, /<h3>Goal<\/h3><div class="text">goal text<\/div><h3>Understanding<\/h3><div class="text">line 1\nline 2<\/div>/);
  assert.match(h, /<h3>Log · last 3<\/h3>/);
  assert.match(h, /after <a href="#T-001">T-001<\/a>, T-004 \(done\)/, 'a card not on the board is text with its status');
  assert.match(h, /branch <code>feat\/T-002\/x<\/code>/);
  assert.match(h, /<code>pm claim T-002<\/code>/);
  assert.doesNotMatch(h, /pm claim T-001/, 'no start command on a done card');
  assert.match(h, /<summary>Decisions · 2<\/summary><ul><li><b>D-002<\/b> · 2026-09-16 · second · <a href="#T-003">T-003<\/a>, <a href="#T-002">T-002<\/a><\/li>/);
  assert.equal(h.match(/id="T-002"/g).length, 1, 'one node per card');
  assert.match(h, /<section class="lane" data-epic="A"><h2 class="lane-head">A · 1 open of 2 · ship A<\/h2>/);
  assert.match(h, /<section class="lane" data-epic=""><h2 class="lane-head">No epic<\/h2>/);
  assert.doesNotMatch(h, /data-epic="B"><h2/, 'a closed epic has no lane');
  assert.match(h, /<button type="button" id="group" aria-pressed="false" hidden>/);
});

test('html: empty states', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  let h = html(pm);
  assert.match(h, /No tasks yet/);
  assert.match(h, /No focus set/);
  assert.match(h, /No epics:/);
  assert.match(h, /No decisions yet/);
  assert.doesNotMatch(h, /<script>|id="group"/);
  setFields(pm, newTask(pm, { title: 'x', date: D }).id, { status: 'dropped' }, D);
  assert.match(html(pm), /Every task is dropped\./);
  setFields(pm, newTask(pm, { title: 'y', epic: 'A', date: D }).id, { status: 'done' }, D);
  h = html(pm);
  assert.match(h, /Nothing open: every epic is closed, see Archive\./);
  assert.doesNotMatch(h, /No epics:|id="group"/);
  newTask(pm, { title: 'z', date: D });
  assert.match(html(pm), /<div class="cards"><\/div>/, 'an empty column is marked by css');
});

test('html: with the script the page reloads itself, keeping the hash; without it meta refresh stays', () => {
  const h = html(board());
  assert.match(h, /<noscript><meta http-equiv="refresh" content="10"><\/noscript>/);
  assert.match(h, /location\.reload\(\)/);
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'plain', date: D });
  assert.match(html(pm), /<head><meta charset="utf-8"><meta http-equiv="refresh" content="10">/);
});
