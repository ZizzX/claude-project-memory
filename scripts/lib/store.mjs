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
