import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { listTasks, readyQueue, lastNext, isOpen, byEpic, activeEpic, nextTask, epicProgress, epicParts, epicClosed } from './tasks.mjs';
import { recentDecisions } from './decisions.mjs';
import { projectName, currentFocus } from './plan.mjs';
import { parsePrUrl } from './forge.mjs';
import { listLearnings, promotable } from './learn.mjs';

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

// The next task leads the Ready line even when its dependencies are still open — then it says which.
export function nextTag(t, tasks) {
  if (!t.data.next) return '';
  const status = new Map(tasks.map((x) => [x.id, x.data.status]));
  const open = t.data.depends_on.filter((d) => !['done', 'dropped'].includes(status.get(d)));
  return open.length ? ` ← next (after ${open.join(', ')})` : ' ← next';
}

// merge: what SessionStart learned from local refs and the merge cache (mergeAtStart), or null.
export function buildSummary({ pm, worktree, scriptPath, statusLine = '', tasks = listTasks(pm), merge = null }) {
  const keys = new Set(tasks.map((t) => t.data.epic).filter(Boolean));
  const epic = activeEpic(tasks, worktree);
  const epics = [...new Set(tasks.filter(isOpen).map((t) => t.data.epic).filter(Boolean))];
  const mine = tasks.filter((t) => isOpen(t) && t.data.worktrees.includes(worktree));
  const elsewhere = tasks.filter((t) => t.data.status === 'in_progress' && !t.data.worktrees.includes(worktree)).slice(0, 5);
  // Own epic: its queue. No epic on a board that has some: the top task of each, so a fresh worktree sees the directions.
  const perEpic = (list) => (epic ? byEpic(list, epic) : epics.length ? firstPerEpic(list) : list);
  const queue = readyQueue(tasks);
  // Own epic: its next task. No epic yet: every epic's next task — /close chose them for the session after it.
  // Own epic: its next task plus the repo-wide one (visible in every epic). No epic yet: every epic's next task.
  const nexts = epic || !epics.length
    ? [...new Set([nextTask(tasks, epic), nextTask(tasks, '')])].filter(Boolean)
    : tasks.filter((t) => t.data.next && t.data.status === 'todo');
  const ready = [...nexts, ...perEpic(queue).filter((t) => !nexts.includes(t))].slice(0, 3);
  const others = epic ? queue.length - perEpic(queue).length : 0;
  // Waiting tasks of my epic, plus the ones my tasks depend on directly: a cross-epic blocker is still my blocker.
  const scope = byEpic(tasks, epic);
  const keep = new Set([...scope.map((t) => t.id), ...scope.flatMap((t) => t.data.depends_on)]);
  const blocked = tasks.filter((t) => t.data.status === 'waiting' && keep.has(t.id));
  const waiting = (epic || !epics.length ? blocked : firstPerEpic(blocked)).slice(0, 5);
  const awaiting = byEpic(tasks, epic).filter((t) => t.data.status === 'review').slice(0, 5);
  const decisions = recentDecisions(pm, 3);
  // Learnings: frontmatter only. Those of this direction's tasks first; a board without one shows the freshest.
  const active = listLearnings(pm).filter((l) => l.data.status === 'active');
  const ids = new Set(scope.map((t) => t.id));
  const ofScope = active.filter((l) => l.data.tasks.some((id) => ids.has(id)));
  const learnings = (ofScope.length ? ofScope : active).sort((a, b) => b.data.last.localeCompare(a.data.last) || a.id.localeCompare(b.id)).slice(0, 5);
  const promote = active.filter(promotable).slice(0, 5);

  const lines = [`[pm] ${projectName(pm)}${epic ? ` · epic ${epic}` : ''} · focus: ${currentFocus(pm, epic, keys) || '—'} · board: ${pathToFileURL(path.join(pm, 'board.html')).href}`];
  if (statusLine) lines.push(...statusLine.split('\n')); // sync/board status and the update notice are separate lines
  lines.push(`Your worktree (${worktree}):`);
  if (!mine.length) lines.push(`  no active task — take one from Ready (pm next${epics.length && !epic ? ' --options' : ''}), or say what to work on${epics.length && !epic ? ' · a new direction: pm task new --epic <KEY>' : ''}`);
  for (const t of mine) {
    const n = lastNext(t);
    lines.push(`  ${t.id} ${t.data.title}${tag(t, epic)} [${t.data.status}]${n ? ` → next: ${n.next} (${n.date}, ${n.who})` : ''}`);
  }
  // The header and the epic line survive the cap: they say which direction this is and how much of it is left.
  const kept = new Set([0]);
  if (epic) {
    const p = epicProgress(tasks, epic);
    kept.add(lines.push(p.open
      ? `Epic ${epic}: ${p.open} left of ${p.total} (${epicParts(p)})`
      : `Epic ${epic}: no open tracked tasks (${epicClosed(p)}) — ask the user which direction is next: pm next --options`) - 1);
  }
  if (elsewhere.length) lines.push(`Elsewhere: ${elsewhere.map((t) => `${t.id} ${t.data.title} @ ${t.data.worktrees.join(', ') || '(no worktree)'}`).join(' · ')}`);
  lines.push(`Ready: ${ready.map((t) => `${t.id} ${t.data.title}${tag(t, epic)}${nextTag(t, tasks)}`).join(' · ') || '—'}${others ? ` · +${others} in other epics (pm ready --all)` : ''}`);
  if (waiting.length) lines.push(`Waiting: ${waiting.map((t) => `${t.id}${tag(t, epic)} ← ${t.data.waiting_on}`).join(' · ')}`);
  if (merge?.closed.length) lines.push(`Closed after merge: ${merge.closed.join(', ')}`);
  if (awaiting.length) {
    const pr = (t) => {
      const n = parsePrUrl(t.data.pr ?? '')?.number;
      return n ? ` (#${n})` : '';
    };
    lines.push(`Awaiting merge: ${awaiting.map((t) => `${t.id}${pr(t)}${tag(t, epic)}`).join(' · ')}`);
  }
  if (merge?.ask.length) lines.push(`Merged, still open: ${merge.ask.join(', ')} — ask the user, then pm reconcile --yes <the ids they confirm>`);
  if (merge?.conflicts.length) lines.push(`PR conflict: ${merge.conflicts.join(', ')} — details: pm reconcile`);
  if (epics.length) {
    const of = (e) => tasks.filter((t) => t.data.epic === e && t.data.status !== 'dropped');
    lines.push(`Epics: ${epics.map((e) => `${e} ${of(e).filter(isOpen).length}/${of(e).length}`).join(' · ')}`);
  }
  if (decisions.length) lines.push(`Decisions: ${decisions.map((d) => `${d.id} ${d.title}`).join(' · ')}`);
  if (learnings.length) lines.push(`Learnings: ${learnings.map((l) => `${l.id} ${l.data.title}`).join(' · ')}`);
  if (promote.length) lines.push(`Promote: ${promote.map((l) => `${l.id} ${l.data.title} (seen ${l.data.seen} in ${new Set(l.data.tasks).size} tasks)`).join(' · ')} — propose the rule and its target file, pm learn promote after the user agrees`);

  const tail = [`CLI: node "${scriptPath}" <command>`, ...RULES];
  const room = MAX_LINES - tail.length;
  if (lines.length > room) {
    // Lines go from the end, the kept ones stay; the note takes the place of the earliest line removed.
    const cut = lines.length - room + 1;
    let at = lines.length;
    for (let i = lines.length - 1, left = cut; i >= 0 && left; i -= 1) {
      if (kept.has(i)) continue;
      lines.splice(i, 1);
      at = i;
      left -= 1;
    }
    lines.splice(at, 0, `  … ${cut} more lines — see BOARD.md`);
  }
  return [...lines, ...tail].join('\n');
}
