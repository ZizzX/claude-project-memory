import { readTask, appendLogLine, cleanLine } from './tasks.mjs';

// A finding the user declined to fix now, kept on the task it came up in instead of becoming a task of its own:
// "- <date> · <worktree> · later#<n>: <text>". A later Log line resolves it: "later#<n> kept", "later#<n> dismissed"
// or "later#<n> → T-NNN". /close asks once about the unresolved ones.
const LINE = /^- \S+ · [^·]+ · later#(\d+)(?:: (.*)| (kept|dismissed|→ \S+))$/; // the worktree holds no ·: a did/next text never matches

export function laterItems(task) {
  const items = new Map();
  for (const line of task.body.split('\n')) {
    const m = line.match(LINE);
    if (!m) continue;
    const n = Number(m[1]);
    if (m[2] !== undefined) items.set(n, { n, text: m[2], resolved: '' });
    else if (items.has(n)) items.get(n).resolved = m[3];
  }
  return [...items.values()];
}

export const openLater = (task) => laterItems(task).filter((i) => !i.resolved);

export function addLater(pm, id, text, worktree, date) {
  const clean = cleanLine(text);
  if (!clean) throw new Error(`nothing to record: the text is empty — pm later ${id} "<what was found>"`);
  const n = Math.max(0, ...laterItems(readTask(pm, id)).map((i) => i.n)) + 1; // numbers are never reused
  appendLogLine(pm, id, `- ${date} · ${worktree} · later#${n}: ${clean}`, date);
  return n;
}

// The open items `which` names ("all", or numbers): throws before anything is written when one of them is not
// open. `effect` says what the refusal left undone, e.g. "nothing created — ".
export function pickLater(task, which, effect = '') {
  const open = openLater(task);
  if (which === 'all') return open;
  const ns = String(which).split(',').map((s) => Number(s.trim()));
  const bad = ns.filter((n) => !open.some((i) => i.n === n));
  if (bad.length) {
    const list = open.map((i) => i.n).join(', ') || 'none';
    throw new Error(`later#${bad.join(', later#')} is not open on ${task.id} — open: ${list} — ${effect}pm later ${task.id} lists them`);
  }
  return open.filter((i) => ns.includes(i.n));
}

// how: "kept", "dismissed" or "→ T-NNN".
export function resolveLater(pm, id, items, how, worktree, date) {
  for (const i of items) appendLogLine(pm, id, `- ${date} · ${worktree} · later#${i.n} ${how}`, date);
  return items.map((i) => `${id} later#${i.n} ${how}`);
}
