import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
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
  const m = buildBoardModel(loadBoardSnapshot(board(), undefined, D));
  assert.equal(m.name, 'demo');
  assert.equal(m.hasEpics, true);
  assert.deepEqual(m.focus, ['A: ship A']);
  assert.deepEqual(Object.fromEntries(m.columns.map((c) => [c.key, c.cards.map((x) => x.id)])), {
    todo: [], ready: ['T-003'], in_progress: ['T-002'], waiting: [], done: ['T-001'],
  });
  assert.deepEqual(m.archive.done, []);
  assert.deepEqual(m.archive.epics.map((e) => [e.epic, e.updated, e.cards.map((c) => c.id)]), [['B', '2026-09-15', ['T-004']]], 'a closed epic keeps its done cards, not the dropped one');
  assert.deepEqual(m.epics, [{ key: 'A', open: 1, total: 2 }, { key: 'B', open: 0, total: 1 }], 'dropped tasks are not counted, as in pm epics');
  assert.deepEqual(m.decisions.map((d) => [d.id, d.tasks]), [['D-002', ['T-003', 'T-002']], ['D-001', ['T-002']]], 'newest first');
  assert.doesNotMatch(JSON.stringify(m), /<\w/, 'no markup in the model');
});

test('model card: details, deps with status, last log entries, decisions', () => {
  const m = buildBoardModel(loadBoardSnapshot(board(), undefined, D));
  const c = m.columns.find((x) => x.key === 'in_progress').cards[0];
  assert.deepEqual(c.deps, [{ id: 'T-001', status: 'done', onBoard: true }, { id: 'T-004', status: 'done', onBoard: true }]);
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
  const empty = buildBoardModel(loadBoardSnapshot(pm, undefined, D));
  assert.deepEqual([empty.hasEpics, empty.focus, empty.archive, empty.epics, empty.decisions], [false, [], { done: [], epics: [] }, [], []]);
  assert.ok(empty.columns.every((c) => c.cards.length === 0));
  newTask(pm, { title: 'bare', date: D });
  const t = readTask(pm, 'T-001');
  t.body = 'free text\n';
  writeTask(t);
  appendLogLine(pm, 'T-001', '- note', D);
  const c = buildBoardModel(loadBoardSnapshot(pm, undefined, D)).columns.find((x) => x.key === 'ready').cards[0];
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

const html = (pm) => renderBoardHtml(buildBoardModel(loadBoardSnapshot(pm, undefined, D)), '2026-09-16 12:00');

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
  assert.match(h, /<p class="generated">generated 2026-09-16 12:00<\/p><details class="focus" open><summary>Focus · 1<\/summary><ul><li>A: ship A<\/li><\/ul><\/details>/);
  // On a phone the work in hand comes before the backlog.
  assert.match(h, /@media \(max-width:720px\)\{[^}]*\}[^@]*\.col\[data-col=in_progress\]\{order:-1\}\.col\[data-col=todo\]\{order:1\}/);
  assert.match(h, /<details class="card" id="T-002" data-epic="A" data-col="in_progress"><summary><b>T-002<\/b>/);
  assert.match(h, /<h3>Goal<\/h3><div class="text">goal text<\/div><h3>Understanding<\/h3><div class="text">line 1\nline 2<\/div>/);
  assert.match(h, /<h3>Log · last 3<\/h3>/);
  assert.match(h, /after <a href="#T-001">T-001<\/a>, <a href="#T-004">T-004<\/a>/, 'an archived card is a link too');
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

test('model: Done keeps the last 5 closed within 20 days, older done cards go to the Archive newest first', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'open', epic: 'A', date: D });
  for (const day of ['2026-08-01', '2026-08-27', '2026-08-28', D, D, D, D, D, D]) {
    setFields(pm, newTask(pm, { title: day, epic: 'A', date: D }).id, { status: 'done' }, day);
  }
  const m = buildBoardModel(loadBoardSnapshot(pm, undefined, D));
  assert.deepEqual(m.columns.find((c) => c.key === 'done').cards.map((c) => c.id), ['T-006', 'T-007', 'T-008', 'T-009', 'T-010'], 'the last 5 by order');
  assert.deepEqual(m.archive.done.map((c) => [c.id, c.updated]), [['T-005', D], ['T-004', '2026-08-28'], ['T-003', '2026-08-27'], ['T-002', '2026-08-01']], 'newest first');
  const h = renderBoardHtml(m);
  assert.match(h, /<details class="archive"><summary>Archive · 4<\/summary><details class="group" data-key=""><summary>Done earlier · 4<\/summary><div class="cards"><details class="card" id="T-005"/);
  assert.match(h, /<span>closed 2026-08-01<\/span>/, 'a done card shows its closing date');
  assert.equal(h.match(/id="T-002"/g).length, 1);
});

test('model: a done card is fresh up to exactly 20 days, older ones leave Done even under the cap', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'open', epic: 'A', date: D });
  setFields(pm, newTask(pm, { title: 'old', epic: 'A', date: D }).id, { status: 'done' }, '2026-08-26');
  setFields(pm, newTask(pm, { title: 'edge', epic: 'A', date: D }).id, { status: 'done' }, '2026-08-27');
  const m = buildBoardModel(loadBoardSnapshot(pm, undefined, D));
  assert.deepEqual(m.columns.find((c) => c.key === 'done').cards.map((c) => c.id), ['T-003']);
  assert.deepEqual(m.archive.done.map((c) => c.id), ['T-002']);
});

test('model: Done picks the 5 latest by closing date, not by order; no date ages out; a bad today ages nothing', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'open', epic: 'A', date: D });
  for (const day of [D, '2026-09-01', '2026-09-01', '2026-09-01', '2026-09-01', '2026-09-01']) {
    setFields(pm, newTask(pm, { title: day, epic: 'A', date: D }).id, { status: 'done' }, day);
  }
  const t = readTask(pm, 'T-003');
  delete t.data.updated;
  writeTask(t);
  const m = buildBoardModel(loadBoardSnapshot(pm, undefined, D));
  assert.deepEqual(m.columns.find((c) => c.key === 'done').cards.map((c) => c.id), ['T-002', 'T-004', 'T-005', 'T-006', 'T-007'], 'the lowest order closed today stays');
  assert.deepEqual(m.archive.done.map((c) => c.id), ['T-003'], 'a done task without a date is not fresh');
  const bad = buildBoardModel(loadBoardSnapshot(pm, undefined, '18.09.2026'));
  assert.equal(bad.columns.find((c) => c.key === 'done').cards.length, 5, 'still capped, nothing thrown');
});

test('html: empty states', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  let h = html(pm);
  assert.match(h, /No tasks yet/);
  assert.match(h, /No focus set/);
  assert.match(h, /No epics:/);
  assert.match(h, /No decisions yet/);
  assert.doesNotMatch(h, /id="group"/);
  setFields(pm, newTask(pm, { title: 'x', date: D }).id, { status: 'dropped' }, D);
  assert.match(html(pm), /Every task is dropped\./);
  setFields(pm, newTask(pm, { title: 'y', epic: 'A', date: D }).id, { status: 'done' }, D);
  h = html(pm);
  assert.match(h, /Nothing open: every epic is closed, see Archive\./);
  assert.doesNotMatch(h, /No epics:|id="group"/);
  newTask(pm, { title: 'z', date: D });
  assert.match(html(pm), /<div class="cards"><\/div>/, 'an empty column is marked by css');
});

test('html: every board reloads itself keeping the hash and the open <details>; meta refresh only without JS', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'plain', date: D });
  for (const h of [html(board()), html(pm)]) {
    assert.match(h, /<head><meta charset="utf-8"><noscript><meta http-equiv="refresh" content="10"><\/noscript>/);
    assert.match(h, /location\.reload\(\)/);
    assert.match(h, /sessionStorage/);
  }
});

// The page script runs in node:vm against a DOM stub: just enough document, storage and timers for the refresh and persistence paths.
const pageScript = (h) => h.match(/<script>([\s\S]*?)<\/script>/)[1];
const node = (props, lane) => ({ id: '', className: '', dataset: {}, open: false, closest: (s) => (s === '.lane' ? lane ?? null : null), ...props });
function runPage(src, { stored = null, details = [], storage } = {}) {
  const calls = [];
  const ctx = {
    document: { getElementById: () => null, querySelectorAll: (s) => (s === 'details' ? details : []), addEventListener() {} },
    location: { pathname: '/pm/board.html', hash: '', reload() {} },
    sessionStorage: storage ?? { getItem: () => stored, setItem: (k, v) => calls.push(['set', k, JSON.parse(v)]) },
    addEventListener: (ev, fn) => { if (ev === 'pagehide') ctx.pagehide = fn; },
    setTimeout: (fn, ms) => calls.push(['timeout', ms]),
    scrollTo: (x, y) => calls.push(['scroll', y]),
    scrollY: 42,
    history: {},
  };
  vm.runInNewContext(src, ctx);
  return { calls, ctx };
}

test('page script: runs on an empty board and schedules the reload first', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  assert.deepEqual(runPage(pageScript(html(pm))).calls, [['timeout', 10000]]);
});

test('page script: restores and saves <details> by keys that keep the board and the No epic lane apart', () => {
  const card = node({ id: 'T-001' });
  const boardCol = node({ className: 'col', dataset: { col: 'todo' }, open: true });
  const laneCol = node({ className: 'col', dataset: { col: 'todo' }, open: true }, { dataset: { epic: '' } });
  const group = node({ className: 'group', dataset: { key: 'A' } });
  const open = { 'T-001': true, 'board|col|todo|': false, 'lane:|col|todo|': true, 'board|group||A': true };
  const { calls, ctx } = runPage(pageScript(html(board())), { stored: JSON.stringify({ open, y: 100 }), details: [card, boardCol, laneCol, group] });
  assert.deepEqual([card.open, boardCol.open, laneCol.open, group.open], [true, false, true, true]);
  assert.deepEqual(calls.slice(0, 2), [['timeout', 10000], ['scroll', 100]]);
  ctx.pagehide();
  assert.deepEqual(calls.at(-1), ['set', 'pm-board:/pm/board.html', { open, y: 42 }]);
});

test('page script: broken or blocked sessionStorage never stops the reload', () => {
  const src = pageScript(html(board()));
  for (const stored of ['{bad', '{"y":5}', '42']) {
    const { calls, ctx } = runPage(src, { stored, details: [node({ id: 'T-001' })] });
    assert.deepEqual(calls[0], ['timeout', 10000], stored);
    assert.doesNotThrow(() => ctx.pagehide());
  }
  const denied = () => { throw new Error('denied'); };
  const { calls, ctx } = runPage(src, { storage: { getItem: denied, setItem: denied } });
  assert.doesNotThrow(() => ctx.pagehide());
  assert.deepEqual(calls, [['timeout', 10000]]);
});
