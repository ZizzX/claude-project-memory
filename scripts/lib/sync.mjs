import fs from 'node:fs';
import path from 'node:path';
import { git, tryGit, pmDir, today } from './paths.mjs';
import { hasBoard, initBoard, identityArgs } from './store.mjs';
import { writeBoard } from './board.mjs';

const NET = { timeout: 60_000 };
const conflictPath = (pm) => path.join(pm, '.state', 'conflict');

export const syncTarget = (cwd, remote) => remote || tryGit(['remote', 'get-url', 'origin'], cwd);

// Local-only check: a normal `git fetch` of the project brings refs/remotes/origin/pm.
export const sharedBoardHint = (cwd) => tryGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pm'], cwd) !== null;

function recordConflict(pm, op, files) {
  tryGit([op, '--abort'], pm); // keep local commits; nothing is discarded
  fs.mkdirSync(path.dirname(conflictPath(pm)), { recursive: true });
  fs.writeFileSync(conflictPath(pm), files);
}

// A git process killed mid-write (e.g. by pull's timeout) can leave a stale index.lock
// behind. Safe to remove once no rebase/merge is actually in progress any more — this
// is always the board repo (`pm`), never the project's own repo.
function clearStaleLock(pm) {
  const dotgit = path.join(pm, '.git');
  const busy = fs.existsSync(path.join(dotgit, 'rebase-merge'))
    || fs.existsSync(path.join(dotgit, 'rebase-apply'))
    || fs.existsSync(path.join(dotgit, 'MERGE_HEAD'));
  const lock = path.join(dotgit, 'index.lock');
  if (!busy && fs.existsSync(lock)) fs.rmSync(lock, { force: true });
}

export function conflictFiles(pm) {
  const file = conflictPath(pm);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : null;
}

export function syncOn(cwd, url) {
  const pm = pmDir(cwd);
  const remoteHasBoard = Boolean(git(['ls-remote', '--heads', url, 'pm'], cwd, NET));
  if (!hasBoard(cwd) && remoteHasBoard) {
    fs.mkdirSync(path.dirname(pm), { recursive: true });
    git(['clone', '-q', '--single-branch', '--branch', 'pm', url, pm], path.dirname(pm), NET);
    writeBoard(pm);
    return { pm, mode: 'cloned', conflict: false };
  }
  if (!hasBoard(cwd)) initBoard(cwd, today());
  tryGit(['remote', 'remove', 'origin'], pm);
  git(['remote', 'add', 'origin', url], pm);
  if (remoteHasBoard) {
    git(['fetch', '-q', 'origin', 'pm'], pm, NET);
    try {
      git([...identityArgs(pm), 'merge', '-q', '--allow-unrelated-histories', '-m', 'pm: merge shared board', 'origin/pm'], pm);
    } catch {
      const files = tryGit(['diff', '--name-only', '--diff-filter=U'], pm) ?? '';
      recordConflict(pm, 'merge', files);
      return { pm, mode: 'merged', conflict: true };
    }
  }
  git(['push', '-q', '-u', 'origin', 'pm'], pm, NET);
  writeBoard(pm);
  return { pm, mode: remoteHasBoard ? 'merged' : 'pushed', conflict: false };
}

export function syncOff(pm) {
  tryGit(['remote', 'remove', 'origin'], pm);
  fs.rmSync(conflictPath(pm), { force: true });
}

export function pull(pm, timeout = 5000) {
  try {
    git([...identityArgs(pm), 'pull', '-q', '--rebase', '--autostash', 'origin', 'pm'], pm, { timeout });
    fs.rmSync(conflictPath(pm), { force: true });
    clearStaleLock(pm); // e.g. a lock left by an earlier killed process, with nothing to do this time
    return 'ok';
  } catch {
    const dotgit = path.join(pm, '.git');
    const rebasing = fs.existsSync(path.join(dotgit, 'rebase-merge')) || fs.existsSync(path.join(dotgit, 'rebase-apply'));
    let result = 'offline';
    if (rebasing) {
      const files = tryGit(['diff', '--name-only', '--diff-filter=U'], pm) ?? '';
      if (files) {
        recordConflict(pm, 'rebase', files);
        result = 'conflict';
      } else {
        tryGit(['rebase', '--abort'], pm); // interrupted (e.g. a killed timeout), not a real conflict
      }
    }
    clearStaleLock(pm);
    return result;
  }
}

export function pushNow(pm) {
  const r = pull(pm, NET.timeout);
  if (r !== 'ok') return r;
  return tryGit(['push', '-q', 'origin', 'pm'], pm, NET) === null ? 'offline' : 'ok';
}

// Number of unpushed commits when the oldest of them is more than a day old, else 0.
export function unpushedOverDay(pm, now = Date.now()) {
  const out = tryGit(['log', 'origin/pm..pm', '--format=%ct'], pm);
  if (!out) return 0;
  const stamps = out.split('\n').map(Number);
  return now - Math.min(...stamps) * 1000 > 86_400_000 ? stamps.length : 0;
}
