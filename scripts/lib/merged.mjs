import { tryGit } from './paths.mjs';
import { readState, writeState } from './store.mjs';
import { defaultBranch } from './forge.mjs';

// ponytail: one git log over the default branch per check; a repo with a huge history since the oldest open task
// would want a --max-count or a cached cursor.
export const GIT_TIMEOUT_MS = 30_000;
const HINT_STATE = 'merge-hint';

export const OPEN_FOR_MERGE = ['todo', 'in_progress', 'waiting', 'review'];
export const mergeCandidates = (tasks) => tasks.filter((t) => OPEN_FOR_MERGE.includes(t.data.status));

// Every failure the merge code prints: what happened — why — the command that fixes it.
export const problem = (what, cause, fix) => `${what} — ${cause} — fix: ${fix}`;

// A task id in a commit subject: the conventional-commit scope `feat(T-038): …` or a bracket `[T-038]`.
// Only the subject counts: a body saying "after T-041" is not a merge of T-041.
const SCOPE_RE = /^[a-z]+\(([A-Z][A-Z0-9]*-\d+)\)!?:/i;
const BRACKET_RE = /\[([A-Z][A-Z0-9]*-\d+)\]/g;
const PR_RE = /\(#(\d+)\)\s*$/;

export function subjectIds(subject) {
  const ids = new Set([...subject.matchAll(BRACKET_RE)].map((m) => m[1]));
  const scope = subject.match(SCOPE_RE);
  if (scope) ids.add(scope[1]);
  return ids;
}

const firstLogDate = (task) => task.body.match(/^- (\d{4}-\d{2}-\d{2}) · /m)?.[1];

// The oldest date any candidate could have been merged after: its first Log entry, else its last update.
export function sinceDate(tasks) {
  const dates = tasks.map((t) => firstLogDate(t) ?? t.data.updated).filter(Boolean).map(String).sort();
  return dates[0] ?? null;
}

// Local signal, no network: subjects on origin's default branch that name an open task.
// { branch, hits: Map<id, { how, sha, at, pr }> (newest commit per id), notChecked } — never throws.
export function subjectHits(cwd, tasks) {
  const candidates = mergeCandidates(tasks);
  const def = defaultBranch(cwd);
  const hits = new Map();
  if (!def) {
    const notChecked = problem('Merge not checked', 'origin has no default branch here (no origin/HEAD, origin/main or origin/master)', 'git fetch origin, then pm reconcile');
    return { branch: null, hits, notChecked };
  }
  if (!candidates.length) return { branch: def, hits, notChecked: null };
  const ids = new Set(candidates.map((t) => t.id));
  const since = sinceDate(candidates);
  const out = tryGit(['log', def.ref, ...(since ? [`--since=${since} 00:00:00`] : []), '--format=%H%x09%ct%x09%s'], cwd, { timeout: GIT_TIMEOUT_MS });
  if (out === null) {
    return { branch: def, hits, notChecked: problem('Merge not checked', `git log ${def.ref} failed or took longer than ${GIT_TIMEOUT_MS / 1000} s`, 'git fetch origin, then pm reconcile') };
  }
  for (const line of out.split('\n')) {
    const [sha, ct, ...rest] = line.split('\t');
    if (!sha || !ct) continue;
    const subject = rest.join('\t');
    for (const id of subjectIds(subject)) {
      if (!ids.has(id) || hits.has(id)) continue; // git log is newest first: the first hit is the latest merge
      const pr = subject.match(PR_RE)?.[1];
      hits.set(id, { how: 'subject', sha, at: Number(ct), pr: pr ? `#${pr}` : null });
    }
  }
  return { branch: def, hits, notChecked: null };
}

// The origin/HEAD fix, printed once per repo: main/master was a guess.
export function originHeadHint(pm, def) {
  if (!def?.guessed || readState(pm, HINT_STATE).shown) return null;
  writeState(pm, HINT_STATE, { shown: true });
  return `origin/HEAD is not set, so ${def.ref} is assumed to be the default branch — fix: git remote set-head origin -a`;
}
