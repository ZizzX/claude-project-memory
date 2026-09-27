import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { git, tryGit, pmDir, mainRoot } from './paths.mjs';
import { planTemplate } from './plan.mjs';
import { writeBoard } from './board.mjs';

const PM_SCRIPT = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const GITIGNORE = '.state/\nBOARD.md\nboard.html\n';
const GITATTRIBUTES = 'decisions.md merge=union\nmemory/MEMORY.md merge=union\n';

export function hasBoard(cwd) {
  const pm = pmDir(cwd);
  return Boolean(pm && fs.existsSync(path.join(pm, '.git')));
}

// Commits work even on machines without a configured git identity.
export function identityArgs(pm) {
  return tryGit(['config', 'user.email'], pm) ? [] : ['-c', 'user.name=pm', '-c', 'user.email=pm@localhost'];
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function commitPm(pm, message) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      git(['add', '-A'], pm);
      if (tryGit(['diff', '--cached', '--quiet'], pm) !== null) return false; // nothing staged
      git([...identityArgs(pm), 'commit', '-q', '-m', message], pm);
      return true;
    } catch {
      sleep(300); // usually index.lock held by a concurrent pm process
    }
  }
  return false;
}

export const isSyncOn = (pm) => tryGit(['remote', 'get-url', 'origin'], pm) !== null;

export function backgroundPush(pm) {
  if (process.env.PM_NO_BACKGROUND) return; // test seam
  spawn(process.execPath, [PM_SCRIPT, '_push', pm], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function persist(pm, message, tasks) {
  writeBoard(pm, tasks);
  if (commitPm(pm, message) && isSyncOn(pm)) backgroundPush(pm);
}

const stateFile = (pm, name) => path.join(pm, '.state', `${String(name).replace(/[^\w.-]/g, '_')}.json`);

export function readState(pm, name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(pm, name), 'utf8'));
  } catch {
    return {};
  }
}

// temp + rename: a reader never sees a half-written file, an interrupted write leaves the previous one.
export function writeState(pm, name, value) {
  fs.mkdirSync(path.join(pm, '.state'), { recursive: true });
  const file = stateFile(pm, name);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}

// The Stop nudge compares board-file mtimes. An automatic write (commit capture) records the mtime it replaced,
// so the nudge keeps seeing the last manual update. Restoring the old mtime instead would hide the change from
// git's index when the size is unchanged.
const AUTO_MTIME = 'auto-mtime';

export function autoWrite(pm, file, write) {
  const auto = readState(pm, AUTO_MTIME);
  const name = path.basename(file);
  const current = fs.statSync(file).mtimeMs;
  const before = auto[name]?.after === current ? auto[name].before : current;
  write();
  auto[name] = { before, after: fs.statSync(file).mtimeMs };
  writeState(pm, AUTO_MTIME, auto);
}

export function manualMtime(pm, file) {
  const mtime = fs.statSync(file).mtimeMs;
  const auto = readState(pm, AUTO_MTIME)[path.basename(file)];
  return auto?.after === mtime ? auto.before : mtime;
}

export function initBoard(cwd, date) {
  const pm = pmDir(cwd);
  if (!pm) throw new Error('not inside a git repository');
  if (fs.existsSync(path.join(pm, '.git'))) return { pm, created: false };
  fs.mkdirSync(path.join(pm, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(pm, '.gitignore'), GITIGNORE);
  fs.writeFileSync(path.join(pm, '.gitattributes'), GITATTRIBUTES);
  fs.writeFileSync(path.join(pm, 'tasks', '.gitkeep'), '');
  fs.writeFileSync(path.join(pm, 'PLAN.md'), planTemplate(path.basename(mainRoot(cwd)), date));
  fs.writeFileSync(path.join(pm, 'decisions.md'), '# Decisions\n');
  git(['init', '-q', '-b', 'pm'], pm);
  writeBoard(pm);
  commitPm(pm, 'pm: init');
  return { pm, created: true };
}
