import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tryGit } from './paths.mjs';

const TIMEOUT_MS = 10_000;

// https://github.com/<owner>/<repo>/pull/<n> (or a GitHub Enterprise host), https://<host>/<group/…/project>/-/merge_requests/<iid>.
export function parsePrUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const gitlab = u.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  if (gitlab) return { kind: 'gitlab', host: u.host, project: gitlab[1], number: Number(gitlab[2]) };
  const github = u.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (github) return { kind: 'github', host: u.host, project: `${github[1]}/${github[2]}`, number: Number(github[3]) };
  return null;
}

// origin as https://host/path(.git), ssh://git@host[:port]/path(.git) or git@host:path(.git).
// ponytail: a host containing "github" is GitHub, anything else GitLab; add a git config key if a GHE host breaks it.
export function parseRemote(url) {
  const m = String(url).match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/);
  return m ? { kind: /github/i.test(m[1]) ? 'github' : 'gitlab', host: m[1], project: m[2] } : null;
}

// One PR by number, or the PRs of a branch (newest first — the forges' default order).
export function prRequest({ kind, host, project, number }, branch) {
  if (kind === 'github') {
    const owner = project.split('/')[0];
    const path = number ? `repos/${project}/pulls/${number}` : `repos/${project}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all`;
    return { cli: 'gh', host, path };
  }
  const base = `projects/${encodeURIComponent(project)}/merge_requests`;
  return { cli: 'glab', host, path: number ? `${base}/${number}` : `${base}?source_branch=${encodeURIComponent(branch)}&state=all` };
}

const unix = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

export function normalizePr(kind, json) {
  if (!json || typeof json !== 'object') return null;
  if (kind === 'github') {
    if (!json.html_url) return null;
    const merged = Boolean(json.merged_at); // an open PR carries a test merge_commit_sha: not a real merge
    return {
      url: json.html_url,
      state: merged ? 'merged' : json.state,
      mergedAt: unix(json.merged_at),
      mergeSha: merged ? json.merge_commit_sha ?? null : null,
      squashSha: null,
      author: json.user?.login ?? '',
    };
  }
  if (!json.web_url) return null;
  return {
    url: json.web_url,
    state: json.state === 'opened' ? 'open' : json.state,
    mergedAt: unix(json.merged_at),
    mergeSha: json.merge_commit_sha ?? null,
    squashSha: json.squash_commit_sha ?? null,
    author: json.author?.username ?? '',
  };
}

// One API call through the forge's own CLI. Any failure — no CLI, not logged in, offline, 404, bad JSON — is null.
export function forgeApi({ cli, host, path }) {
  try {
    const fixture = process.env.PM_FORGE_FIXTURE;
    if (fixture) return JSON.parse(fs.readFileSync(fixture, 'utf8'))[path] ?? null; // test seam: nothing is spawned
    const hostArgs = cli === 'gh' && host === 'github.com' ? [] : ['--hostname', host];
    const out = execFileSync(cli, ['api', ...hostArgs, path], { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function isDefaultBranch(cwd, branch) {
  const head = tryGit(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], cwd); // e.g. origin/master
  return head ? head === `origin/${branch}` : ['main', 'master'].includes(branch);
}

// The task's MR/PR with forge data: its `pr` URL, or else its branch looked up on origin's forge.
// null when there is nothing to show; { url, unavailable } when a known URL got no data.
export function prInfo(data, cwd) {
  if (data.pr) {
    const target = parsePrUrl(data.pr);
    if (!target) return { url: data.pr, unavailable: 'unknown PR URL' };
    const request = prRequest(target);
    const pr = normalizePr(target.kind, forgeApi(request));
    return pr ? { ...pr, url: data.pr } : { url: data.pr, unavailable: `no data from ${request.cli}` };
  }
  if (!data.branch || isDefaultBranch(cwd, data.branch)) return null;
  const remote = parseRemote(tryGit(['remote', 'get-url', 'origin'], cwd) ?? '');
  if (!remote) return null;
  const list = forgeApi(prRequest(remote, data.branch));
  const pr = Array.isArray(list) ? normalizePr(remote.kind, list[0]) : null;
  return pr ? { ...pr, foundByBranch: true } : null;
}
