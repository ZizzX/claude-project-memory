import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp, sh, cli, pmOf } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

// Machine 1: a project with an origin remote (a local bare repo).
function project() {
  const { home, root } = setup();
  const remote = tmp('pm-remote-');
  sh(['init', '-q', '--bare', '-b', 'main'], remote);
  sh(['remote', 'add', 'origin', remote], root);
  sh(['push', '-q', 'origin', 'main'], root);
  return { home, root, remote };
}

// Machine 2: its own claude home and its own clone of the project.
function machine2(remote) {
  const home = tmp('pm-home2-');
  const root = path.join(tmp('pm-m2-'), 'repo');
  sh(['clone', '-q', remote, root], path.dirname(root));
  return { home, root, env: { env: { CLAUDE_CONFIG_DIR: home } } };
}

const remoteHasPm = (remote) => sh(['branch', '--list', 'pm'], remote) !== '';

test('local by default: nothing is pushed until sync on --yes', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'x'], root);
  assert.equal(remoteHasPm(remote), false);
  const dry = cli(['sync', 'on'], root);
  assert.match(dry.out, /will be pushed to .* \(branch pm\)[\s\S]*--yes/);
  assert.equal(remoteHasPm(remote), false);
  assert.match(cli(['sync', 'on', '--yes'], root).out, /sync on \(pushed\)/);
  assert.equal(remoteHasPm(remote), true);
  assert.match(cli(['sync', 'off'], root).out, /sync off/);
  assert.equal(sh(['remote'], pmDir(root)), '');
  assert.ok(fs.existsSync(path.join(pmDir(root), 'tasks', 'T-001.md')));
  assert.equal(cli(['sync'], root).code, 1);
});

test('another machine clones the shared board only on sync on', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'shared task'], root);
  cli(['sync', 'on', '--yes'], root);
  const m2 = machine2(remote);
  assert.equal(cli(['summary'], m2.root, m2.env).code, 1, 'no board until the user connects');
  assert.match(cli(['sync', 'on', '--yes'], m2.root, m2.env).out, /sync on \(cloned\)/);
  assert.match(cli(['summary'], m2.root, m2.env).out, /T-001 shared task/);
});

test('an existing local board merges with the remote board', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  const m2 = machine2(remote);
  cli(['init'], m2.root, m2.env);
  const r = cli(['sync', 'on', '--yes'], m2.root, m2.env);
  assert.equal(r.code, 0);
  assert.match(r.out, /sync conflict in: .*PLAN\.md|sync on \(merged\)/);
});

test('decisions merge by union; a conflicting task edit is flagged without data loss', () => {
  const { root, remote } = project();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'base'], root);
  cli(['sync', 'on', '--yes'], root);
  const m2 = machine2(remote);
  cli(['sync', 'on', '--yes'], m2.root, m2.env);

  cli(['decision', '--title', 'from m1', '--why', 'a', '--rejected', 'b'], root);
  assert.equal(cli(['sync'], root).out, 'synced');
  cli(['decision', '--title', 'from m2', '--why', 'c', '--rejected', 'd'], m2.root, m2.env);
  assert.equal(cli(['sync'], m2.root, m2.env).out, 'synced');
  const decisions = fs.readFileSync(path.join(pmOf(m2.home, m2.root), 'decisions.md'), 'utf8');
  assert.match(decisions, /from m1/);
  assert.match(decisions, /from m2/);

  cli(['sync'], root);
  cli(['set', 'T-001', 'title=title from m1'], root);
  cli(['sync'], root);
  cli(['set', 'T-001', 'title=title from m2'], m2.root, m2.env);
  const r = cli(['sync'], m2.root, m2.env);
  assert.equal(r.code, 0);
  assert.match(r.out, /sync conflict in: tasks\/T-001\.md/);
  const task = fs.readFileSync(path.join(pmOf(m2.home, m2.root), 'tasks', 'T-001.md'), 'utf8');
  assert.match(task, /title from m2/);
});

test('offline remote: sync reports offline, exits 0, keeps local commits', () => {
  const { root } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  sh(['remote', 'set-url', 'origin', path.join(tmp(), 'missing.git')], pmDir(root));
  cli(['task', 'new', '--title', 'offline work'], root);
  const r = cli(['sync'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /offline/);
  assert.equal(sh(['log', '-1', '--format=%s'], pmDir(root)), 'pm: task new T-001');
  assert.equal(fs.existsSync(path.join(pmDir(root), '.state', 'conflict')), false, 'a network failure must never look like a conflict');
});

function withUnreachableRemote(root) {
  sh(['remote', 'set-url', 'origin', path.join(tmp(), 'missing.git')], pmDir(root));
}

test('a stale index.lock (older than the threshold) is removed', () => {
  const { root } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  withUnreachableRemote(root);
  const lock = path.join(pmDir(root), '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 10 * 60_000); // well past the 5-minute staleness threshold
  fs.utimesSync(lock, old, old);
  const r = cli(['sync'], root);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(lock), false);
});

test('a fresh index.lock (held by a concurrent pm process) is left alone', () => {
  const { root } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  withUnreachableRemote(root);
  const lock = path.join(pmDir(root), '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const r = cli(['sync'], root);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(lock), true, 'a fresh lock may belong to a live pm process and must not be deleted');
});

test('an interrupted rebase with no conflicted files is offline, not a conflict', () => {
  const { root } = project();
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root);
  withUnreachableRemote(root);
  fs.mkdirSync(path.join(pmDir(root), '.git', 'rebase-merge'), { recursive: true });
  const r = cli(['sync'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /offline/);
  assert.equal(fs.existsSync(path.join(pmDir(root), '.state', 'conflict')), false);
});
