import fs from 'node:fs';
import path from 'node:path';
import { parse, serialize } from './frontmatter.mjs';

export const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'dropped'];
const ID_RE = /^T-(\d+)\.md$/;
const TEMPLATE_BODY = '## Goal\n\n## Understanding\n\n## Checklist\n\n## Log\n';
const LIST_FIELDS = ['depends_on', 'worktrees', 'links'];

export const tasksDir = (pm) => path.join(pm, 'tasks');
const idOf = (n) => `T-${String(n).padStart(3, '0')}`;
const toArray = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

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
  };
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
  const file = path.join(tasksDir(pm), `${id}.md`);
  if (!fs.existsSync(file)) throw new Error(`unknown task ${id}`);
  return readTaskFile(file);
}

export function writeTask(task) {
  fs.writeFileSync(task.file, serialize(task.data, task.body));
}

// The id is reserved by creating T-NNN.md exclusively, so concurrent processes never share an id.
export function newTask(pm, { title, order, deps = [], milestone = '', links = [], date }) {
  const dir = tasksDir(pm);
  fs.mkdirSync(dir, { recursive: true });
  let n = Math.max(0, ...fs.readdirSync(dir).map((f) => Number(f.match(ID_RE)?.[1] ?? 0))) + 1;
  for (;;) {
    const id = idOf(n);
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
    };
    fs.writeSync(fd, serialize(data, TEMPLATE_BODY));
    fs.closeSync(fd);
    return { file, id, data, body: TEMPLATE_BODY };
  }
}

export function setFields(pm, id, fields, date) {
  const task = readTask(pm, id);
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id') throw new Error('id cannot be changed');
    if (k === 'status' && !STATUSES.includes(v)) throw new Error(`bad status "${v}"; use ${STATUSES.join(' | ')}`);
    if (k === 'order') {
      const n = Number(v);
      if (Number.isNaN(n)) throw new Error(`order must be a number, got "${v}"`);
      task.data.order = n;
    } else if (LIST_FIELDS.includes(k)) {
      task.data[k] = toArray(v);
    } else {
      task.data[k] = v;
    }
  }
  if ('status' in fields && fields.status !== 'waiting' && !('waiting_on' in fields)) task.data.waiting_on = '';
  if (task.data.status === 'waiting' && !task.data.waiting_on) {
    throw new Error('status waiting needs waiting_on="<what we are waiting for>"');
  }
  task.data.updated = date;
  writeTask(task);
  return task;
}

export function claim(pm, id, worktree, date) {
  const task = readTask(pm, id);
  const worktrees = [...new Set([...task.data.worktrees, worktree])];
  return setFields(pm, id, { status: 'in_progress', worktrees }, date);
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

export function lastNext(task) {
  const last = task.body.split('\n').filter((l) => l.includes(' · next: ')).at(-1);
  if (!last) return null;
  const [date, who] = last.replace(/^- /, '').split(' · ');
  return { date, who, next: last.slice(last.indexOf(' · next: ') + ' · next: '.length) };
}
