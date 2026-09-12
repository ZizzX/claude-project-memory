import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pmDir } from '../scripts/lib/paths.mjs';

export const PM = fileURLToPath(new URL('../scripts/pm.mjs', import.meta.url));

// Hermetic git identity; background pushes off so temp dirs are never touched after a test.
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  PM_NO_BACKGROUND: '1',
});

export function tmp(prefix = 'pm-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function sh(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A fresh CLAUDE_CONFIG_DIR plus a git repo with one commit on branch main.
export function setup() {
  const home = tmp('pm-home-');
  process.env.CLAUDE_CONFIG_DIR = home;
  const root = tmp('pm-repo-');
  sh(['init', '-q', '-b', 'main'], root);
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  sh(['add', '-A'], root);
  sh(['commit', '-q', '-m', 'init'], root);
  return { home, root };
}

export function addWorktree(root, name) {
  const dir = path.join(path.dirname(root), `${path.basename(root)}-${name}`);
  sh(['worktree', 'add', '-q', '-b', name, dir], root);
  return fs.realpathSync(dir);
}

export function cli(args, cwd, { input, env } = {}) {
  const r = spawnSync(process.execPath, [PM, ...args], {
    cwd,
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

// pm dir of `root` as seen by a machine whose claude home is `home`.
export function pmOf(home, root) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = home;
  try {
    return pmDir(root);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = prev;
  }
}
