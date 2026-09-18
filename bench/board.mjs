// Board write time on synthetic boards: node bench/board.mjs [sizes...]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newTask, setFields, appendLog } from '../scripts/lib/tasks.mjs';
import { planTemplate, planFile } from '../scripts/lib/plan.mjs';
import { appendDecision, decisionsFile } from '../scripts/lib/decisions.mjs';
import { writeBoard } from '../scripts/lib/board.mjs';

const D = '2026-09-16';
const STATUSES = ['todo', 'in_progress', 'waiting', 'done', 'done', 'dropped'];

function board(n) {
  const pm = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-bench-'));
  const epics = Array.from({ length: Math.max(1, Math.round(n / 7)) }, (_, i) => `E${i}`);
  fs.writeFileSync(planFile(pm), planTemplate('bench', D).replace('## Current focus\n', `## Current focus\n${epics.map((e) => `- ${e}: work`).join('\n')}\n`));
  fs.writeFileSync(decisionsFile(pm), '# Decisions\n');
  for (let i = 1; i <= n; i += 1) {
    const { id } = newTask(pm, { title: `task ${i} ${'words '.repeat(i % 20)}`, epic: epics[i % epics.length], deps: i > 1 && i % 3 === 0 ? [`T-${String(i - 1).padStart(3, '0')}`] : [], date: D });
    const status = STATUSES[i % STATUSES.length];
    appendLog(pm, id, { worktree: 'wt', did: 'something', next: 'the next step', date: D });
    // Half of the done tasks closed long ago, so the Archive cards are part of the measured page.
    setFields(pm, id, status === 'waiting' ? { status, waiting_on: 'x' } : { status }, status === 'done' && i % 2 ? '2026-01-01' : D);
    if (i % 5 === 0) appendDecision(pm, { title: `d${i}`, why: 'w', rejected: 'r', tasks: [id], date: D });
  }
  return pm;
}

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const n of (process.argv.slice(2).length ? process.argv.slice(2) : ['50', '500']).map(Number)) {
  const pm = board(n);
  const runs = [];
  for (let i = 0; i < 21; i += 1) {
    const t = performance.now();
    writeBoard(pm);
    runs.push(performance.now() - t);
  }
  const kb = (f) => Math.round(fs.statSync(path.join(pm, f)).size / 1024);
  console.log(`${n} tasks: writeBoard median ${median(runs).toFixed(1)} ms · board.html ${kb('board.html')} KB · BOARD.md ${kb('BOARD.md')} KB`);
  fs.rmSync(pm, { recursive: true, force: true });
}
