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
    total: tasks.length,
    dropped: tasks.filter((t) => t.data.status === 'dropped').length,
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

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DECISIONS_MAX = 10;

// Task bodies are shown as escaped text, never rendered markdown; the PR field is the only link and only http(s).
function card(c, col, linked) {
  const ref = (d) => (linked.has(d.id) ? `<a href="#${esc(d.id)}">${esc(d.id)}</a>` : `${esc(d.id)}${d.status ? ` (${esc(d.status)})` : ''}`);
  const meta = [
    c.epic && `<span class="tag">${esc(c.epic)}</span>`,
    c.milestone && `<span class="tag">${esc(c.milestone)}</span>`,
    c.deps.length && `<span>after ${esc(after(c))}</span>`,
    c.worktrees.length && `<span>@ ${esc(c.worktrees.join(', '))}</span>`,
  ].filter(Boolean).join(' ');
  const text = (label, s) => (s ? `<h3>${label}</h3><div class="text">${esc(s)}</div>` : '');
  const facts = [
    c.deps.length && `after ${c.deps.map(ref).join(', ')}`,
    c.branch && `branch <code>${esc(c.branch)}</code>`,
    c.pr && (/^https?:\/\//i.test(c.pr) ? `PR <a href="${esc(c.pr)}" rel="noopener noreferrer">${esc(c.pr)}</a>` : `PR ${esc(c.pr)}`),
    c.decisions.length && `decisions ${esc(c.decisions.join(', '))}`,
    c.updated && `updated ${esc(c.updated)}`,
  ].filter(Boolean);
  return `<details class="card" id="${esc(c.id)}" data-epic="${esc(c.epic ?? '')}" data-col="${col}">`
    + `<summary><b>${esc(c.id)}</b> <span class="title">${esc(c.title)}</span>`
    + (meta ? `<div class="meta">${meta}</div>` : '')
    + (c.waitingOn ? `<div class="wait">waiting: ${esc(c.waitingOn)}</div>` : '')
    + (c.next ? `<div class="next">next: ${esc(c.next)}</div>` : '')
    + '</summary><div class="body">'
    + text('Goal', c.goal) + text('Understanding', c.understanding) + text('Checklist', c.checklist)
    + text(`Log · last ${c.log.length}`, c.log.join('\n'))
    + (facts.length ? `<p class="meta">${facts.join(' · ')}</p>` : '')
    + (c.status === 'done' ? '' : `<p class="meta">start: <code>pm claim ${esc(c.id)}</code></p>`)
    + '</div></details>';
}

const column = (col, label, cards = '') => `<details class="col" open data-col="${col.key}"><summary><h2>${label}</h2></summary><div class="cards">${cards}</div></details>`;

// Every card is one DOM node inside the status columns. With JS the epic lanes (rendered empty and hidden) take the same nodes.
function lanes(model, cols) {
  const focus = (key) => model.focus.find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2) ?? '';
  const keys = model.epics.filter((e) => e.open);
  if (cols.some((c) => c.list.some((x) => !x.epic))) keys.push({ key: '', open: 0, total: 0 });
  return `<div id="lanes" hidden>${keys.map((e) => {
    const head = e.key ? `${esc(e.key)} · ${e.open} open of ${e.total}${focus(e.key) ? ` · ${esc(focus(e.key))}` : ''}` : 'No epic';
    return `<section class="lane" data-epic="${esc(e.key)}"><h2 class="lane-head">${head}</h2><div class="board">${
      cols.map((c) => column(c, `${c.label} · <span class="n">0</span>`)).join('')}</div></section>`;
  }).join('')}</div>`;
}

const SCRIPT = `(() => {
  const btn = document.getElementById('group');
  const board = document.getElementById('board');
  const lanes = document.getElementById('lanes');
  const cards = [...board.querySelectorAll('.card')];
  const home = (c) => board.querySelector('.col[data-col="' + c.dataset.col + '"] .cards');
  const apply = (byEpic) => {
    for (const c of cards) {
      const lane = byEpic && [...lanes.children].find((l) => l.dataset.epic === c.dataset.epic);
      (lane ? lane.querySelector('.col[data-col="' + c.dataset.col + '"] .cards') : home(c)).append(c);
    }
    for (const n of lanes.querySelectorAll('.n')) n.textContent = n.closest('.col').querySelectorAll('.card').length;
    board.hidden = byEpic;
    lanes.hidden = !byEpic;
    btn.setAttribute('aria-pressed', String(byEpic));
  };
  btn.hidden = false;
  btn.addEventListener('click', () => {
    const byEpic = btn.getAttribute('aria-pressed') !== 'true';
    history.replaceState(null, '', byEpic ? '#group=epic' : location.pathname + location.search);
    apply(byEpic);
  });
  // A dependency link opens its card instead of dropping the grouping kept in the hash.
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    const to = a && document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
    if (!to) return;
    e.preventDefault();
    to.open = true;
    to.scrollIntoView({ block: 'center' });
    to.querySelector('summary').focus();
  });
  apply(location.hash === '#group=epic');
  // meta refresh drops the hash; reload() keeps it (T-041 also keeps open cards and pauses while typing).
  setTimeout(() => location.reload(), 10000);
})();`;

export function renderBoardHtml(model, generated = '') {
  const name = esc(model.name);
  const cols = model.columns.map((col) => ({ ...col, list: shown(col, model.hasEpics) }));
  const linked = new Set(cols.flatMap((c) => c.list.map((x) => x.id)));
  let board;
  if (linked.size) {
    board = `<main class="board" id="board">${cols.map((c) => column(c, `${c.label} · ${count(c, c.list)}`, c.list.map((x) => card(x, c.key, linked)).join(''))).join('')}</main>`
      + (model.hasEpics ? lanes(model, cols) : '');
  } else {
    const why = model.total === 0 ? 'No tasks yet. Create the first one: <code>pm task new --title …</code>'
      : model.total === model.dropped ? 'Every task is dropped.'
        : 'Nothing open: every epic is closed, see Archive.';
    board = `<main class="board-empty"><p class="empty">${why}</p></main>`;
  }
  const focus = model.focus.length
    ? `<ul class="focus">${model.focus.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '<p class="empty">No focus set: add lines under <code>## Current focus</code> in PLAN.md.</p>';
  const epics = model.hasEpics
    ? (linked.size ? '<p><button type="button" id="group" aria-pressed="false" hidden>Group by epic</button></p>' : '')
    : '<p class="empty">No epics: <code>pm task new --epic KEY</code> groups tasks by direction.</p>';
  const archive = model.archive.length
    ? `<details class="archive"><summary>Archive · ${model.archive.length}</summary>${model.archive.map((a) => `<div>${esc(archiveLine(a))}</div>`).join('')}</details>`
    : '';
  const script = linked.size > 0 && model.hasEpics;
  const recent = model.decisions.slice(0, DECISIONS_MAX);
  const ref = (id) => (linked.has(id) ? `<a href="#${esc(id)}">${esc(id)}</a>` : esc(id));
  const decisions = recent.length
    ? `<details class="decisions"><summary>Decisions · ${recent.length < model.decisions.length ? `last ${recent.length} of ` : ''}${model.decisions.length}</summary><ul>${
      recent.map((d) => `<li><b>${esc(d.id)}</b> · ${esc(d.date)} · ${esc(d.title)}${d.tasks.length ? ` · ${d.tasks.map(ref).join(', ')}` : ''}</li>`).join('')}</ul></details>`
    : '<p class="empty">No decisions yet: <code>pm decision --title …</code></p>';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">${script ? '<noscript><meta http-equiv="refresh" content="10"></noscript>' : '<meta http-equiv="refresh" content="10">'}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · board</title>
<style>
:root{--bg:#f6f6f4;--col:#ecebe7;--card:#fff;--fg:#1d1d1b;--muted:#6b6a65;--line:#d9d8d2;--accent:#3a5bd9;--warn:#a25400}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--col:#1f1f1c;--card:#2a2a26;--fg:#ecebe7;--muted:#a3a29b;--line:#3a3a35;--accent:#8ea5ff;--warn:#f0a35e}}
*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif}
a{color:var(--accent)}code{font:12px ui-monospace,monospace;user-select:all}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
h1{font-size:18px;margin:0}.generated{color:var(--muted);font-size:12px;margin:2px 0 8px}
.focus{margin:0 0 12px;padding-left:18px}.empty{color:var(--muted);margin:0 0 12px}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
button[aria-pressed=true]{border-color:var(--accent);color:var(--accent)}
.board{display:grid;grid-template-columns:repeat(5,minmax(200px,1fr));gap:12px;align-items:start}
.col{background:var(--col);border-radius:8px;padding:0 8px 8px}
.col>summary{position:sticky;top:0;z-index:1;background:var(--col);padding:8px 4px;cursor:pointer;list-style-position:inside}
.col h2{display:inline;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.cards:empty::after{content:"empty";display:block;color:var(--muted);font-size:12px;padding:4px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px;margin-bottom:8px}
.card>summary{cursor:pointer;list-style:none}.card>summary::-webkit-details-marker{display:none}
.card:target{border-color:var(--accent)}
.title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.card[open] .title{display:inline}
.meta,.next,.wait{font-size:12px;color:var(--muted);margin-top:4px}.tag{color:var(--accent)}.wait{color:var(--warn)}
.body{border-top:1px solid var(--line);margin-top:8px;padding-top:4px}
.body h3{font-size:11px;margin:8px 0 2px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.body p{margin:6px 0 0;overflow-wrap:anywhere}
.lane{margin-bottom:20px}.lane-head{font-size:14px;margin:0 0 8px}
.archive,.decisions{margin-top:16px;color:var(--muted)}.decisions ul{padding-left:18px;margin:8px 0}
@media (max-width:720px){body{padding:12px}.board{grid-template-columns:1fr}}
</style></head><body>
<header><h1>${name}</h1>${generated ? `<p class="generated">generated ${esc(generated)}</p>` : ''}${focus}${epics}</header>
${board}${archive}${decisions}
${script ? `<script>${SCRIPT}</script>\n` : ''}</body></html>
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
  // sv-SE formats local time as "YYYY-MM-DD HH:MM:SS".
  writeAtomic(path.join(pm, 'board.html'), renderBoardHtml(model, new Date().toLocaleString('sv-SE').slice(0, 16)));
}
