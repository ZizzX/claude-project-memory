import fs from 'node:fs';
import path from 'node:path';

export const decisionsFile = (pm) => path.join(pm, 'decisions.md');
const HEAD_RE = /^## (D-\d+) · ([^·\n]+) · (.+)$/gm;

export function readDecisions(pm) {
  const file = decisionsFile(pm);
  return fs.existsSync(file) ? parseDecisions(fs.readFileSync(file, 'utf8')) : [];
}

// Every entry with the task ids of its "- tasks:" line, oldest first.
export function parseDecisions(text) {
  const src = text.replace(/\r\n/g, '\n');
  const heads = [...src.matchAll(HEAD_RE)];
  return heads.map((m, i) => {
    const body = src.slice(m.index, heads[i + 1]?.index ?? src.length);
    const tasks = body.match(/^- tasks: (.+)$/m)?.[1].split(',').map((s) => s.trim()) ?? [];
    return { id: m[1], date: m[2].trim(), title: m[3].trim(), tasks };
  });
}

const brief = ({ id, date, title }) => ({ id, date, title });

// One append per decision: the log is append-only and merges by union across machines.
export function appendDecision(pm, { title, why, rejected, tasks = [], date }) {
  const n = Math.max(0, ...readDecisions(pm).map((e) => Number(e.id.slice(2)))) + 1;
  const id = `D-${String(n).padStart(3, '0')}`;
  const lines = [`## ${id} · ${date} · ${title}`, `- why: ${why}`, `- rejected: ${rejected}`];
  if (tasks.length) lines.push(`- tasks: ${tasks.join(', ')}`);
  fs.appendFileSync(decisionsFile(pm), `\n${lines.join('\n')}\n`);
  return id;
}

export function recentDecisions(pm, n = 3) {
  return readDecisions(pm).slice(-n).reverse().map(brief);
}

// Decisions whose "- tasks:" line names `id`, oldest first.
export function decisionsFor(pm, id) {
  return readDecisions(pm).filter((d) => d.tasks.includes(id)).map(brief);
}
