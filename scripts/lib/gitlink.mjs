import fs from 'node:fs';
import { tryGit, worktreeName, today } from './paths.mjs';
import { readState, writeState, autoWrite } from './store.mjs';
import { listTasks, readTask, writeTask, appendLogLine } from './tasks.mjs';

// Reflog subjects of commits created in this worktree. Merges, pulls, resets, checkouts and rebases are skipped:
// they move HEAD to commits made — and captured — somewhere else.
const TAKEN = /^(commit|commit \(initial\)|commit \(amend\)|cherry-pick|revert): /;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/; // SHA-1 or SHA-256
const short = (sha) => sha.slice(0, 12);
const cursorName = (worktree) => `capture-${worktree}`;

export function currentBranch(cwd) {
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return branch && branch !== 'HEAD' ? branch : '';
}

// ponytail: reads the files-backend reflog; a reftable repository has no logs/HEAD and captures nothing.
function reflogFile(cwd) {
  return tryGit(['rev-parse', '--path-format=absolute', '--git-path', 'logs/HEAD'], cwd);
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

// Complete lines after byte `offset`: "<old> <new> <name> <email> <time> <tz>\t<subject>" (git update-ref).
// A file shorter than the offset (expired reflog) yields nothing and restarts the cursor at its size.
// ponytail: a reflog rewritten by gc that grew past the offset again is read from a cut line; that line fails
// the OID check and is dropped. Store the last consumed line in the cursor if this ever loses real commits.
export function reflogSince(file, offset) {
  const size = sizeOf(file);
  if (size <= offset) return { entries: [], offset: size };
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  const end = buf.lastIndexOf(0x0a) + 1; // a line git is still writing waits for the next capture
  const entries = buf.subarray(0, end).toString('utf8').split('\n').map((line) => {
    const [old = '', sha = ''] = line.split(' ', 2);
    const tab = line.indexOf('\t');
    return { old, sha, subject: tab === -1 ? '' : line.slice(tab + 1) };
  }).filter((e) => OID.test(e.old) && OID.test(e.sha));
  return { entries, offset: offset + end };
}

export function startCapture(pm, cwd) {
  const worktree = worktreeName(cwd);
  const file = worktree && reflogFile(cwd);
  if (file) writeState(pm, cursorName(worktree), { offset: sizeOf(file) });
}

// Links commits created in this worktree since the last capture to its one task in progress.
// Never throws: a failed capture only means nothing was linked this time.
export function captureCommits(pm, cwd, tasks) {
  try {
    const worktree = worktreeName(cwd);
    const open = (tasks ?? listTasks(pm)).filter((t) => t.data.status === 'in_progress' && t.data.worktrees.includes(worktree));
    if (!open.length) return;
    const file = reflogFile(cwd);
    if (!file) return;
    const cursor = readState(pm, cursorName(worktree));
    if (typeof cursor.offset !== 'number') {
      startCapture(pm, cwd); // claimed before capture existed: start now, no backfill
      return;
    }
    const { entries, offset } = reflogSince(file, cursor.offset);
    writeState(pm, cursorName(worktree), { offset });
    const taken = entries.filter((e) => TAKEN.test(e.subject));
    if (!taken.length) return;
    if (open.length > 1) {
      const shas = taken.map((e) => short(e.sha)).join(', ');
      const line = `- ${today()} · ${worktree} · auto: commits not attributed (${open.length} tasks in progress): ${shas} — pm set T-NNN commits=…`;
      for (const t of open) autoWrite(pm, t.file, () => appendLogLine(pm, t.id, line, today()));
      return;
    }
    const task = readTask(pm, open[0].id); // fresh read: the caller's list may predate edits made this turn
    const before = task.data.commits ?? [];
    const commits = [...before];
    for (const e of taken) {
      const amended = e.subject.startsWith('commit (amend)') ? commits.indexOf(short(e.old)) : -1;
      if (amended !== -1) commits.splice(amended, 1);
      if (!commits.includes(short(e.sha))) commits.push(short(e.sha));
    }
    if (commits.join() === before.join()) return;
    task.data.commits = commits;
    autoWrite(pm, task.file, () => writeTask(task));
  } catch (e) {
    if (process.env.PM_DEBUG) console.error(e);
  }
}
