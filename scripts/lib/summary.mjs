import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listTasks, readyQueue, lastNext } from './tasks.mjs';
import { recentDecisions } from './decisions.mjs';
import { projectName, currentFocus } from './plan.mjs';

export const MAX_LINES = 40;
export const RULES = [
  'Rules: keep tasks, statuses, log and decisions current yourself via the CLI · end every turn that changed the board with a one-line board diff',
  '  only the main agent writes pm/ · before calling a task done, ask "what\'s left?" and file leftovers as tasks · protocol: /pm',
];

const OPEN = (t) => !['done', 'dropped'].includes(t.data.status);

export function buildSummary({ pm, worktree, scriptPath, statusLine = '' }) {
  const tasks = listTasks(pm);
  const mine = tasks.filter((t) => OPEN(t) && t.data.worktrees.includes(worktree));
  const elsewhere = tasks.filter((t) => t.data.status === 'in_progress' && !t.data.worktrees.includes(worktree)).slice(0, 5);
  const ready = readyQueue(tasks).slice(0, 3);
  const waiting = tasks.filter((t) => t.data.status === 'waiting').slice(0, 5);
  const decisions = recentDecisions(pm, 3);

  const lines = [`[pm] ${projectName(pm)} · focus: ${currentFocus(pm) || '—'} · board: ${pathToFileURL(path.join(pm, 'board.html')).href}`];
  if (statusLine) lines.push(statusLine);
  lines.push(`Your worktree (${worktree}):`);
  if (!mine.length) lines.push('  no active task — take one from Ready, or say what to work on');
  for (const t of mine) {
    const n = lastNext(t);
    lines.push(`  ${t.id} ${t.data.title} [${t.data.status}]${n ? ` → next: ${n.next} (${n.date}, ${n.who})` : ''}`);
  }
  if (elsewhere.length) lines.push(`Elsewhere: ${elsewhere.map((t) => `${t.id} ${t.data.title} @ ${t.data.worktrees.join(', ')}`).join(' · ')}`);
  lines.push(`Ready: ${ready.map((t) => `${t.id} ${t.data.title}`).join(' · ') || '—'}`);
  if (waiting.length) lines.push(`Waiting: ${waiting.map((t) => `${t.id} ← ${t.data.waiting_on}`).join(' · ')}`);
  if (decisions.length) lines.push(`Decisions: ${decisions.map((d) => `${d.id} ${d.title}`).join(' · ')}`);

  const tail = [`CLI: node "${scriptPath}" <command>`, ...RULES];
  const room = MAX_LINES - tail.length;
  if (lines.length > room) {
    const cut = lines.length - room + 1;
    lines.splice(room - 1, cut, `  … ${cut} more lines — see BOARD.md`);
  }
  return [...lines, ...tail].join('\n');
}
