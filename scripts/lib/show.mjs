import { tryGit } from './paths.mjs';
import { readTask, listTasks } from './tasks.mjs';
import { decisionsFor } from './decisions.mjs';
import { describeCommits } from './gitlink.mjs';

const stamp = (unix) => new Date(unix * 1000).toLocaleString('sv-SE').slice(0, 16);

// Board history of one task from pm commit subjects ("<unix>\t<author>\t<subject>"), oldest first.
// A run of the same label keeps its first event: re-claims and repeated statuses add nothing to read.
export function timelineEvents(lines, id) {
  const status = new RegExp(`^pm: set ${id} (?:.* )?status=(\\w+)(?: |$)`);
  const events = [];
  for (const line of lines) {
    const [at, author, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const label = subject === `pm: task new ${id}` ? 'created'
      : subject === `pm: claim ${id}` ? 'claimed'
        : subject.match(status)?.[1];
    if (label && events.at(-1)?.label !== label) events.push({ label, at: Number(at), author });
  }
  return events;
}

function boardHistory(pm, id) {
  const out = tryGit(['log', '--reverse', '--format=%at%x09%an%x09%s', '-F', `--grep=${id}`], pm);
  return out ? out.split('\n') : [];
}

// What the task file does not say: its code, its history on the board, its decisions and who depends on it.
export function showTask(pm, cwd, id) {
  const { data } = readTask(pm, id);
  const lines = [`${id} ${data.title} · ${data.status}${data.epic ? ` · epic ${data.epic}` : ''}`];
  if (data.branch) lines.push(`branch: ${data.branch}`);
  if (data.pr) lines.push(`pr: ${data.pr}`);
  const events = timelineEvents(boardHistory(pm, id), id);
  if (events.length) lines.push(`timeline: ${events.map((e) => `${e.label} ${stamp(e.at)} ${e.author}`).join(' · ')}`);
  const commits = describeCommits(cwd, data.commits ?? []);
  if (commits.length) {
    lines.push(`commits (${commits.length}):`);
    for (const c of commits) {
      lines.push(c.missing ? `  ${c.sha} (rewritten — not in this repository)` : `  ${c.sha} ${stamp(c.at)} ${c.author}  ${c.subject}`);
    }
  } else if (data.status === 'in_progress' && data.branch) {
    lines.push('commits: none linked yet — commits made in this worktree after pm claim appear here');
  }
  const decisions = decisionsFor(pm, id);
  if (decisions.length) lines.push(`decisions: ${decisions.map((d) => `${d.id} ${d.title}`).join(' · ')}`);
  const dependents = listTasks(pm).filter((t) => t.data.depends_on.includes(id));
  if (dependents.length) lines.push(`depended on by: ${dependents.map((t) => `${t.id} (${t.data.status})`).join(', ')}`);
  return lines.join('\n');
}
