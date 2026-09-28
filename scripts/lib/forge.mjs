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
      commitCount: json.commits ?? null,
      author: json.user?.login ?? '',
      base: json.base?.ref ?? null,
      head: json.head?.ref ?? null,
    };
  }
  if (!json.web_url) return null;
  return {
    url: json.web_url,
    state: json.state === 'opened' ? 'open' : json.state,
    mergedAt: unix(json.merged_at),
    mergeSha: json.merge_commit_sha ?? null,
    squashSha: json.squash_commit_sha ?? null,
    commitCount: null,
    author: json.author?.username ?? '',
    base: json.target_branch ?? null,
    head: json.source_branch ?? null,
  };
}

// Why a forge call failed. permanent: retrying before the user fixes something is pointless (no CLI, not logged in).
// timeout: the forge did not answer (offline?), so the next lookups of this run would wait just as long.
function failure(cli, e) {
  const text = `${e.stderr ?? ''} ${e.message ?? ''}`;
  if (e.code === 'ENOENT') return { cause: `${cli} is not installed`, permanent: true };
  if (e.code === 'ETIMEDOUT' || e.signal) return { cause: `${cli} timed out (offline?)`, permanent: false, timeout: true };
  if (/HTTP 401|auth login|not logged in|authenticat/i.test(text)) return { cause: `${cli} is not logged in`, permanent: true };
  if (/HTTP 404|Not Found/i.test(text)) return { cause: 'not found on the forge', permanent: false };
  const first = String(e.stderr ?? '').trim().split('\n')[0];
  return { cause: (first || e.message || 'unknown error').slice(0, 200), permanent: false };
}

// One API call through the forge's own CLI: { json } or { cause, permanent, timeout? }.
// Test seam: PM_FORGE_FIXTURE maps an API path to its JSON (nothing is spawned); a missing path is a 404,
// and { "$error": cause, "permanent": bool, "timeout": bool } is a failure.
export function forgeCall({ cli, host, path }) {
  const fixture = process.env.PM_FORGE_FIXTURE;
  if (fixture) {
    let json;
    try {
      json = JSON.parse(fs.readFileSync(fixture, 'utf8'))[path];
    } catch {
      json = null;
    }
    if (json == null) return { cause: 'not found on the forge', permanent: false };
    if (json.$error) return { cause: json.$error, permanent: Boolean(json.permanent), ...(json.timeout && { timeout: true }) };
    return { json };
  }
  const hostArgs = cli === 'gh' && host === 'github.com' ? [] : ['--hostname', host];
  let out;
  try {
    out = execFileSync(cli, ['api', ...hostArgs, path], { encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    return failure(cli, e);
  }
  try {
    return { json: JSON.parse(out) };
  } catch {
    return { cause: `${cli} returned something that is not JSON`, permanent: false };
  }
}

// origin's default branch: origin/HEAD, else origin/main, else origin/master; null when none exists.
// guessed: origin/HEAD is not set (fix: git remote set-head origin -a).
export function defaultBranch(cwd) {
  const head = tryGit(['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (head) return { remote: 'origin', branch: head.slice('origin/'.length), ref: head, guessed: false };
  const branch = ['main', 'master'].find((b) => tryGit(['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`], cwd));
  return branch ? { remote: 'origin', branch, ref: `origin/${branch}`, guessed: true } : null;
}

// With no default branch known, main and master are taken for it.
export const isDefaultIn = (def, branch) => (def ? def.branch === branch : ['main', 'master'].includes(branch));
export const isDefaultBranch = (cwd, branch) => isDefaultIn(defaultBranch(cwd), branch);

// The task's MR/PR: its `pr` URL, or else its branch looked up on origin's forge.
// { status: 'ok', pr } · { status: 'none' } (nothing to look up, or no PR for the branch) · { status: 'error', cause, permanent, cli, timeout }.
// With an origin, only its host is asked: a `pr` comes from the board, which may arrive through sync, and must not send
// gh/glab (and a token from the environment) to another host.
export function prLookup(data, cwd) {
  const remote = parseRemote(tryGit(['remote', 'get-url', 'origin'], cwd) ?? '');
  const failed = (res, cli) => ({ status: 'error', cause: res.cause, permanent: res.permanent, cli, ...(res.timeout && { timeout: true }) });
  if (data.pr) {
    const target = parsePrUrl(data.pr);
    if (!target) return { status: 'error', cause: 'unknown PR URL', permanent: true };
    if (remote && target.host.toLowerCase() !== remote.host.toLowerCase()) {
      return { status: 'error', cause: `the PR is on ${target.host}, origin is ${remote.host}`, permanent: true };
    }
    const request = prRequest(target);
    const res = forgeCall(request);
    if (!res.json) return failed(res, request.cli);
    const pr = normalizePr(target.kind, res.json);
    if (!pr) return { status: 'error', cause: `unexpected answer from ${request.cli}`, permanent: false, cli: request.cli };
    return { status: 'ok', pr: { ...pr, url: data.pr } };
  }
  if (!data.branch || !remote || isDefaultBranch(cwd, data.branch)) return { status: 'none' };
  const request = prRequest(remote, data.branch);
  const res = forgeCall(request);
  if (!res.json) return failed(res, request.cli);
  const pr = Array.isArray(res.json) ? normalizePr(remote.kind, res.json[0]) : null;
  return pr ? { status: 'ok', pr: { ...pr, foundByBranch: true } } : { status: 'none' };
}

// prLookup shaped for pm show: null when there is nothing to show; { url, unavailable } when a known URL got no data.
export function prInfo(data, cwd) {
  const r = prLookup(data, cwd);
  if (r.status === 'ok') return r.pr;
  if (!data.pr) return null;
  return { url: data.pr, unavailable: r.cli ? `no data from ${r.cli}` : r.cause };
}
