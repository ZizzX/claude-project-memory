import fs from 'node:fs';
import path from 'node:path';
import { parse, serialize } from './frontmatter.mjs';

// review: finished and verified, only the merge is left; not Ready and does not satisfy depends_on.
export const STATUSES = ['todo', 'in_progress', 'waiting', 'review', 'done', 'dropped'];
// Any prefix is read, so tasks created before `pm prefix` keep their T-NNN ids next to the new ones.
const ID_RE = /^[A-Z][A-Z0-9]*-(\d+)\.md$/;
const PREFIX_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const TEMPLATE_BODY = '## Goal\n\n## Understanding\n\n## Checklist\n\n## Log\n';
const LIST_FIELDS = ['depends_on', 'worktrees', 'links', 'commits'];

export const tasksDir = (pm) => path.join(pm, 'tasks');

// config.json lives in the board, so every machine that syncs the board uses the same prefix.
const configFile = (pm) => path.join(pm, 'config.json');
export function boardConfig(pm) {
  try {
    return JSON.parse(fs.readFileSync(configFile(pm), 'utf8'));
  } catch {
    return {};
  }
}
const readConfig = boardConfig;

export function writeConfig(pm, patch) {
  fs.writeFileSync(configFile(pm), `${JSON.stringify({ ...boardConfig(pm), ...patch }, null, 2)}\n`);
}

function checkPrefix(prefix) {
  if (!PREFIX_RE.test(prefix)) throw new Error(`bad prefix "${prefix}" — uppercase letters and digits, starting with a letter, up to 10`);
  return prefix;
}

// Checked on read as well: config.json comes in with board sync, and the prefix becomes part of a file name.
export const taskPrefix = (pm) => checkPrefix(readConfig(pm).taskPrefix || 'T');

// start: the first number new ids may use (config.startNumber) — for a board whose history already names ids.
export function setTaskPrefix(pm, prefix, start) {
  checkPrefix(prefix);
  if (start !== undefined && (!Number.isInteger(start) || start < 1)) throw new Error(`--start must be a whole number ≥ 1, got "${start}"`);
  writeConfig(pm, { taskPrefix: prefix, ...(start !== undefined && { startNumber: start }) });
}

const toArray = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

export function parseOrder(v) {
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`order must be a number, got "${v}"`);
  return n;
}

function readTaskFile(file) {
  const { data: raw, body } = parse(fs.readFileSync(file, 'utf8'));
  const data = {
    ...raw,
    order: Number(raw.order ?? 0),
    depends_on: toArray(raw.depends_on),
    worktrees: toArray(raw.worktrees),
    links: toArray(raw.links),
    waiting_on: raw.waiting_on ?? '',
    milestone: raw.milestone ?? '',
    epic: String(raw.epic ?? '').trim(),
  };
  // Optional fields stay absent when unset, so files written before them never grow new lines.
  if (raw.commits !== undefined) data.commits = toArray(raw.commits);
  return { file, id: path.basename(file, '.md'), data, body };
}

export function listTasks(pm) {
  const dir = tasksDir(pm);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => ID_RE.test(f))
    .map((f) => readTaskFile(path.join(dir, f)))
    .sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
}

export function readTask(pm, id) {
  if (!ID_RE.test(`${id}.md`)) throw new Error(`bad task id "${id}" — expected <PREFIX>-NNN, e.g. T-007`);
  const file = path.join(tasksDir(pm), `${id}.md`);
  if (!fs.existsSync(file)) throw new Error(`unknown task ${id}`);
  return readTaskFile(file);
}

export function writeTask(task) {
  fs.writeFileSync(task.file, serialize(task.data, task.body));
}

// The number continues across all prefixes, so it stays unique on its own.
export function nextNumber(pm) {
  const dir = tasksDir(pm);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const floor = Number(readConfig(pm).startNumber) || 1;
  return Math.max(floor, ...files.map((f) => Number(f.match(ID_RE)?.[1] ?? 0) + 1));
}

export const idOf = (prefix, n) => `${prefix}-${String(n).padStart(3, '0')}`;

// The id is reserved by creating <PREFIX>-NNN.md exclusively, so concurrent processes never share an id.
export function newTask(pm, { title, order, deps = [], milestone = '', epic = '', links = [], date }) {
  const dir = tasksDir(pm);
  fs.mkdirSync(dir, { recursive: true });
  const prefix = taskPrefix(pm);
  let n = nextNumber(pm);
  for (;;) {
    const id = idOf(prefix, n);
    const file = path.join(dir, `${id}.md`);
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      n += 1;
      continue;
    }
    const data = {
      id,
      title,
      status: 'todo',
      order: order ?? n,
      depends_on: deps,
      waiting_on: '',
      worktrees: [],
      milestone,
      links,
      updated: date,
      epic,
    };
    fs.writeSync(fd, serialize(data, TEMPLATE_BODY));
    fs.closeSync(fd);
    return { file, id, data, body: TEMPLATE_BODY };
  }
}

export function setFields(pm, id, fields, date) {
  const task = readTask(pm, id);
  const wasWaiting = task.data.status === 'waiting';
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id') throw new Error('id cannot be changed');
    if (k === 'status' && !STATUSES.includes(v)) throw new Error(`bad status "${v}"; use ${STATUSES.join(' | ')}`);
    if (k === 'order') {
      task.data.order = parseOrder(v);
    } else if (LIST_FIELDS.includes(k)) {
      task.data[k] = toArray(v);
    } else {
      task.data[k] = v;
    }
  }
  if ('status' in fields && fields.status !== 'waiting' && !('waiting_on' in fields)) task.data.waiting_on = '';
  if ('status' in fields && fields.status !== 'review' && !('review_at' in fields)) delete task.data.review_at;
  // next is a promise for a todo task; any other status has already answered it.
  if (task.data.status !== 'todo') delete task.data.next;
  if (task.data.status !== 'waiting') delete task.data.waiting_since;
  else if (!wasWaiting) task.data.waiting_since = date; // a 0.10 file already waiting keeps no date: the audit falls back to updated
  // Set by hand, review still needs its start: a merge before it is an earlier PR, a merge after it closes the task.
  if (task.data.status === 'review' && !task.data.review_at) task.data.review_at = new Date().toISOString();
  if (task.data.status === 'waiting' && !task.data.waiting_on) {
    throw new Error('status waiting needs waiting_on="<what we are waiting for>"');
  }
  task.data.updated = date;
  writeTask(task);
  return task;
}

// One next task per epic: the task's own epic key ('' = the repo-wide group), never the worktree's.
export function setNext(pm, id, date) {
  const task = readTask(pm, id);
  if (task.data.status !== 'todo') throw new Error(`${id} is ${task.data.status} — only a todo task can be next`);
  for (const t of listTasks(pm)) {
    if (t.id !== id && t.data.next && t.data.epic === task.data.epic) {
      delete t.data.next;
      writeTask(t);
    }
  }
  task.data.next = date;
  task.data.updated = date;
  writeTask(task);
  return task;
}

export function clearNext(pm, id) {
  for (const t of listTasks(pm)) {
    if (t.data.next && (!id || t.id === id)) {
      delete t.data.next;
      writeTask(t);
    }
  }
}

export const nextTask = (tasks, epic = '') => tasks.find((t) => t.data.next && t.data.status === 'todo' && t.data.epic === epic);

export function claim(pm, id, worktree, date, branch = '') {
  const task = readTask(pm, id);
  const worktrees = [...new Set([...task.data.worktrees, worktree])];
  // A task awaiting merge keeps its status, branch, pr and review_at; continuing work is `pm set <id> status=in_progress`.
  if (task.data.status === 'review') return setFields(pm, id, { worktrees }, date);
  return setFields(pm, id, { status: 'in_progress', worktrees, ...(branch && { branch }) }, date);
}

// Log is the last section of a task file, so entries are appended at the end of the body.
export function appendLogLine(pm, id, line, date) {
  const task = readTask(pm, id);
  task.body = `${task.body.replace(/\n*$/, '\n')}${line}\n`;
  task.data.updated = date;
  writeTask(task);
  return task;
}

export function appendLog(pm, id, { worktree, did, next, date }) {
  return appendLogLine(pm, id, `- ${date} · ${worktree} · did: ${did} · next: ${next}`, date);
}

// The retro checkpoint: one `retro:` line per day and worktree; ids accumulate, `none` never overrides an id.
export function appendRetro(pm, id, what, worktree, date) {
  const task = readTask(pm, id);
  const head = `- ${date} · ${worktree} · retro: `;
  const lines = task.body.split('\n');
  const i = lines.findIndex((l) => l.startsWith(head));
  if (i === -1) return appendLogLine(pm, id, `${head}${what}`, date);
  const ids = lines[i].slice(head.length).split(',').map((s) => s.trim()).filter((s) => s && s !== 'none');
  if (what !== 'none' && !ids.includes(what)) ids.push(what);
  lines[i] = `${head}${ids.join(', ') || 'none'}`;
  task.body = lines.join('\n');
  task.data.updated = date;
  writeTask(task);
  return task;
}

const LOG_RE = /^- (\d{4}-\d{2}-\d{2}) · /;
const logDates = (task, filter) => task.body.split('\n').filter((l) => LOG_RE.test(l) && filter(l)).map((l) => l.match(LOG_RE)[1]);
// Date of the last Log line a person (or the agent) wrote — auto notes from hooks do not count.
export const lastManualLogDate = (task) => logDates(task, (l) => / · did: /.test(l)).at(-1) ?? null;
export const lastLogDate = (task) => logDates(task, () => true).at(-1) ?? null;

export function lastNext(task) {
  const last = task.body.split('\n').filter((l) => l.includes(' · next: ')).at(-1);
  if (!last) return null;
  const [date, who] = last.replace(/^- /, '').split(' · ');
  return { date, who, next: last.slice(last.indexOf(' · next: ') + ' · next: '.length) };
}

export const isOpen = (t) => !['done', 'dropped'].includes(t.data.status);

// An empty epic marks a repo-wide task: it stays visible in every epic's view.
export const byEpic = (tasks, epic) => (epic ? tasks.filter((t) => !t.data.epic || t.data.epic === epic) : tasks);

// The epic of a worktree is what it claimed — never its branch or directory name.
export function activeEpic(tasks, worktree) {
  const mine = tasks.filter((t) => t.data.worktrees.includes(worktree));
  const epics = (ts) => new Set(ts.map((t) => t.data.epic).filter(Boolean));
  const open = epics(mine.filter(isOpen));
  const found = open.size ? open : epics(mine); // last task closed: the worktree still remembers its direction
  return found.size === 1 ? [...found][0] : '';
}

// One epic's tasks by state (its own key only, repo-wide tasks are not part of it). The printed parts — ready,
// blocked, in progress, waiting, in review — sum to open; total leaves dropped tasks out.
export function epicProgress(tasks, epic) {
  const status = new Map(tasks.map((t) => [t.id, t.data.status]));
  const met = (t) => t.data.depends_on.every((d) => ['done', 'dropped'].includes(status.get(d)));
  const own = tasks.filter((t) => t.data.epic === epic);
  const count = (fn) => own.filter(fn).length;
  const is = (s) => (t) => t.data.status === s;
  return {
    open: count(isOpen),
    ready: count((t) => is('todo')(t) && met(t)),
    blocked: count((t) => is('todo')(t) && !met(t)),
    inProgress: count(is('in_progress')),
    waiting: count(is('waiting')),
    review: count(is('review')),
    done: count(is('done')),
    dropped: count(is('dropped')),
    total: count((t) => !is('dropped')(t)),
  };
}

const PARTS = [['ready', 'ready'], ['blocked', 'blocked'], ['inProgress', 'in progress'], ['waiting', 'waiting'], ['review', 'in review']];
export const epicParts = (p) => PARTS.filter(([k]) => p[k]).map(([k, label]) => `${p[k]} ${label}`).join(', ');
// How an epic without open tasks ended: its done count, or its dropped count when nothing was done.
export const epicClosed = (p) => (p.done || !p.dropped ? `${p.done} done` : `${p.dropped} dropped`);
// Why an epic has nothing ready: what is still open, or that nothing is.
export const epicNothingReady = (p) => (p.open ? `${p.open} open, none ready (${epicParts(p)})` : `no open tracked tasks (${epicClosed(p)})`);

// pm done and pm reconcile, after closing: what is left of the epic, or that its last open task just closed.
export function epicLeftLine(tasks, epic) {
  const p = epicProgress(tasks, epic);
  if (p.open) return `epic ${epic}: ${p.open} left (${epicParts(p)})`;
  return `epic ${epic}: that was the last open task — no open tracked tasks. Update or remove its focus line in PLAN.md; /close asks which direction is next.`;
}

export function readyQueue(tasks) {
  const status = new Map(tasks.map((t) => [t.id, t.data.status]));
  return tasks
    .filter((t) => t.data.status === 'todo' && t.data.depends_on.every((d) => ['done', 'dropped'].includes(status.get(d))))
    .sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
}

export function validate(tasks) {
  const problems = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    if (t.data.id !== t.id) problems.push(`${t.id}: frontmatter id is ${t.data.id}`);
    if (!STATUSES.includes(t.data.status)) problems.push(`${t.id}: bad status "${t.data.status}"`);
    if (t.data.status === 'waiting' && !t.data.waiting_on) problems.push(`${t.id}: waiting without waiting_on`);
    for (const d of t.data.depends_on) {
      if (!byId.has(d)) problems.push(`${t.id}: depends on unknown ${d}`);
      else if (byId.get(d).data.status === 'dropped') problems.push(`${t.id}: depends on dropped ${d}`);
    }
  }
  const state = new Map(); // 1 = on the current path, 2 = finished
  const visit = (id, trail) => {
    if (!byId.has(id) || state.get(id) === 2) return;
    if (state.get(id) === 1) {
      problems.push(`cycle: ${[...trail.slice(trail.indexOf(id)), id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    for (const d of byId.get(id).data.depends_on) visit(d, [...trail, id]);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id, []);
  return problems;
}
