import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmp, setup, cli } from './helpers.mjs';
import { newTask, listTasks, setFields, claim, readyQueue, byEpic, activeEpic } from '../scripts/lib/tasks.mjs';
import { planFile, planTemplate, projectName, currentFocus, focusList } from '../scripts/lib/plan.mjs';
import { appendDecision } from '../scripts/lib/decisions.mjs';
import { buildSummary } from '../scripts/lib/summary.mjs';
import { writeBoard, columns, archived } from '../scripts/lib/board.mjs';

const D = '2026-09-14';

// Same shape as test/queue.test.mjs: no epic key at all, like a task object from an older board.
function mk(id, data = {}) {
  return {
    id,
    file: `${id}.md`,
    body: '',
    data: { id, title: id, status: 'todo', order: Number(id.slice(2)), depends_on: [], worktrees: [], links: [], waiting_on: '', milestone: '', ...data },
  };
}

test('epic is a plain scalar field: empty by default, unquoted, trimmed on read', () => {
  const pm = tmp();
  newTask(pm, { title: 'plain', date: D });
  newTask(pm, { title: 'tagged', epic: 'ATS-1224', date: D });
  assert.match(fs.readFileSync(`${pm}/tasks/T-001.md`, 'utf8'), /\nupdated: 2026-09-14\nepic: ""\n---\n/, 'last field, like a migrated file');
  assert.match(fs.readFileSync(`${pm}/tasks/T-002.md`, 'utf8'), /\nepic: ATS-1224\n/);
  setFields(pm, 'T-001', { epic: 'ATS-1224 ' }, D);
  assert.deepEqual(listTasks(pm).map((t) => t.data.epic), ['ATS-1224', 'ATS-1224']);
});

test('byEpic: an empty task epic is repo-wide, a foreign epic is hidden, no epic means no filter', () => {
  const tasks = [mk('T-001', { epic: 'A' }), mk('T-002', { epic: 'B' }), mk('T-003', { epic: '' }), mk('T-004')];
  assert.deepEqual(byEpic(tasks, 'A').map((t) => t.id), ['T-001', 'T-003', 'T-004']);
  assert.equal(byEpic(tasks, ''), tasks);
});

test('the epic filter runs after readyQueue so a cross-epic dependency on a done task still counts', () => {
  const all = [mk('T-001', { epic: 'B', status: 'done' }), mk('T-002', { epic: 'A', depends_on: ['T-001'] })];
  assert.deepEqual(byEpic(readyQueue(all), 'A').map((t) => t.id), ['T-002']);
  assert.deepEqual(readyQueue(byEpic(all, 'A')), [], 'filtering first would hide the satisfied dependency');
});

test('activeEpic comes from the claims of this worktree', () => {
  const pm = tmp();
  for (const [title, epic] of [['a', 'A'], ['b', 'A'], ['shared', ''], ['c', 'B']]) newTask(pm, { title, epic, date: D });
  assert.equal(activeEpic(listTasks(pm), 'wt'), '', 'nothing claimed');
  claim(pm, 'T-001', 'wt', D);
  claim(pm, 'T-003', 'wt', D);
  assert.equal(activeEpic(listTasks(pm), 'wt'), 'A', 'a repo-wide task does not blur the epic');
  claim(pm, 'T-004', 'wt', D);
  assert.equal(activeEpic(listTasks(pm), 'wt'), '', 'two open epics: no filter');
  setFields(pm, 'T-004', { status: 'done' }, D);
  assert.equal(activeEpic(listTasks(pm), 'wt'), 'A', 'open tasks win over done ones');
  setFields(pm, 'T-001', { status: 'done' }, D);
  assert.equal(activeEpic(listTasks(pm), 'wt'), '', 'nothing open with an epic, two epics claimed: ambiguous');
  setFields(pm, 'T-004', { worktrees: [] }, D);
  assert.equal(activeEpic(listTasks(pm), 'wt'), 'A', 'all done, one epic: the worktree still remembers it');
  assert.equal(activeEpic([mk('T-009', { status: 'in_progress', worktrees: ['wt'] })], 'wt'), '', 'objects without an epic key');
  assert.equal(activeEpic(listTasks(pm), null), '', 'no worktree');
});

test('currentFocus: one line per epic, nothing leaks to a worktree without an epic', () => {
  const pm = tmp();
  const plan = (focus) => fs.writeFileSync(planFile(pm), planTemplate('demo', D).replace('## Current focus\n', `## Current focus\n${focus}`));
  plan('- ATS-1224: stop list\n- ATS-3049: limits\n');
  assert.equal(currentFocus(pm, 'ATS-1224'), 'stop list');
  assert.equal(currentFocus(pm, 'ATS-3049'), 'limits');
  assert.equal(currentFocus(pm, 'ATS-9999'), '');
  assert.equal(currentFocus(pm), '', 'no epic: no foreign focus');
  assert.deepEqual(focusList(pm), ['ATS-1224: stop list', 'ATS-3049: limits']);
  const keys = new Set(['ATS-1224']);
  assert.equal(currentFocus(pm, 'ATS-1224', keys), 'stop list');
  assert.deepEqual(focusList(pm, keys), ['ATS-1224: stop list'], 'a key no task carries is not an epic line');
  plan('M1 core\n');
  assert.equal(currentFocus(pm), 'M1 core', 'old single-line format');
  assert.equal(currentFocus(pm, 'ATS-1'), 'M1 core', 'without keyed lines the plain focus goes to every epic');
  assert.deepEqual(focusList(pm), ['M1 core']);
  plan('- M1: core\n');
  assert.equal(currentFocus(pm, '', new Set()), '- M1: core', 'on a board without epics a key-looking line is still the plain focus, verbatim');
  assert.equal(currentFocus(pm, 'A', new Set(['A'])), '- M1: core', 'a key no task carries is plain text for every epic');
  plan('- Стоп-лист: overview\n');
  assert.equal(currentFocus(pm), '- Стоп-лист: overview', 'a non-ASCII key is prose, not an epic');
  assert.equal(currentFocus(tmp()), '');
  assert.deepEqual(focusList(tmp()), []);
});

test('currentFocus on a hand-written PLAN.md: comments, paragraphs and direction sections', () => {
  const pm = tmp();
  const live = [
    '# ATS', '', '> shared board, add your own line below', '', '## Goal', 'repo goal', '', '## Current focus', '',
    'Stop list: MR !486 in review. Other directions — own lines below.', '',
    '<!-- The first line above goes into every summary.', '     Keep it one line. -->', '',
    '**Stop list (ATS-1224).** T-004 committed, next T-005.', '', '## Links', '- jira', '',
  ];
  fs.writeFileSync(planFile(pm), live.join('\n'));
  assert.equal(currentFocus(pm), 'Stop list: MR !486 in review. Other directions — own lines below.');
  assert.equal(currentFocus(pm, 'ATS-1224'), currentFocus(pm), 'no keyed lines yet: the plain line is everyone\'s');
  fs.appendFileSync(planFile(pm), ['# Direction: limits', '', '## Goal', 'x', '', '## Current focus', '- ATS-3049: field limits', '', '## Milestones', '- M1: not a focus', ''].join('\n'));
  assert.equal(currentFocus(pm, 'ATS-3049'), 'field limits', 'a second section under an H1 is found');
  assert.equal(currentFocus(pm, 'M1'), '', 'lines of other sections are not focus lines');
  assert.equal(currentFocus(pm), '', 'once keys exist, the untagged line is not handed to strangers');
  assert.deepEqual(focusList(pm), ['ATS-3049: field limits']);
});

test('planTemplate hints are comments the parser ignores', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  assert.equal(projectName(pm), 'demo');
  assert.equal(currentFocus(pm), '');
  assert.deepEqual(focusList(pm), []);
  assert.match(fs.readFileSync(planFile(pm), 'utf8'), /One board per git repository/);
});

// Two directions on one board. A: T-002 ready (depends on B's done T-001), T-003/T-009 waiting, T-007 blocked
// by B's waiting T-005, T-008 ready. B: T-001 done, T-004 ready, T-005 waiting. T-006 is repo-wide.
function twoEpics() {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D).replace('## Current focus\n', '## Current focus\n- A: ship A\n- B: ship B\n'));
  newTask(pm, { title: 'b-done', epic: 'B', date: D });
  setFields(pm, 'T-001', { status: 'done' }, D);
  newTask(pm, { title: 'a-ready', epic: 'A', deps: ['T-001'], date: D });
  newTask(pm, { title: 'a-wait', epic: 'A', date: D });
  setFields(pm, 'T-003', { status: 'waiting', waiting_on: 'design' }, D);
  newTask(pm, { title: 'b-ready', epic: 'B', date: D });
  newTask(pm, { title: 'b-wait', epic: 'B', date: D });
  setFields(pm, 'T-005', { status: 'waiting', waiting_on: 'backend' }, D);
  newTask(pm, { title: 'shared', date: D });
  newTask(pm, { title: 'a-blocked', epic: 'A', deps: ['T-005'], date: D });
  newTask(pm, { title: 'a-next', epic: 'A', date: D });
  newTask(pm, { title: 'a-wait2', epic: 'A', date: D });
  setFields(pm, 'T-009', { status: 'waiting', waiting_on: 'legal' }, D);
  appendDecision(pm, { title: 'cross-cutting', why: 'w', rejected: 'r', date: D });
  return pm;
}

test('summary in a worktree with an epic: own focus, own queue, own blockers', () => {
  const pm = twoEpics();
  claim(pm, 'T-008', 'wt-a', D);
  const s = buildSummary({ pm, worktree: 'wt-a', scriptPath: 'x' });
  assert.match(s, /^\[pm\] demo · epic A · focus: ship A · board: /);
  assert.match(s, /\n  T-008 a-next \[in_progress\]\n/, 'no epic tag once the epic is known');
  assert.match(s, /\nReady: T-002 a-ready · T-006 shared · \+1 in other epics \(pm ready --all\)\n/, 'T-002 depends on a done task of B: the filter runs after readyQueue');
  assert.match(s, /\nWaiting: T-003 ← design · T-005 ← backend · T-009 ← legal\n/, 'B\'s T-005 is kept because T-007 of A depends on it');
  assert.match(s, /\nEpics: A 5\/5 · B 2\/3\n/);
  assert.match(s, /\nDecisions: D-001 cross-cutting\n/);
});

test('summary in a fresh worktree on a multi-epic board: no foreign focus, one task per direction', () => {
  const pm = twoEpics();
  const s = buildSummary({ pm, worktree: 'wt-new', scriptPath: 'x' });
  assert.match(s, /^\[pm\] demo · focus: — · board: /);
  assert.match(s, /no active task — take one from Ready, or say what to work on · a new direction: pm task new --epic <KEY>\n/);
  assert.match(s, /\nReady: T-002 a-ready \(A\) · T-004 b-ready \(B\) · T-006 shared\n/, 'T-008, the second ready task of A, is folded');
  assert.match(s, /\nWaiting: T-003 \(A\) ← design · T-005 \(B\) ← backend\n/, 'one waiting task per epic');
  for (const id of ['T-004', 'T-005']) setFields(pm, id, { status: 'done' }, D);
  assert.match(buildSummary({ pm, worktree: 'wt-new', scriptPath: 'x' }), /\nEpics: A 5\/5\n/, 'a closed epic leaves the Epics line');
});

test('summary on a board without epics is unchanged', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D).replace('## Current focus\n', '## Current focus\n- M1: core\n'));
  for (const title of ['one', 'two', 'three', 'four']) newTask(pm, { title, date: D });
  setFields(pm, 'T-004', { status: 'waiting', waiting_on: 'x' }, D);
  const s = buildSummary({ pm, worktree: 'wt', scriptPath: 'x' });
  assert.match(s, /^\[pm\] demo · focus: - M1: core · board: /, 'a key-looking focus line stays verbatim without epics');
  assert.match(s, /\nReady: T-001 one · T-002 two · T-003 three\n/);
  assert.match(s, /\nWaiting: T-004 ← x\n/);
  assert.doesNotMatch(s, /Epics:|--epic|other epics|\(M1\)/);
});

test('board views take the task list once and show the epic and the focus list', () => {
  const pm = twoEpics();
  const all = listTasks(pm);
  writeBoard(pm, all.filter((t) => t.id !== 'T-002'));
  const md = fs.readFileSync(`${pm}/BOARD.md`, 'utf8');
  assert.match(md, /^Focus: A: ship A · B: ship B$/m);
  assert.match(md, /- \*\*T-004\*\* b-ready · B\n/);
  assert.doesNotMatch(md, /\*\*T-002\*\*/, 'the passed list is rendered, not the directory');
  assert.match(fs.readFileSync(`${pm}/board.html`, 'utf8'), /<span class="tag">B<\/span>/);
});

test('board without epics: Done is neither capped nor aged, html has no archive block', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  for (let i = 0; i < 7; i += 1) setFields(pm, newTask(pm, { title: `d${i}`, date: D }).id, { status: 'done' }, '2026-01-01');
  writeBoard(pm, undefined, D);
  const md = fs.readFileSync(`${pm}/BOARD.md`, 'utf8');
  assert.match(md, /## Done \(7\)\n- \*\*T-001\*\* d0\n/);
  assert.doesNotMatch(md, /shown|Archive/);
  const html = fs.readFileSync(`${pm}/board.html`, 'utf8');
  assert.doesNotMatch(html, /class="archive"|id="lanes"|<script>/);
  assert.match(html, /<h2>Done · 7<\/h2>/);
});

test('archive: a closed epic moves its done cards into the Archive, they still satisfy dependencies', () => {
  const pm = tmp();
  fs.writeFileSync(planFile(pm), planTemplate('demo', D));
  newTask(pm, { title: 'a-done', epic: 'A', date: D });
  setFields(pm, 'T-001', { status: 'done' }, '2026-09-13');
  newTask(pm, { title: 'b-next', epic: 'B', deps: ['T-001'], date: D });
  newTask(pm, { title: 'c-dropped', epic: 'C', date: D });
  setFields(pm, 'T-003', { status: 'dropped' }, D);
  newTask(pm, { title: 'plain-done', date: D });
  setFields(pm, 'T-004', { status: 'done' }, D);
  newTask(pm, { title: 'a-older', epic: 'A', date: D });
  setFields(pm, 'T-005', { status: 'done' }, '2026-09-12');
  let tasks = listTasks(pm);
  assert.deepEqual([...archived(tasks)], [['A', '2026-09-13']], 'C is all dropped, the plain task has no epic, the latest date wins');
  const cols = columns(tasks, archived(tasks));
  assert.deepEqual(cols.ready.map((t) => t.id), ['T-002'], 'the hidden done task is still a satisfied dependency');
  assert.deepEqual(cols.done.map((t) => t.id), ['T-004']);
  writeBoard(pm, tasks, D);
  const md = fs.readFileSync(`${pm}/BOARD.md`, 'utf8');
  assert.match(md, /\n## Archive\n- A · 2 done · 2026-09-13\n$/);
  assert.doesNotMatch(md, /\*\*T-001\*\*|\*\*T-003\*\*|\*\*T-005\*\*/, 'BOARD.md keeps one line per closed epic');
  assert.match(md, /## Done \(1\)\n- \*\*T-004\*\* plain-done\n/);
  const html = fs.readFileSync(`${pm}/board.html`, 'utf8');
  assert.match(html, /<details class="archive"><summary>Archive · 2<\/summary><details class="group"><summary>A · 2 done · 2026-09-13<\/summary><div class="cards"><details class="card" id="T-001" data-epic="A" data-col="archive">/);
  assert.match(html, /id="T-005"/);
  assert.doesNotMatch(html, /id="T-003"/, 'a dropped task stays hidden');
  // One reopened task brings the epic back to the columns; the done cards past the latest 5 go to the Archive.
  for (let i = 0; i < 6; i += 1) setFields(pm, newTask(pm, { title: `a${i}`, epic: 'A', date: D }).id, { status: 'done' }, D);
  newTask(pm, { title: 'a-again', epic: 'A', date: D });
  tasks = listTasks(pm);
  assert.equal(archived(tasks).size, 0);
  writeBoard(pm, tasks, D);
  const md2 = fs.readFileSync(`${pm}/BOARD.md`, 'utf8');
  assert.match(md2, /## Done \(5\)\n- \*\*T-007\*\*/, 'latest stages shown');
  assert.match(md2, /\n## Archive\n- Done earlier · 4\n$/);
  assert.match(fs.readFileSync(`${pm}/board.html`, 'utf8'), /<h2>Done · 5<\/h2>/);
});

test('cli: --epic on task new, ready narrowed to the worktree epic, pm epics', () => {
  const { root } = setup();
  cli(['init'], root);
  assert.match(cli(['task', 'new', '--title', 'a1', '--epic', 'A'], root).out, /^T-001 created \(epic A, new epic\): /);
  assert.match(cli(['task', 'new', '--title', 'b1', '--epic', 'B'], root).out, /^T-002 created \(epic B, new epic\): /);
  assert.match(cli(['task', 'new', '--title', 'shared'], root).out, /^T-003 created: /);
  assert.equal(cli(['ready'], root).out, [
    '# no epic for this worktree yet — start yours with: pm task new --epic KEY',
    'T-001 a1 (A)', 'T-002 b1 (B)', 'T-003 shared',
  ].join('\n'));
  assert.equal(cli(['ready', '--epic', ' A '], root).out, '# epic A · pm ready --all for every direction\nT-001 a1\nT-003 shared', 'a repo-wide task is in every epic; the key is trimmed');
  assert.equal(cli(['ready', '--all'], root).out, 'T-001 a1 (A)\nT-002 b1 (B)\nT-003 shared');
  const unknown = cli(['ready', '--epic', 'C'], root);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown epic "C"/);
  assert.equal(cli(['ready', '--all', '--epic', 'A'], root).code, 1);
  cli(['claim', 'T-001'], root);
  assert.match(cli(['task', 'new', '--title', 'a2'], root).out, /^T-004 created \(epic A\): /, 'inherits the worktree epic');
  assert.match(cli(['task', 'new', '--title', 'wide', '--epic', ''], root).out, /^T-005 created: /, 'an explicit empty epic opts out');
  cli(['set', 'T-002', 'status=done'], root);
  cli(['task', 'new', '--title', 'a3', '--deps', 'T-002'], root);
  assert.equal(cli(['ready'], root).out, '# epic A · pm ready --all for every direction\nT-003 shared\nT-004 a2\nT-005 wide\nT-006 a3', 'T-006 depends on a done task of B');
  assert.equal(cli(['epics'], root).out, 'A · 3/3 open\nB · 0/1 open · closed\n(none) · 2/2 open');
  assert.match(cli(['summary'], root).out, /^\[pm\] [^\n]* · epic A · focus: — · board: /);
});

test('cli: a board without epics prints exactly what it printed before', () => {
  const { root } = setup();
  cli(['init'], root);
  assert.match(cli(['task', 'new', '--title', 'x'], root).out, /^T-001 created: /);
  assert.equal(cli(['ready'], root).out, 'T-001 x');
  assert.equal(cli(['ready', '--all'], root).out, 'T-001 x');
  assert.equal(cli(['epics'], root).out, '(no epics)');
});
