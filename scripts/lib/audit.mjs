import fs from 'node:fs';
import path from 'node:path';
import { tryGit } from './paths.mjs';
import { isSyncOn, readState, writeState, commitPm } from './store.mjs';
import { listTasks, writeTask, boardConfig, lastManualLogDate, lastLogDate } from './tasks.mjs';
import { listLearnings, promotable, CAP } from './learn.mjs';
import { readDecisions } from './decisions.mjs';

// Deterministic housekeeping: no LLM, no status changes, no deletions of tasks, learnings or decisions.
export const AUDIT_DAYS = 7;
export const DAYS = { stuck: 14, waiting: 30, next: 30, state: 7, learning: 90, retro: 30, empty: 14, stats: 30 };
export const CAP_WARN = 80;
const DAY = 86_400_000;

const olderThan = (date, days, now) => !date || Date.parse(date) < now - days * DAY;

function liveWorktrees(cwd) {
  const out = tryGit(['worktree', 'list', '--porcelain'], cwd);
  if (out === null) return null; // not a git checkout: nothing can be called dead
  return new Set(out.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.basename(l.slice('worktree '.length).trim())));
}

const section = (task, name) => task.body.match(new RegExp(`^## ${name}\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1].trim() ?? '';

// Only a title: an open todo whose sections are all empty, untouched and created 14+ days ago.
export const isEmptyTask = (t, now) => t.data.status === 'todo'
  && ['Goal', 'Understanding', 'Checklist', 'Log'].every((name) => !section(t, name))
  && olderThan(t.data.updated, DAYS.empty, now) && (!t.data.created || olderThan(t.data.created, DAYS.empty, now));

// Whether tasks stopped piling up: of those created in the last 30 days, how many were dropped before any work was
// logged (no ` · did: ` line) and how many are still only a title. A board without created dates says nothing.
function statsLine(tasks, now) {
  if (!tasks.some((t) => t.data.created)) return '';
  const recent = tasks.filter((t) => t.data.created && !olderThan(t.data.created, DAYS.stats, now));
  const untouched = recent.filter((t) => t.data.status === 'dropped' && !/ · did: /.test(t.body)).length;
  const empty = recent.filter((t) => isEmptyTask(t, now)).length;
  return `stats (${DAYS.stats} days): ${recent.length} tasks created · ${untouched} dropped without a did: line · ${empty} empty ${DAYS.empty}+ days`;
}

export function runAudit({ pm, cwd, now = Date.now(), fix = false }) {
  const findings = [];
  const fixed = [];
  const add = (code, id, text, how, fixable = false, apply = null) => findings.push({ code, id, text, how, fixable, apply });
  const tasks = listTasks(pm);
  const synced = isSyncOn(pm);
  const live = liveWorktrees(cwd);
  const since = boardConfig(pm).retroSince;

  for (const t of tasks) {
    const { status } = t.data;
    if (status === 'in_progress') {
      const last = lastManualLogDate(t) ?? t.data.updated;
      if (olderThan(last, DAYS.stuck, now)) add('stuck', t.id, `in_progress, last log ${last ?? 'never'}`, 'pm log … --next, or pm set status=todo');
      if (!t.data.worktrees.length) add('orphan', t.id, 'in_progress with no worktree', 'pm claim, or pm set status=todo');
    }
    if (status === 'waiting') {
      const since_ = t.data.waiting_since || t.data.updated;
      if (olderThan(since_, DAYS.waiting, now)) add('waiting-long', t.id, `waiting on "${t.data.waiting_on}" since ${since_}`, 'still blocked? else pm set status=todo');
    }
    if (status === 'review' && !t.data.pr) add('review-no-pr', t.id, 'awaiting merge without a PR', 'pm set pr=<url>, or pm done --no-merge');
    if (live && t.data.worktrees.length) {
      const dead = t.data.worktrees.filter((w) => !live.has(w));
      if (dead.length) {
        add('dead-worktree', t.id, `worktree ${dead.join(', ')} is not on this machine`, synced ? 'synced board: check there before pm set worktrees=…' : 'pm audit --fix', !synced, () => {
          t.data.worktrees = t.data.worktrees.filter((w) => live.has(w));
          writeTask(t);
          return `${t.id} worktrees -= ${dead.join(', ')}`;
        });
      }
    }
    if (t.data.next && (status !== 'todo' || olderThan(t.data.next, DAYS.next, now))) {
      add('next-stale', t.id, status !== 'todo' ? `next on a ${status} task` : `next since ${t.data.next}`, 'pm audit --fix', true, () => {
        delete t.data.next;
        writeTask(t);
        return `${t.id} next cleared`;
      });
    }
    if (since && ['done', 'review'].includes(status)) {
      const closed = lastLogDate(t) ?? t.data.updated;
      const hasRetro = / · retro: /.test(t.body);
      if (!hasRetro && closed >= since && !olderThan(closed, DAYS.retro, now)) add('retro-missing', t.id, `closed ${closed} without a retro`, 'pm learn add … --tasks, or pm learn none');
    }
  }

  const stateDir = path.join(pm, '.state');
  if (fs.existsSync(stateDir)) {
    for (const f of fs.readdirSync(stateDir).filter((n) => n.startsWith('session-') && n.endsWith('.json'))) {
      const file = path.join(stateDir, f);
      if (fs.statSync(file).mtimeMs < now - DAYS.state * DAY) {
        add('state-old', f, 'session state older than a week', 'pm audit --fix', true, () => {
          fs.rmSync(file, { force: true });
          return `${f} removed`;
        });
      }
    }
  }

  const active = listLearnings(pm).filter((l) => l.data.status === 'active');
  for (const l of active) {
    if (olderThan(l.data.last, DAYS.learning, now)) add('learning-unused', l.id, `not seen since ${l.data.last}`, `still true? else pm learn retire ${l.id} --why "…"`);
    if (promotable(l)) add('learning-promote', l.id, `seen ${l.data.seen} in ${new Set(l.data.tasks).size} tasks`, `pm learn promote ${l.id} --to <file#section>`);
  }
  const byPattern = new Map();
  for (const l of active) byPattern.set(l.data.pattern, [...(byPattern.get(l.data.pattern) ?? []), l.id]);
  for (const [pattern, ids] of byPattern) {
    if (ids.length > 1) add('learning-dup', pattern, `${ids.join(', ')} share one pattern`, 'keep one: pm learn retire <id> --why "duplicate"');
  }
  if (active.length > CAP_WARN) add('learnings-cap', String(active.length), `active learnings, cap is ${CAP}`, 'retire or promote the oldest: pm learn list');

  const status = new Map(tasks.map((t) => [t.id, t.data.status]));
  for (const d of readDecisions(pm)) {
    if (d.tasks.length && d.tasks.every((id) => status.get(id) === 'dropped')) add('decision-dropped', d.id, `"${d.title}" — every task of it is dropped`, 'still a decision? note it in decisions.md');
  }

  if (fix) {
    for (const f of findings) if (f.fixable) fixed.push(f.apply());
    if (fixed.length) commitPm(pm, 'pm: audit --fix');
  }
  return { findings, fixed, stats: statsLine(tasks, now) };
}

export const findingLine = (f) => `${f.code} ${f.id} — ${f.text} — ${f.how}`;

// Once a week at session start: a count, never a fix.
export function auditLine(pm, cwd, now = Date.now()) {
  const { at = 0 } = readState(pm, 'audit');
  if (now - at < AUDIT_DAYS * DAY) return '';
  writeState(pm, 'audit', { at: now });
  // A synced board cannot tell another machine's worktree from a dead one: that line is not worth a weekly nag.
  const n = runAudit({ pm, cwd, now }).findings.filter((f) => f.code !== 'dead-worktree' || f.fixable).length;
  return n ? `[pm] audit: ${n} finding${n === 1 ? '' : 's'} — run: pm audit` : '';
}
