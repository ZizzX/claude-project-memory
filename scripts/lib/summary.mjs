import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listTasks, readyQueue, lastNext, isOpen, byEpic, activeEpic } from './tasks.mjs';
import { recentDecisions } from './decisions.mjs';
import { projectName, currentFocus } from './plan.mjs';

export const MAX_LINES = 40;
export const RULES = [
  'Rules: keep tasks, statuses, log and decisions current yourself via the CLI · end every turn that changed the board with a one-line board diff',
  '  only the main agent writes pm/ · before calling a task done, ask "what\'s left?" and file leftovers as tasks · protocol: /pm',
];

// Epic decorations appear only where an epic exists: a board without epics prints exactly what it printed before.
const tag = (t, epic) => (!epic && t.data.epic ? ` (${t.data.epic})` : '');
const firstPerEpic = (list) => {
  const seen = new Set();
  return list.filter((t) => !seen.has(t.data.epic) && seen.add(t.data.epic));
};

export function buildSummary({ pm, worktree, scriptPath, statusLine = '', tasks = listTasks(pm) }) {
  const keys = new Set(tasks.map((t) => t.data.epic).filter(Boolean));
  const epic = activeEpic(tasks, worktree);
  const epics = [...new Set(tasks.filter(isOpen).map((t) => t.data.epic).filter(Boolean))];
  const mine = tasks.filter((t) => isOpen(t) && t.data.worktrees.includes(worktree));
  const elsewhere = tasks.filter((t) => t.data.status === 'in_progress' && !t.data.worktrees.includes(worktree)).slice(0, 5);
  // Own epic: its queue. No epic on a board that has some: the top task of each, so a fresh worktree sees the directions.
  const perEpic = (list) => (epic ? byEpic(list, epic) : epics.length ? firstPerEpic(list) : list);
  const queue = readyQueue(tasks);
  const ready = perEpic(queue).slice(0, 3);
  const others = epic ? queue.length - perEpic(queue).length : 0;
  // Waiting tasks of my epic, plus the ones my tasks depend on directly: a cross-epic blocker is still my blocker.
  const scope = byEpic(tasks, epic);
  const keep = new Set([...scope.map((t) => t.id), ...scope.flatMap((t) => t.data.depends_on)]);
  const blocked = tasks.filter((t) => t.data.status === 'waiting' && keep.has(t.id));
  const waiting = (epic || !epics.length ? blocked : firstPerEpic(blocked)).slice(0, 5);
  const decisions = recentDecisions(pm, 3);

  const lines = [`[pm] ${projectName(pm)}${epic ? ` · epic ${epic}` : ''} · focus: ${currentFocus(pm, epic, keys) || '—'} · board: ${pathToFileURL(path.join(pm, 'board.html')).href}`];
  if (statusLine) lines.push(...statusLine.split('\n')); // sync/board status and the update notice are separate lines
  lines.push(`Your worktree (${worktree}):`);
  if (!mine.length) lines.push(`  no active task — take one from Ready, or say what to work on${epics.length && !epic ? ' · a new direction: pm task new --epic <KEY>' : ''}`);
  for (const t of mine) {
    const n = lastNext(t);
    lines.push(`  ${t.id} ${t.data.title}${tag(t, epic)} [${t.data.status}]${n ? ` → next: ${n.next} (${n.date}, ${n.who})` : ''}`);
  }
  if (elsewhere.length) lines.push(`Elsewhere: ${elsewhere.map((t) => `${t.id} ${t.data.title} @ ${t.data.worktrees.join(', ')}`).join(' · ')}`);
  lines.push(`Ready: ${ready.map((t) => `${t.id} ${t.data.title}${tag(t, epic)}`).join(' · ') || '—'}${others ? ` · +${others} in other epics (pm ready --all)` : ''}`);
  if (waiting.length) lines.push(`Waiting: ${waiting.map((t) => `${t.id}${tag(t, epic)} ← ${t.data.waiting_on}`).join(' · ')}`);
  if (epics.length) {
    const of = (e) => tasks.filter((t) => t.data.epic === e && t.data.status !== 'dropped');
    lines.push(`Epics: ${epics.map((e) => `${e} ${of(e).filter(isOpen).length}/${of(e).length}`).join(' · ')}`);
  }
  if (decisions.length) lines.push(`Decisions: ${decisions.map((d) => `${d.id} ${d.title}`).join(' · ')}`);

  const tail = [`CLI: node "${scriptPath}" <command>`, ...RULES];
  const room = MAX_LINES - tail.length;
  if (lines.length > room) {
    const cut = lines.length - room + 1;
    lines.splice(room - 1, cut, `  … ${cut} more lines — see BOARD.md`);
  }
  return [...lines, ...tail].join('\n');
}
