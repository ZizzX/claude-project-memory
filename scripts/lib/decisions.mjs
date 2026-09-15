import fs from 'node:fs';
import path from 'node:path';

export const decisionsFile = (pm) => path.join(pm, 'decisions.md');
const HEAD_RE = /^## (D-\d+) · ([^·\n]+) · (.+)$/gm;

function entries(pm) {
  const file = decisionsFile(pm);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return [...text.matchAll(HEAD_RE)].map((m) => ({ id: m[1], date: m[2].trim(), title: m[3].trim() }));
}

// One append per decision: the log is append-only and merges by union across machines.
export function appendDecision(pm, { title, why, rejected, tasks = [], date }) {
  const n = Math.max(0, ...entries(pm).map((e) => Number(e.id.slice(2)))) + 1;
  const id = `D-${String(n).padStart(3, '0')}`;
  const lines = [`## ${id} · ${date} · ${title}`, `- why: ${why}`, `- rejected: ${rejected}`];
  if (tasks.length) lines.push(`- tasks: ${tasks.join(', ')}`);
  fs.appendFileSync(decisionsFile(pm), `\n${lines.join('\n')}\n`);
  return id;
}

export function recentDecisions(pm, n = 3) {
  return entries(pm).slice(-n).reverse();
}

// Decisions whose "- tasks:" line names `id`, oldest first.
export function decisionsFor(pm, id) {
  const file = decisionsFile(pm);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const heads = [...text.matchAll(HEAD_RE)];
  return heads
    .filter((m, i) => {
      const body = text.slice(m.index, heads[i + 1]?.index ?? text.length);
      const tasks = body.match(/^- tasks: (.+)$/m)?.[1].split(',').map((s) => s.trim()) ?? [];
      return tasks.includes(id);
    })
    .map((m) => ({ id: m[1], date: m[2].trim(), title: m[3].trim() }));
}
