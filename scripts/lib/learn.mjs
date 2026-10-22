import fs from 'node:fs';
import path from 'node:path';
import { parse, serialize } from './frontmatter.mjs';
import { boardConfig, writeConfig, readTask, appendRetro } from './tasks.mjs';

// A learning: symptom → fix → how to apply, keyed by `pattern` (area.symptom) so the same lesson is
// counted, not duplicated. Written only by the retro; read by the summary from frontmatter alone.
export const CAP = 100;
export const PROMOTE = { seen: 3, tasks: 2 };
export const STATUSES = ['active', 'promoted', 'retired'];
export const PATTERN_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const ID_RE = /^L-(\d+)\.md$/;

export const learningsDir = (pm) => path.join(pm, 'learnings');
const fileOf = (pm, id) => path.join(learningsDir(pm), `${id}.md`);

const template = ({ symptom = '', fix = '', apply = '' }) => `## Symptom\n${symptom}\n\n## Fix\n${fix}\n\n## Apply\n${apply}\n`;
const toArray = (v) => (Array.isArray(v) ? v : v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

function readFile(file) {
  const { data: raw, body } = parse(fs.readFileSync(file, 'utf8'));
  if (!raw.id) return null; // not a learning (no frontmatter): skipped, never fatal
  // A hand-written file may lack fields; defaults keep the summary and the audit alive.
  const data = {
    ...raw,
    title: String(raw.title ?? ''),
    pattern: String(raw.pattern ?? ''),
    status: STATUSES.includes(raw.status) ? raw.status : 'active',
    seen: Number(raw.seen) || 1,
    first: String(raw.first ?? raw.last ?? ''),
    last: String(raw.last ?? raw.first ?? ''),
    tasks: toArray(raw.tasks),
    promoted_to: raw.promoted_to ?? '',
    retired_why: raw.retired_why ?? '',
  };
  return { file, id: path.basename(file, '.md'), data, body };
}

export function listLearnings(pm) {
  const dir = learningsDir(pm);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => ID_RE.test(f))
    .map((f) => {
      try {
        return readFile(path.join(dir, f));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readLearning(pm, id) {
  if (!ID_RE.test(`${id}.md`)) throw new Error(`bad learning id "${id}" — expected L-NNN`);
  const file = fileOf(pm, id);
  if (!fs.existsSync(file)) throw new Error(`unknown learning ${id}`);
  return readFile(file);
}

function write(l) {
  fs.writeFileSync(l.file, serialize(l.data, l.body));
}

export const promotable = (l) => l.data.status === 'active' && l.data.seen >= PROMOTE.seen && new Set(l.data.tasks).size >= PROMOTE.tasks;
export const promoteHint = (id) => `promote? pm learn promote ${id} --to <file#section>`;

// The audit asks for retro lines only on tasks closed after the board started recording them.
export function setRetroSince(pm, date) {
  if (!boardConfig(pm).retroSince) writeConfig(pm, { retroSince: date });
}

const checkPattern = (p) => {
  if (!PATTERN_RE.test(p ?? '')) throw new Error(`pattern must look like area.symptom (lowercase, dots, dashes), got "${p ?? ''}"`);
  return p;
};

// Near misses: the same area, or a long word of the title in common — enough to make the agent look.
export function similar(all, { pattern, title }, exclude) {
  const area = pattern.split('.')[0];
  const words = new Set(String(title).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 5));
  return all.filter((l) => l.id !== exclude && l.data.status === 'active' && (
    l.data.pattern.split('.')[0] === area
    || String(l.data.title).toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => words.has(w))
  ));
}

const retroLine = (pm, tasks, id, worktree, date) => tasks.forEach((t) => appendRetro(pm, t, id, worktree, date));

export function addLearning(pm, { title, pattern, symptom, fix, apply, tasks = [], worktree, date }) {
  if (!title) throw new Error('--title is required');
  checkPattern(pattern);
  for (const t of tasks) readTask(pm, t); // an unknown id fails before anything is written
  const all = listLearnings(pm);
  const same = all.find((l) => l.data.pattern === pattern && l.data.status === 'active')
    ?? all.find((l) => l.data.pattern === pattern && l.data.status === 'retired');
  const promoted = !same && all.find((l) => l.data.pattern === pattern);
  if (promoted) return { id: promoted.id, created: false, note: `${promoted.id} is promoted to ${promoted.data.promoted_to} — nothing written` };
  setRetroSince(pm, date);
  if (same) {
    const known = tasks.every((t) => same.data.tasks.includes(t));
    if (same.data.status === 'active' && known && same.data.last === date) {
      return { id: same.id, created: false, seen: same.data.seen, tasks: same.data.tasks, note: `${same.id} already recorded today` };
    }
    const reactivated = same.data.status === 'retired';
    same.data.status = 'active';
    same.data.retired_why = '';
    same.data.seen += 1;
    same.data.last = date;
    same.data.tasks = [...new Set([...same.data.tasks, ...tasks])];
    write(same);
    retroLine(pm, tasks, same.id, worktree, date);
    const head = reactivated ? `${same.id} reactivated (seen ${same.data.seen})` : `${same.id} seen ${same.data.seen} (${same.data.tasks.join(', ')}) — same lesson; edit the Fix if it changed`;
    return { id: same.id, created: false, seen: same.data.seen, tasks: same.data.tasks, promote: promotable(same), note: head };
  }
  const active = all.filter((l) => l.data.status === 'active').length;
  if (active >= CAP) throw new Error(`${active} active learnings — retire or promote first (pm learn list shows them)`);
  fs.mkdirSync(learningsDir(pm), { recursive: true });
  let n = Math.max(0, ...all.map((l) => Number(l.id.slice(2)))) + 1;
  for (;;) {
    const id = `L-${String(n).padStart(3, '0')}`;
    const file = fileOf(pm, id);
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      n += 1;
      continue;
    }
    const data = { id, title, pattern, status: 'active', seen: 1, first: date, last: date, tasks, promoted_to: '', retired_why: '' };
    fs.writeSync(fd, serialize(data, template({ symptom, fix, apply })));
    fs.closeSync(fd);
    retroLine(pm, tasks, id, worktree, date);
    return { id, created: true, seen: 1, tasks, similar: similar(all, { pattern, title }, id).slice(0, 3).map((l) => `${l.id} ${l.data.pattern}`), note: `${id} recorded: ${file}` };
  }
}

export function findLearnings(pm, words) {
  const needles = words.map((w) => w.toLowerCase()).filter(Boolean);
  if (!needles.length) return [];
  return listLearnings(pm).filter((l) => {
    if (l.data.status !== 'active') return false;
    const hay = `${l.data.title}\n${l.data.pattern}\n${l.body}`.toLowerCase();
    return needles.every((w) => hay.includes(w));
  });
}

export function promoteLearning(pm, id, to, date) {
  if (!to) throw new Error('usage: pm learn promote L-001 --to <file#section>');
  const l = readLearning(pm, id);
  l.data.status = 'promoted';
  l.data.promoted_to = to;
  l.data.last = date;
  write(l);
  return l;
}

export function retireLearning(pm, id, why, date) {
  if (!why) throw new Error('usage: pm learn retire L-001 --why "…"');
  const l = readLearning(pm, id);
  l.data.status = 'retired';
  l.data.retired_why = why;
  l.data.last = date;
  write(l);
  return l;
}

export function retroNone(pm, id, worktree, date) {
  readTask(pm, id);
  setRetroSince(pm, date);
  appendRetro(pm, id, 'none', worktree, date);
}

// Ids with no `retro:` line dated `date` — what /close still owes.
export function checkRetro(pm, ids, date) {
  return ids.filter((id) => !readTask(pm, id).body.split('\n').some((l) => l.startsWith(`- ${date} · `) && / · retro: /.test(l)));
}

export const brief = (l) => `${l.id} · ${l.data.status === 'active' ? `seen ${l.data.seen}` : l.data.status} · ${l.data.last} · ${l.data.title}`;
