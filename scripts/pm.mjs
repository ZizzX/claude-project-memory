#!/usr/bin/env node
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pmDir, worktreeName, today } from './lib/paths.mjs';
import { hasBoard, initBoard, persist } from './lib/store.mjs';
import { listTasks, newTask, setFields, claim, appendLog, readyQueue, validate } from './lib/tasks.mjs';
import { appendDecision } from './lib/decisions.mjs';
import { writeBoard } from './lib/board.mjs';
import { buildSummary } from './lib/summary.mjs';
import { scanPlans } from './lib/scan.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const USAGE = `usage: pm <command>
  init                                         create the local board for this repo
  task new --title T [--order N] [--deps T-001,T-002] [--milestone M1] [--links a,b]
  set <id> key=value ...                       update task fields (status, order, depends_on, waiting_on, ...)
  claim <id>                                   attach this worktree and set in_progress
  log <id> --did "..." --next "..."            append a work log entry
  decision --title T --why W --rejected R [--tasks T-001,T-002]
  ready | validate | board | summary | scan
  sync [on [--remote url] [--yes] | off]       opt-in sync of board and memory across machines
  hook <event>                                 hook entry point (used by the plugin)`;

class UsageError extends Error {}
const fail = (msg) => {
  throw new UsageError(msg);
};
const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const strings = (args, names) => parseArgs({ args, options: Object.fromEntries(names.map((n) => [n, { type: 'string' }])) }).values;

function requireBoard(cwd) {
  if (!hasBoard(cwd)) fail('no board here — run: pm init');
  return pmDir(cwd);
}

const commands = {
  init(cwd) {
    const { pm, created } = initBoard(cwd, today());
    return `${created ? 'created' : 'exists'}: ${pm}`;
  },

  task(cwd, [sub, ...args]) {
    if (sub !== 'new') fail(USAGE);
    const v = strings(args, ['title', 'order', 'deps', 'milestone', 'links']);
    if (!v.title) fail('--title is required');
    const pm = requireBoard(cwd);
    const t = newTask(pm, {
      title: v.title,
      order: v.order === undefined ? undefined : Number(v.order),
      deps: list(v.deps),
      milestone: v.milestone ?? '',
      links: list(v.links),
      date: today(),
    });
    persist(pm, `pm: task new ${t.id}`);
    return `${t.id} created: ${t.file}`;
  },

  set(cwd, [id, ...pairs]) {
    if (!id || !pairs.length) fail('usage: pm set <id> key=value ...');
    const fields = Object.fromEntries(pairs.map((p) => {
      const i = p.indexOf('=');
      if (i < 1) fail(`bad field "${p}", use key=value`);
      return [p.slice(0, i), p.slice(i + 1)];
    }));
    const pm = requireBoard(cwd);
    setFields(pm, id, fields, today());
    persist(pm, `pm: set ${id} ${pairs.join(' ')}`);
    return `${id} updated`;
  },

  claim(cwd, [id]) {
    if (!id) fail('usage: pm claim <id>');
    const pm = requireBoard(cwd);
    const wt = worktreeName(cwd);
    claim(pm, id, wt, today());
    persist(pm, `pm: claim ${id}`);
    return `${id} claimed by ${wt}`;
  },

  log(cwd, [id, ...args]) {
    const v = strings(args, ['did', 'next']);
    if (!id || !v.did || !v.next) fail('usage: pm log <id> --did "..." --next "..."');
    const pm = requireBoard(cwd);
    appendLog(pm, id, { worktree: worktreeName(cwd), did: v.did, next: v.next, date: today() });
    persist(pm, `pm: log ${id}`);
    return `${id} logged`;
  },

  decision(cwd, args) {
    const v = strings(args, ['title', 'why', 'rejected', 'tasks']);
    if (!v.title || !v.why || !v.rejected) fail('usage: pm decision --title T --why W --rejected R [--tasks T-001]');
    const pm = requireBoard(cwd);
    const id = appendDecision(pm, { title: v.title, why: v.why, rejected: v.rejected, tasks: list(v.tasks), date: today() });
    persist(pm, `pm: decision ${id}`);
    return `${id} recorded`;
  },

  ready(cwd) {
    return readyQueue(listTasks(requireBoard(cwd))).map((t) => `${t.id} ${t.data.title}`).join('\n') || '(nothing ready)';
  },

  validate(cwd) {
    const problems = validate(listTasks(requireBoard(cwd)));
    if (!problems.length) return 'ok';
    process.exitCode = 1;
    return problems.join('\n');
  },

  board(cwd) {
    const pm = requireBoard(cwd);
    writeBoard(pm);
    return path.join(pm, 'board.html');
  },

  scan(cwd) {
    requireBoard(cwd);
    return scanPlans(cwd).map((p) => `${p.done}/${p.total}  ${p.path}`).join('\n') || '(no plans found)';
  },

  summary(cwd) {
    return buildSummary({ pm: requireBoard(cwd), worktree: worktreeName(cwd), scriptPath: SCRIPT });
  },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const run = Object.hasOwn(commands, cmd) ? commands[cmd] : null;
  if (!run) fail(USAGE);
  const out = await run(process.cwd(), args);
  if (out) console.log(out);
}

main().catch((e) => {
  console.error(e instanceof UsageError ? e.message : `pm: ${e.message}`);
  process.exit(1);
});
