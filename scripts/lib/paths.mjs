import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function git(args, cwd, opts = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...opts,
  }).trimEnd();
}

export function tryGit(args, cwd, opts = {}) {
  try {
    return git(args, cwd, opts);
  } catch {
    return null;
  }
}

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Same rule Claude Code uses to name folders under <claude-home>/projects.
export function repoKey(absPath) {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

// Root of the main worktree; identical for every linked worktree of the repo.
export function mainRoot(cwd) {
  const common = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return common ? path.resolve(path.dirname(common)) : null;
}

export function worktreeName(cwd) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  return top ? path.basename(top) : null;
}

export function projectDir(cwd) {
  const root = mainRoot(cwd);
  return root ? path.join(claudeHome(), 'projects', repoKey(root)) : null;
}

export function pmDir(cwd) {
  const dir = projectDir(cwd);
  return dir ? path.join(dir, 'pm') : null;
}

export function memoryDir(cwd) {
  const dir = projectDir(cwd);
  return dir ? path.join(dir, 'memory') : null;
}

export function today() {
  return new Date().toLocaleDateString('sv-SE');
}
