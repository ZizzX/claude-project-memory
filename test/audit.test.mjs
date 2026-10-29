import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, cli, sh, tmp, addWorktree } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';
import { runAudit, auditLine, AUDIT_DAYS, isEmptyTask } from '../scripts/lib/audit.mjs';
import { onSessionStart } from '../scripts/lib/hooks.mjs';
import { newTask, setFields, claim, appendLog, appendLogLine, setNext, writeConfig } from '../scripts/lib/tasks.mjs';
import { addLearning } from '../scripts/lib/learn.mjs';
import { appendDecision } from '../scripts/lib/decisions.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toLocaleDateString('sv-SE');
const codes = (r) => r.findings.map((f) => `${f.code} ${f.id}`);

function board() {
  const { root } = setup();
  cli(['init'], root);
  return { root, pm: pmDir(root) };
}

test('a fresh board is clean', () => {
  const { root, pm } = board();
  assert.deepEqual(runAudit({ pm, cwd: root, now: NOW }).findings, []);
  assert.equal(cli(['audit'], root).out, 'audit: clean');
});

test('stuck: in_progress whose last manual log line is old; auto lines do not count', () => {
  const { root, pm } = board();
  newTask(pm, { title: 'a', date: ago(40) });
  claim(pm, 'T-001', 'wt', ago(40));
  appendLog(pm, 'T-001', { worktree: 'wt', did: 'x', next: 'y', date: ago(20) });
  appendLogLine(pm, 'T-001', `- ${ago(1)} · wt · auto: changed files: a.js · last commit: none`, ago(1));
  newTask(pm, { title: 'fresh', date: ago(1) });
  claim(pm, 'T-002', 'wt', ago(1));
  appendLog(pm, 'T-002', { worktree: 'wt', did: 'x', next: 'y', date: ago(1) });
  newTask(pm, { title: 'no log', date: ago(30) });
  setFields(pm, 'T-003', { status: 'in_progress', worktrees: ['wt'] }, ago(30));
  assert.deepEqual(codes(runAudit({ pm, cwd: root, now: NOW })).filter((c) => c.startsWith('stuck')), ['stuck T-001', 'stuck T-003']);
});

test('waiting-long uses waiting_since, else updated', () => {
  const { root, pm } = board();
  newTask(pm, { title: 'a', date: ago(50) });
  setFields(pm, 'T-001', { status: 'waiting', waiting_on: 'api' }, ago(31));
  newTask(pm, { title: 'b', date: ago(50) });
  setFields(pm, 'T-002', { status: 'waiting', waiting_on: 'api' }, ago(5));
  newTask(pm, { title: 'old file', date: ago(50) });
  setFields(pm, 'T-003', { status: 'waiting', waiting_on: 'api' }, ago(31));
  const f = path.join(pm, 'tasks', 'T-003.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^waiting_since: .*\n/m, '')); // a 0.10 file
  assert.deepEqual(codes(runAudit({ pm, cwd: root, now: NOW })).filter((c) => c.startsWith('waiting')), ['waiting-long T-001', 'waiting-long T-003']);
});

test('review-no-pr and orphan', () => {
  const { root, pm } = board();
  newTask(pm, { title: 'a', date: ago(1) });
  setFields(pm, 'T-001', { status: 'review' }, ago(1));
  newTask(pm, { title: 'b', date: ago(1) });
  setFields(pm, 'T-002', { status: 'review', pr: 'https://github.com/o/r/pull/1' }, ago(1));
  newTask(pm, { title: 'c', date: ago(1) });
  setFields(pm, 'T-003', { status: 'in_progress' }, ago(1));
  const c = codes(runAudit({ pm, cwd: root, now: NOW }));
  assert.ok(c.includes('review-no-pr T-001'), c);
  assert.ok(!c.includes('review-no-pr T-002'), c);
  assert.ok(c.includes('orphan T-003'), c);
});

test('dead-worktree is fixed while sync is off, listed only when sync is on', () => {
  const { root, pm } = board();
  const live = path.basename(addWorktree(root, 'live'));
  newTask(pm, { title: 'a', date: ago(1) });
  setFields(pm, 'T-001', { status: 'in_progress', worktrees: [live, 'gone-wt'] }, ago(1));
  const r = runAudit({ pm, cwd: root, now: NOW });
  const f = r.findings.find((x) => x.code === 'dead-worktree');
  assert.equal(f.id, 'T-001');
  assert.match(f.text, /gone-wt/);
  assert.equal(f.fixable, true);
  const fixed = runAudit({ pm, cwd: root, now: NOW, fix: true });
  assert.ok(fixed.fixed.some((l) => /gone-wt/.test(l)), fixed.fixed);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), new RegExp(`^worktrees: \\[${live}\\]$`, 'm'));

  setFields(pm, 'T-001', { worktrees: [live, 'other-machine'] }, ago(1));
  sh(['remote', 'add', 'origin', tmp('pm-remote-')], pm);
  const synced = runAudit({ pm, cwd: root, now: NOW, fix: true });
  assert.equal(synced.findings.find((x) => x.code === 'dead-worktree').fixable, false);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), /other-machine/);
});

test('next-stale and state-old are fixed', () => {
  const { root, pm } = board();
  newTask(pm, { title: 'a', date: ago(40) });
  setNext(pm, 'T-001', ago(31));
  newTask(pm, { title: 'b', epic: 'B', date: ago(1) }); // another epic: its own next
  setNext(pm, 'T-002', ago(1));
  const f = path.join(pm, 'tasks', 'T-002.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('status: todo', 'status: dropped')); // next on a closed task, by hand
  fs.mkdirSync(path.join(pm, '.state'), { recursive: true });
  const old = path.join(pm, '.state', 'session-old.json');
  fs.writeFileSync(old, '{}');
  fs.utimesSync(old, new Date(NOW - 8 * DAY), new Date(NOW - 8 * DAY));
  const fresh = path.join(pm, '.state', 'session-fresh.json');
  fs.writeFileSync(fresh, '{}');
  const c = codes(runAudit({ pm, cwd: root, now: NOW }));
  assert.ok(c.includes('next-stale T-001') && c.includes('next-stale T-002') && c.includes('state-old session-old.json'), c);
  runAudit({ pm, cwd: root, now: NOW, fix: true });
  assert.ok(!fs.existsSync(old) && fs.existsSync(fresh));
  assert.doesNotMatch(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), /^next:/m);
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /^next:/m);
});

test('learnings: unused, promote, dup, cap', () => {
  const { root, pm } = board();
  for (let i = 1; i <= 3; i += 1) newTask(pm, { title: `t${i}`, date: ago(1) });
  addLearning(pm, { title: 'old', pattern: 'a.old', worktree: 'w', date: ago(91) });
  addLearning(pm, { title: 'hot', pattern: 'a.hot', tasks: ['T-001'], worktree: 'w', date: ago(3) });
  addLearning(pm, { title: 'hot', pattern: 'a.hot', tasks: ['T-002'], worktree: 'w', date: ago(2) });
  addLearning(pm, { title: 'hot', pattern: 'a.hot', tasks: ['T-003'], worktree: 'w', date: ago(1) });
  fs.copyFileSync(path.join(pm, 'learnings', 'L-002.md'), path.join(pm, 'learnings', 'L-003.md'));
  fs.writeFileSync(path.join(pm, 'learnings', 'L-003.md'), fs.readFileSync(path.join(pm, 'learnings', 'L-003.md'), 'utf8').replace('id: L-002', 'id: L-003'));
  const c = codes(runAudit({ pm, cwd: root, now: NOW }));
  assert.ok(c.includes('learning-unused L-001'), c);
  assert.ok(c.includes('learning-promote L-002'), c);
  assert.ok(c.includes('learning-dup a.hot'), c);
  for (let i = 4; i <= 81; i += 1) {
    const id = `L-${String(i).padStart(3, '0')}`;
    fs.writeFileSync(path.join(pm, 'learnings', `${id}.md`), `---\nid: ${id}\ntitle: t\npattern: c.n${i}\nstatus: active\nseen: 1\nfirst: ${ago(1)}\nlast: ${ago(1)}\ntasks: []\n---\n`);
  }
  assert.ok(codes(runAudit({ pm, cwd: root, now: NOW })).includes('learnings-cap 81'));
});

test('decision-dropped and retro-missing after retroSince', () => {
  const { root, pm } = board();
  newTask(pm, { title: 'a', date: ago(10) });
  setFields(pm, 'T-001', { status: 'dropped' }, ago(10));
  appendDecision(pm, { title: 'd', why: 'w', rejected: 'r', tasks: ['T-001'], date: ago(10) });
  newTask(pm, { title: 'closed before retro existed', date: ago(10) });
  setFields(pm, 'T-002', { status: 'done' }, ago(10));
  appendLog(pm, 'T-002', { worktree: 'w', did: 'x', next: '—', date: ago(10) });
  newTask(pm, { title: 'closed after, no retro', date: ago(2) });
  setFields(pm, 'T-003', { status: 'done' }, ago(2));
  appendLog(pm, 'T-003', { worktree: 'w', did: 'x', next: '—', date: ago(2) });
  newTask(pm, { title: 'closed after, with retro', date: ago(2) });
  setFields(pm, 'T-004', { status: 'review' }, ago(2));
  appendLogLine(pm, 'T-004', `- ${ago(2)} · w · retro: none`, ago(2));
  newTask(pm, { title: 'closed long ago', date: ago(40) });
  setFields(pm, 'T-005', { status: 'done' }, ago(40));
  assert.ok(!codes(runAudit({ pm, cwd: root, now: NOW })).some((c) => c.startsWith('retro-missing')), 'no retroSince yet');
  writeConfig(pm, { retroSince: ago(5) });
  const c = codes(runAudit({ pm, cwd: root, now: NOW }));
  assert.ok(c.includes('decision-dropped D-001'), c);
  assert.deepEqual(c.filter((x) => x.startsWith('retro-missing')), ['retro-missing T-003']);
});

test('pm audit prints one line per finding and --fix commits', () => {
  const { root, pm } = board();
  cli(['task', 'new', '--title', 'a'], root);
  cli(['set', 'T-001', 'status=in_progress', 'worktrees=gone-wt'], root);
  const r = cli(['audit'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /^dead-worktree T-001 — worktree gone-wt is not on this machine — pm audit --fix$/m);
  const f = cli(['audit', '--fix'], root);
  assert.match(f.out, /^fixed: T-001 worktrees -= gone-wt/m);
  assert.match(sh(['log', '-1', '--format=%s'], pm), /pm: audit --fix/);
});

test('session start counts the audit once a week', () => {
  const { root, pm } = board();
  cli(['task', 'new', '--title', 'a'], root);
  cli(['set', 'T-001', 'status=review'], root);
  assert.equal(auditLine(pm, root, NOW), '[pm] audit: 1 finding — run: pm audit');
  assert.equal(auditLine(pm, root, NOW + DAY), '', 'inside the window');
  assert.equal(auditLine(pm, root, NOW + (AUDIT_DAYS + 1) * DAY), '[pm] audit: 1 finding — run: pm audit');
  cli(['set', 'T-001', 'status=todo'], root);
  assert.equal(auditLine(pm, root, NOW + 2 * (AUDIT_DAYS + 1) * DAY), '', 'nothing to report');
  cli(['set', 'T-001', 'status=review'], root);
  fs.rmSync(path.join(pm, '.state', 'audit.json'));
  assert.match(onSessionStart({ session_id: 's' }, root), /\[pm\] audit: 1 finding — run: pm audit/);
});

test('the weekly line ignores dead worktrees it cannot fix on a synced board', () => {
  const { root, pm } = board();
  newTask(pm, { title: 'a', date: ago(1) });
  setFields(pm, 'T-001', { status: 'in_progress', worktrees: ['other-machine'] }, ago(1));
  sh(['remote', 'add', 'origin', tmp('pm-remote-')], pm);
  assert.equal(auditLine(pm, root, NOW), '');
  assert.match(cli(['audit'], root).out, /^dead-worktree T-001 — worktree other-machine is not on this machine — synced board: check there before pm set worktrees=…$/m);
});

test('stats: of the tasks created in 30 days — dropped before any work, and still only a title', () => {
  const { root, pm } = board();
  assert.equal(runAudit({ pm, cwd: root, now: NOW }).stats, '', 'a board without created dates prints nothing');
  newTask(pm, { title: 'dropped untouched', date: ago(5) });
  appendLogLine(pm, 'T-001', `- ${ago(4)} · wt · later#1: an idea`, ago(4));
  setFields(pm, 'T-001', { status: 'dropped' }, ago(4));
  newTask(pm, { title: 'dropped after work', date: ago(5) });
  appendLog(pm, 'T-002', { worktree: 'wt', did: 'tried it', next: '—', date: ago(4) });
  setFields(pm, 'T-002', { status: 'dropped' }, ago(4));
  newTask(pm, { title: 'only a title', date: ago(20) });
  newTask(pm, { title: 'fresh title', date: ago(3) });
  newTask(pm, { title: 'old and dropped', date: ago(40) });
  setFields(pm, 'T-005', { status: 'dropped' }, ago(40));
  const r = runAudit({ pm, cwd: root, now: NOW });
  assert.equal(r.stats, 'stats (30 days): 4 tasks created · 1 dropped without a did: line · 1 empty 14+ days');
  assert.ok(!r.findings.some((f) => f.code === 'stats'), 'a line, not a finding');
  assert.match(cli(['audit'], root).out, /^stats \(30 days\): /m);
});

test('isEmptyTask: any text besides the template headings is content', () => {
  const task = (body) => ({ body, data: { status: 'todo', updated: ago(30), created: ago(30) } });
  assert.equal(isEmptyTask(task('## Goal\n\n## Understanding\n\n## Checklist\n\n## Log\n'), NOW), true);
  assert.equal(isEmptyTask(task('notes above the template\n## Goal\n\n## Log\n'), NOW), false);
  assert.equal(isEmptyTask(task('## Goal\n\n## Notes\nthe real plan\n## Log\n'), NOW), false);
  assert.equal(isEmptyTask({ ...task('## Goal\n\n## Log\n'), data: { status: 'todo', updated: ago(30), created: ago(3) } }, NOW), false, 'created recently');
});
