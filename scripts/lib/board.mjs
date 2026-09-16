import fs from 'node:fs';
import path from 'node:path';
import { listTasks, readyQueue, lastNext, isOpen } from './tasks.mjs';
import { readPlan, nameOf, focusListOf } from './plan.mjs';
import { readDecisions } from './decisions.mjs';

export const COLUMNS = [
  ['todo', 'Todo'],
  ['ready', 'Ready'],
  ['in_progress', 'In progress'],
  ['waiting', 'Waiting'],
  ['done', 'Done'],
];
const DONE_MAX = 5;
const LOG_MAX = 3;

// An epic with no open task is closed: its cards collapse into one archive line.
// Tasks without an epic are never archived, so a board without epics renders as before.
export function archived(tasks) {
  const live = new Set(tasks.filter(isOpen).map((t) => t.data.epic));
  const out = new Map();
  for (const t of tasks) {
    if (!t.data.epic || live.has(t.data.epic) || t.data.status === 'dropped') continue;
    const a = out.get(t.data.epic) ?? { n: 0, updated: '' };
    out.set(t.data.epic, { n: a.n + 1, updated: t.data.updated > a.updated ? t.data.updated : a.updated });
  }
  return out;
}

// `ready` is computed over every task: a hidden (archived) done task is still a satisfied dependency.
export function columns(tasks, arch = new Map()) {
  const ready = new Set(readyQueue(tasks).map((t) => t.id));
  const cols = Object.fromEntries(COLUMNS.map(([k]) => [k, []]));
  for (const t of tasks) {
    if (arch.has(t.data.epic)) continue;
    const s = t.data.status;
    if (s === 'todo') cols[ready.has(t.id) ? 'ready' : 'todo'].push(t);
    else if (s !== 'dropped' && cols[s]) cols[s].push(t);
  }
  return cols;
}

// The only part that touches the disk: every view renders from one read of the board.
export function loadBoardSnapshot(pm, tasks = listTasks(pm)) {
  return { tasks, plan: readPlan(pm), decisions: readDecisions(pm) };
}

// "## Name" sections of a task body, keyed by lower-cased name.
function sections(body) {
  const out = {};
  for (const part of body.replace(/\r\n/g, '\n').split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[(nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase()] = nl === -1 ? '' : part.slice(nl + 1).trim();
  }
  return out;
}

// Pure: the snapshot in, plain data out — no markup, so md, html and `pm status` are separate projections.
export function buildBoardModel({ tasks, plan, decisions }) {
  const arch = archived(tasks);
  const cols = columns(tasks, arch);
  const keys = new Set(tasks.map((t) => t.data.epic).filter(Boolean));
  const status = new Map(tasks.map((t) => [t.id, t.data.status]));
  const onBoard = new Set(Object.values(cols).flat().map((t) => t.id));
  const byTask = new Map();
  // Oldest first, like `pm show`.
  for (const d of decisions) for (const id of d.tasks) byTask.set(id, [...(byTask.get(id) ?? []), d.id]);

  const card = (t) => {
    const s = sections(t.body);
    return {
      id: t.id,
      title: t.data.title,
      status: t.data.status,
      epic: t.data.epic,
      milestone: t.data.milestone,
      order: t.data.order,
      updated: t.data.updated ?? '',
      deps: t.data.depends_on.map((id) => ({ id, status: status.get(id) ?? '', onBoard: onBoard.has(id) })),
      worktrees: t.data.worktrees,
      waitingOn: t.data.waiting_on,
      next: t.data.status === 'done' ? '' : lastNext(t)?.next ?? '',
      branch: t.data.branch ?? '',
      pr: t.data.pr ?? '',
      goal: s.goal ?? '',
      understanding: s.understanding ?? '',
      checklist: s.checklist ?? '',
      log: (s.log ?? '').split('\n').filter((l) => l.startsWith('- ')).slice(-LOG_MAX),
      decisions: byTask.get(t.id) ?? [],
    };
  };

  return {
    name: nameOf(plan),
    hasEpics: keys.size > 0,
    focus: focusListOf(plan, keys),
    columns: COLUMNS.map(([key, label]) => ({ key, label, cards: cols[key].map(card) })),
    archive: [...arch].map(([epic, a]) => ({ epic, done: a.n, updated: a.updated })),
    epics: [...keys].map((key) => {
      const of = tasks.filter((t) => t.data.epic === key && t.data.status !== 'dropped'); // as `pm epics` counts
      return { key, open: of.filter(isOpen).length, total: of.length };
    }),
    decisions: [...decisions].reverse(),
  };
}

// On a board with epics, Done is capped in the view only (highest order = latest stages); the heading keeps the full count.
const shown = (col, cap) => (cap && col.key === 'done' ? col.cards.slice(-DONE_MAX) : col.cards);
const count = (col, list) => `${col.cards.length}${list.length < col.cards.length ? `, ${list.length} shown` : ''}`;
const archiveLine = (a) => `${a.epic} · ${a.done} done${a.updated ? ` · ${a.updated}` : ''}`;
const after = (c) => c.deps.map((d) => d.id).join(', ');

function cardLine(c) {
  const bits = [`**${c.id}** ${c.title}`];
  if (c.epic) bits.push(c.epic);
  if (c.milestone) bits.push(c.milestone);
  if (c.deps.length) bits.push(`after ${after(c)}`);
  if (c.worktrees.length) bits.push(`@ ${c.worktrees.join(', ')}`);
  if (c.waitingOn) bits.push(`waiting: ${c.waitingOn}`);
  if (c.next) bits.push(`next: ${c.next}`);
  return `- ${bits.join(' · ')}`;
}

export function renderBoardMd(model) {
  const out = [`# Board — ${model.name}`, '', `Focus: ${model.focus.join(' · ') || '—'}`, '', '<!-- generated by pm; do not edit -->'];
  for (const col of model.columns) {
    const list = shown(col, model.hasEpics);
    out.push('', `## ${col.label} (${count(col, list)})`, ...list.map(cardLine));
  }
  if (model.archive.length) out.push('', '## Archive', ...model.archive.map((a) => `- ${archiveLine(a)}`));
  return `${out.join('\n')}\n`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function card(c) {
  const meta = [
    c.epic && `<span class="tag">${esc(c.epic)}</span>`,
    c.milestone && `<span class="tag">${esc(c.milestone)}</span>`,
    c.deps.length && `<span>after ${esc(after(c))}</span>`,
    c.worktrees.length && `<span>@ ${esc(c.worktrees.join(', '))}</span>`,
  ].filter(Boolean).join(' ');
  return `<article class="card"><b>${esc(c.id)}</b> ${esc(c.title)}`
    + (meta ? `<div class="meta">${meta}</div>` : '')
    + (c.waitingOn ? `<div class="wait">waiting: ${esc(c.waitingOn)}</div>` : '')
    + (c.next ? `<div class="next">next: ${esc(c.next)}</div>` : '')
    + '</article>';
}

export function renderBoardHtml(model) {
  const name = esc(model.name);
  const cols = model.columns.map((col) => {
    const list = shown(col, model.hasEpics);
    return `<section class="col"><h2>${col.label} · ${count(col, list)}</h2>${list.map(card).join('')}</section>`;
  }).join('');
  const archive = model.archive.length
    ? `<details class="archive" style="margin-top:16px;color:var(--muted)"><summary>Archive · ${model.archive.length}</summary>${model.archive.map((a) => `<div>${esc(archiveLine(a))}</div>`).join('')}</details>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="10">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · board</title>
<style>
:root{--bg:#f6f6f4;--col:#ecebe7;--card:#fff;--fg:#1d1d1b;--muted:#6b6a65;--line:#d9d8d2;--accent:#3a5bd9;--warn:#a25400}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--col:#1f1f1c;--card:#2a2a26;--fg:#ecebe7;--muted:#a3a29b;--line:#3a3a35;--accent:#8ea5ff;--warn:#f0a35e}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}.focus{color:var(--muted);margin:0 0 16px}
.board{display:grid;grid-template-columns:repeat(5,minmax(200px,1fr));gap:12px;overflow-x:auto}
.col{background:var(--col);border-radius:8px;padding:8px}
.col h2{font-size:12px;margin:4px 4px 8px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px}
.meta,.next,.wait{font-size:12px;color:var(--muted);margin-top:4px}.tag{color:var(--accent)}.wait{color:var(--warn)}
</style></head><body>
<h1>${name}</h1><p class="focus">Focus: ${esc(model.focus.join(' · ') || '—')}</p>
<main class="board">${cols}</main>${archive}
</body></html>
`;
}

// A reader (the auto-refreshing board page) never sees a half-written file: write aside, then rename over.
// Windows refuses the rename while another process holds the file open; a plain write then beats failing the command.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(tmp, { force: true });
    fs.writeFileSync(file, text);
  }
}

// One read of the board for both views; callers that already hold the tasks pass them in.
export function writeBoard(pm, tasks) {
  const model = buildBoardModel(loadBoardSnapshot(pm, tasks));
  writeAtomic(path.join(pm, 'BOARD.md'), renderBoardMd(model));
  writeAtomic(path.join(pm, 'board.html'), renderBoardHtml(model));
}
