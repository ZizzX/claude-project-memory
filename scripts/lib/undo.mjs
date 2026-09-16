import { tryGit } from './paths.mjs';

const short = (sha) => sha.slice(0, 12);
// ponytail: keeps the path list under the Windows command-line limit; bigger changes skip the same-file check.
const MAX_FILES = 300;
const MAX_LISTED = 5;

const exists = (cwd, sha) => tryGit(['cat-file', '-e', `${sha}^{commit}`], cwd) !== null;
const inHead = (cwd, sha) => tryGit(['merge-base', '--is-ancestor', sha, 'HEAD'], cwd) !== null;
const parent = (cwd, sha, n) => tryGit(['rev-parse', '--verify', '-q', `${sha}^${n}`], cwd);

// The undo block of `pm show`: exact commands for the task's code and what they may break. Nothing runs here (D-011).
// Cases, first match: the merged MR/PR commit is in HEAD → the task's commits in HEAD → notes explaining why not.
export function undoPlan({ cwd, id, tasks, commits, pr }) {
  const mrShas = pr?.state === 'merged' ? [pr.mergeSha, pr.squashSha].filter(Boolean) : [];
  const mrLocal = mrShas.find((sha) => exists(cwd, sha));
  const live = commits.filter((c) => !c.missing);
  const plan = { risks: [], notes: [] };
  let targets;
  let base;
  let files;
  if (mrLocal && inHead(cwd, mrLocal)) {
    const isMerge = parent(cwd, mrLocal, 2) !== null;
    const why = isMerge ? 'merge commit of the MR/PR'
      : pr.commitCount > 1 ? `one-parent merge of a ${pr.commitCount}-commit PR: a squash is reverted whole, a rebase merge only in its last commit — check first`
        : 'squash commit of the MR/PR';
    plan.revert = { command: `git revert --no-edit ${isMerge ? '-m 1 ' : ''}${short(mrLocal)}`, why };
    targets = [mrLocal];
    base = parent(cwd, mrLocal, 1);
    files = base ? tryGit(['diff', '--name-only', base, mrLocal], cwd) : tryGit(['show', '--name-only', '--format=', mrLocal], cwd);
  } else {
    const reachable = live.filter((c) => inHead(cwd, c.sha));
    if (!reachable.length) {
      if (mrLocal || live.length) plan.notes.push("the task's code is not in the current branch");
      else if (mrShas.length) plan.notes.push(`the merged MR/PR commit ${short(mrShas[0])} is not in this repository — git fetch, then pm show again`);
      else if (commits.length) plan.notes.push('commits were rewritten and no merged MR/PR was found — cannot undo automatically');
      else return null;
      return plan;
    }
    // Stored in capture order, which is the order they became HEAD: reversed, newest first.
    plan.revert = { command: `git revert --no-edit ${[...reachable].reverse().map((c) => c.sha).join(' ')}`, why: "the task's commits, newest first" };
    if (reachable.length < commits.length) {
      plan.notes.push(`${commits.length - reachable.length} of ${commits.length} commits are not in the current branch or were rewritten; only the rest is reverted`);
    }
    targets = reachable.map((c) => c.sha);
    base = parent(cwd, targets[0], 1);
    files = tryGit(['show', '--name-only', '--format=', ...targets], cwd);
  }
  if (base) plan.before = `git switch -c before/${id} ${short(base)}`;

  for (const t of tasks) {
    if (t.data.status === 'done' && t.data.depends_on.includes(id)) plan.risks.push(`${t.id} (done) depends on ${id}`);
  }
  const paths = [...new Set((files ?? '').split('\n').filter(Boolean))];
  if (paths.length > MAX_FILES) {
    plan.risks.push(`same-file check skipped (${paths.length} files)`);
  } else if (paths.length) {
    const own = (sha) => targets.some((t) => sha.startsWith(t));
    const later = (tryGit(['log', '--format=%H', `${targets[0]}..HEAD`, '--', ...paths], cwd) ?? '').split('\n').filter((sha) => sha && !own(sha));
    if (later.length) {
      const owner = (sha) => tasks.find((t) => (t.data.commits ?? []).includes(short(sha)))?.id;
      const listed = later.slice(0, MAX_LISTED).map((sha) => (owner(sha) ? `${short(sha)} (${owner(sha)})` : short(sha)));
      plan.risks.push(`same files changed later: ${listed.join(', ')}${later.length > MAX_LISTED ? ` +${later.length - MAX_LISTED} more` : ''}`);
    }
  }
  return plan;
}

export function undoLines(plan) {
  const row = (label, text) => `  ${`${label}:`.padEnd(8)}${text}`;
  return [
    'undo:',
    ...(plan.revert ? [row('revert', `${plan.revert.command}   (${plan.revert.why})`)] : []),
    ...(plan.before ? [row('before', `${plan.before}   (the state before the task)`)] : []),
    ...(plan.risks.length ? [row('risk', plan.risks.join(' · '))] : []),
    ...plan.notes.map((note) => row('note', note)),
  ];
}
