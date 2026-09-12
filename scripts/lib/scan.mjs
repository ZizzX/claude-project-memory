import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mainRoot, tryGit } from './paths.mjs';

export const REPO_PLAN_DIRS = ['docs/superpowers/plans', 'docs/superpowers/specs', 'docs/designs', '.dev-cycle/tasks'];

const mdFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(dir, f)) : []);

export function scanPlans(cwd) {
  const top = tryGit(['rev-parse', '--show-toplevel'], cwd);
  if (!top) return [];
  const files = REPO_PLAN_DIRS.flatMap((d) => mdFiles(path.join(top, d)));
  const repoName = path.basename(mainRoot(cwd)).toLowerCase();
  const gstack = path.join(os.homedir(), '.gstack', 'projects');
  if (fs.existsSync(gstack)) {
    for (const slug of fs.readdirSync(gstack)) {
      if (slug.toLowerCase().includes(repoName)) files.push(...mdFiles(path.join(gstack, slug, 'ceo-plans')));
    }
  }
  return files.map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return {
      path: file,
      done: (text.match(/^\s*- \[[xX]\]/gm) ?? []).length,
      total: (text.match(/^\s*- \[[ xX]\]/gm) ?? []).length,
    };
  });
}
