import { tryGit } from './paths.mjs';
import { readTask, listTasks } from './tasks.mjs';
import { decisionsFor } from './decisions.mjs';
import { describeCommits } from './gitlink.mjs';
import { prInfo } from './forge.mjs';
import { undoPlan, undoLines } from './undo.mjs';

const stamp = (unix) => new Date(unix * 1000).toLocaleString('sv-SE').slice(0, 16);

function prLine(pr) {
  if (pr.unavailable) return `pr: ${pr.url} (${pr.unavailable})`;
  const parts = [`pr: ${pr.url}${pr.foundByBranch ? ' (found by branch)' : ''}`];
  parts.push(pr.state === 'merged' && pr.mergedAt ? `merged ${stamp(pr.mergedAt)}` : pr.state);
  if (pr.mergeSha) parts.push(`merge ${pr.mergeSha.slice(0, 12)}`);
  else if (pr.squashSha) parts.push(`squash ${pr.squashSha.slice(0, 12)}`);
  if (pr.author) parts.push(`@${pr.author}`);
  return parts.join(' · ');
}

// The board commit of merged tasks closed by pm reconcile or at session start: "pm: reconcile closed T-001, T-002".
export const CLOSED_PREFIX = 'pm: reconcile closed ';
// pm done's board commit: "pm: done T-001 → review".
export const DONE_PREFIX = 'pm: done ';

// Board history of one task from pm commit subjects ("<unix>\t<author>\t<subject>"), oldest first.
// A run of the same label keeps its first event: re-claims and repeated statuses add nothing to read.
export function timelineEvents(lines, id) {
  // `pm set` quotes a value that contains spaces, so a `status=` inside one is not read as an argument.
  // Of several real `status=` arguments the last one wins, the way the CLI's own field map resolves them.
  const setPrefix = `pm: set ${id} `;
  const TOKEN = /"(?:[^"\\]|\\.)*"|\S+/g;
  const statusOf = (args) => args.match(TOKEN)?.reduce((found, token) => /^status=\w+$/.test(token) ? token.slice(7) : found, undefined);
  const events = [];
  for (const line of lines) {
    const [at, author, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const label = subject === `pm: task new ${id}` ? 'created'
      : subject === `pm: claim ${id}` ? 'claimed'
        : subject.startsWith(setPrefix) ? statusOf(subject.slice(setPrefix.length))
          : subject.startsWith(`${DONE_PREFIX}${id} → `) ? subject.slice(`${DONE_PREFIX}${id} → `.length)
          : subject.startsWith(CLOSED_PREFIX) && subject.slice(CLOSED_PREFIX.length).split(', ').includes(id) ? 'done' : undefined;
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
  const pr = prInfo(data, cwd);
  if (pr) lines.push(prLine(pr));
  if (data.merged_how) {
    const at = Date.parse(data.merged_at ?? '');
    lines.push(`merged: ${data.merged_sha ? String(data.merged_sha).slice(0, 12) : 'sha unknown'} (${data.merged_how}), ${Number.isFinite(at) ? stamp(at / 1000) : 'date unknown'}`);
  }
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
  const tasks = listTasks(pm);
  const dependents = tasks.filter((t) => t.data.depends_on.includes(id));
  if (dependents.length) lines.push(`depended on by: ${dependents.map((t) => `${t.id} (${t.data.status})`).join(', ')}`);
  const plan = undoPlan({ cwd, id, tasks, commits, pr });
  if (plan) lines.push(...undoLines(plan));
  return lines.join('\n');
}
