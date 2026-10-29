import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setup, tmp, sh, cli, addWorktree } from './helpers.mjs';
import { pmDir, memoryDir } from '../scripts/lib/paths.mjs';
import { onSessionStart, onPostToolUse, onStop, onSafetyNote, STALE_MINUTES } from '../scripts/lib/hooks.mjs';
import { readState, writeState, hasState, manualMtime } from '../scripts/lib/store.mjs';
import { captureCommits } from '../scripts/lib/gitlink.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

test('no board: hooks are silent; shared-board hint when origin/pm exists', () => {
  const { root } = setup();
  assert.equal(onSessionStart({ session_id: 's' }, root), '');
  assert.equal(onStop({}, root), '');
  assert.equal(onPostToolUse({ tool_name: 'ExitPlanMode' }, root), '');
  assert.equal(onSafetyNote({ session_id: 's' }, root, 'session-end'), '');
  sh(['update-ref', 'refs/remotes/origin/pm', 'HEAD'], root);
  assert.match(onSessionStart({ session_id: 's' }, root), /shared board/);
  assert.equal(onSessionStart({}, tmp()), '');
});

test('session start prints the summary, records state, surfaces problems', () => {
  const { root } = setup();
  cli(['init'], root);
  const out = onSessionStart({ session_id: 'abc' }, root);
  assert.match(out, /^\[pm\] /);
  assert.match(out, /\nRules:/);
  assert.ok(fs.existsSync(path.join(pmDir(root), '.state', 'session-abc.json')));
  cli(['task', 'new', '--title', 'x'], root);
  cli(['set', 'T-001', 'depends_on=T-404'], root);
  assert.match(onSessionStart({ session_id: 'abc' }, root), /board problems: T-001: depends on unknown T-404/);
});

test('session start: a broken memory link cannot swallow the summary', () => {
  const { root } = setup();
  const remote = tmp('pm-remote-');
  sh(['init', '-q', '--bare', '-b', 'main'], remote);
  sh(['remote', 'add', 'origin', remote], root);
  cli(['init'], root);
  cli(['sync', 'on', '--yes'], root); // links memory for real first
  const mem = memoryDir(root);
  fs.unlinkSync(mem); // drop the junction itself, leave its target behind
  fs.symlinkSync(path.join(path.dirname(mem), 'nowhere'), mem, 'junction'); // now dangling
  const out = onSessionStart({ session_id: 'zz' }, root);
  assert.match(out, /^\[pm\] /);
  assert.match(out, /memory link check failed/);
  assert.match(out, /\nRules:/, 'the full summary still gets built, not just the status line');
  assert.ok(fs.existsSync(path.join(pmDir(root), '.state', 'session-zz.json')), 'state is still recorded');
});

test('post-tool-use: plan files nudge, pm files rebuild the board, others are ignored', () => {
  const { root } = setup();
  cli(['init'], root);
  const pm = pmDir(root);
  const plan = path.join(root, 'docs', 'superpowers', 'plans', 'x.md');
  const nudge = JSON.parse(onPostToolUse({ tool_name: 'Write', tool_input: { file_path: plan } }, root));
  assert.match(nudge.hookSpecificOutput.additionalContext, /plan updated: .*x\.md — reconcile with the board/);
  const mode = JSON.parse(onPostToolUse({ tool_name: 'ExitPlanMode', tool_input: {} }, root));
  assert.match(mode.hookSpecificOutput.additionalContext, /plan mode/);
  fs.rmSync(path.join(pm, 'board.html'));
  assert.equal(onPostToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(pm, 'tasks', 'T-001.md') } }, root), '');
  assert.ok(fs.existsSync(path.join(pm, 'board.html')));
  assert.equal(onPostToolUse({ tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.js') } }, root), '');
});

// Stop compares this session's own changes with the last manual board update. Times are set explicitly:
// commits through GIT_*_DATE (the reflog entry takes the committer date), files and directories through utimes.
const S = { session_id: 's' };
const touch = (file, at) => fs.utimesSync(file, new Date(at), new Date(at));

function commitAt(root, name, at) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(at));
  const date = `@${Math.floor(at / 1000)} +0000`;
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync('git', ['add', '-A'], { cwd: root, env });
  execFileSync('git', ['commit', '-q', '-m', name], { cwd: root, env });
}

// A board and a session that starts now; `updated` (ms from now) moves the last manual board update.
function begin(root, { updated } = {}) {
  cli(['init'], root);
  const pm = pmDir(root);
  const t0 = Date.now();
  if (updated !== undefined) for (const f of ['PLAN.md', 'decisions.md']) touch(path.join(pm, f), t0 + updated);
  onSessionStart(S, root);
  return { pm, t0 };
}
const blocks = (root, at, input = S) => JSON.parse(onStop(input, root, at) || '{}').decision === 'block';

test('stop: an old HEAD, a clean tree and no task of its own do not block (the false nudge)', () => {
  const { root } = setup();
  commitAt(root, 'old.js', Date.now() - DAY);
  const { t0 } = begin(root, { updated: -4 * DAY });
  assert.equal(onStop(S, root, t0 + 120 * MIN), '');
});

test('stop: a commit made in this session blocks, and the message says what it saw', () => {
  const { root } = setup();
  const { t0 } = begin(root);
  commitAt(root, 'a.js', t0 + 60 * MIN);
  const block = JSON.parse(onStop(S, root, t0 + 120 * MIN));
  assert.equal(block.decision, 'block');
  assert.equal(block.reason, `[pm] This session made 1 commit; the board was not updated for ${STALE_MINUTES}+ minutes. Log progress on this worktree's task (pm log), or reply that there is nothing to track.`);
  assert.doesNotMatch(block.reason, /create|claim/);
});

test('stop: the message counts commits and files together', () => {
  const { root } = setup();
  const { t0 } = begin(root);
  commitAt(root, 'a.js', t0 + 30 * MIN);
  commitAt(root, 'b.js', t0 + 40 * MIN);
  for (const name of ['c.js', 'README.md']) {
    fs.writeFileSync(path.join(root, name), 'y');
    touch(path.join(root, name), t0 + 50 * MIN);
  }
  assert.match(JSON.parse(onStop(S, root, t0 + 120 * MIN)).reason, /^\[pm\] This session made 2 commits and changed 2 files; /);
});

test('stop: commits that arrive by a fast-forward pull or a merge do not block', () => {
  const { root } = setup();
  const other = addWorktree(root, 'feat');
  const { t0 } = begin(root);
  commitAt(other, 'b.js', t0 + 30 * MIN);
  sh(['merge', '-q', '--ff-only', 'feat'], root);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '', 'a fast-forward pull');
  commitAt(other, 'c.js', t0 + 40 * MIN);
  const date = `@${Math.floor((t0 + 50 * MIN) / 1000)} +0000`;
  execFileSync('git', ['merge', '-q', '--no-ff', '-m', 'merge feat', 'feat'], { cwd: root, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  assert.equal(onStop(S, root, t0 + 120 * MIN), '', 'a merge commit');
});

test('stop: only commits newer than the last board update count', () => {
  const { root } = setup();
  const { pm, t0 } = begin(root);
  commitAt(root, 'a.js', t0 + 30 * MIN);
  touch(path.join(pm, 'PLAN.md'), t0 + 60 * MIN);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '', 'the board was updated after the commit');
  commitAt(root, 'b.js', t0 + 90 * MIN);
  assert.ok(blocks(root, t0 + 120 * MIN), 'an own commit after the board update');
});

test('stop: a commit in the same second as the board update does not count', () => {
  const { root } = setup();
  const { pm, t0 } = begin(root);
  const at = Math.floor((t0 + 30 * MIN) / 1000) * 1000;
  commitAt(root, 'a.js', at);
  touch(path.join(pm, 'PLAN.md'), at);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '');
});

test('stop: a reflog shorter than the session offset counts no commits, dirty files still do', () => {
  const { root } = setup();
  commitAt(root, 'before.js', Date.now() - MIN);
  const { t0 } = begin(root);
  fs.writeFileSync(path.join(root, '.git', 'logs', 'HEAD'), ''); // expired or recreated
  commitAt(root, 'a.js', t0 + 30 * MIN);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '');
  const f = path.join(root, 'b.js');
  fs.writeFileSync(f, 'x');
  touch(f, t0 + 60 * MIN);
  assert.ok(blocks(root, t0 + 120 * MIN));
});

test('stop: commit capture moving its own cursor does not hide a session commit', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'mine'], root);
  cli(['claim', 'T-001'], root);
  const { pm, t0 } = begin(root);
  commitAt(root, 'a.js', t0 + 30 * MIN);
  captureCommits(pm, root);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), /^commits: \[\w+\]$/m);
  assert.ok(blocks(root, t0 + 120 * MIN));
});

test('stop: a dirty file counts only when it changed after the session started', () => {
  const { root } = setup();
  const f = path.join(root, 'README.md');
  fs.writeFileSync(f, 'edited before the session\n');
  const { t0 } = begin(root);
  touch(f, t0 - 60 * MIN);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '');
  touch(f, t0 + 60 * MIN);
  assert.match(JSON.parse(onStop(S, root, t0 + 120 * MIN)).reason, /This session changed 1 file;/);
});

test('stop: a deletion counts by the mtime of the directory it was deleted from', () => {
  const { root } = setup();
  for (const name of ['src/a.js', 'lib/b.js', 'app/c.js']) commitAt(root, name, Date.now() - DAY);
  const t = Date.now();
  fs.rmSync(path.join(root, 'src', 'a.js'));
  touch(path.join(root, 'src'), t - 60 * MIN);
  fs.writeFileSync(path.join(root, 'app', 'c.js'), 'modified before the session');
  touch(path.join(root, 'app', 'c.js'), t - 60 * MIN);
  touch(path.join(root, 'app'), t - 60 * MIN);
  const { pm, t0 } = begin(root);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '', 'deleted and modified before the session');
  fs.rmSync(path.join(root, 'lib', 'b.js'));
  touch(path.join(root, 'lib'), t0 + 30 * MIN);
  touch(path.join(pm, 'PLAN.md'), t0 + 60 * MIN);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '', 'deleted, then the board was updated');
  fs.rmSync(path.join(root, 'app', 'c.js'));
  touch(path.join(root, 'app'), t0 + 90 * MIN);
  assert.match(JSON.parse(onStop(S, root, t0 + 120 * MIN)).reason, /changed 1 file;/, 'modified before, deleted after the board update');
});

test('stop: without a session_id or its state file there is nothing to compare — no block', () => {
  const { root } = setup();
  const { t0 } = begin(root);
  const f = path.join(root, 'new.js');
  fs.writeFileSync(f, 'x');
  touch(f, t0 + 60 * MIN);
  assert.equal(onStop({}, root, t0 + 120 * MIN), '');
  assert.equal(onStop({ session_id: 'other' }, root, t0 + 120 * MIN), '');
  assert.ok(blocks(root, t0 + 120 * MIN), 'the session that has state still sees it');
});

test('stop: a session whose start left no state opens its window at the first Stop', () => {
  const { root } = setup();
  const { pm, t0 } = begin(root);
  const late = { session_id: 'late' }; // SessionStart timed out, or the board was created mid-session
  assert.equal(onStop(late, root, t0 + 120 * MIN), '', 'nothing to compare with yet');
  assert.ok(hasState(pm, 'session-late'), 'the window starts now');
  writeState(pm, 'session-late', { ...readState(pm, 'session-late'), start: t0 + 10 * MIN });
  const f = path.join(root, 'new.js');
  fs.writeFileSync(f, 'x');
  touch(f, t0 + 60 * MIN);
  assert.ok(blocks(root, t0 + 120 * MIN, late), 'and the next Stop sees the session work');
});

test('stop: a file deleted before the session never counts, even when its directory changes later', () => {
  const { root } = setup();
  fs.writeFileSync(path.join(root, '.gitignore'), '*.cache\n');
  commitAt(root, 'src/a.js', Date.now() - DAY);
  fs.rmSync(path.join(root, 'src', 'a.js'));
  const { t0 } = begin(root);
  fs.writeFileSync(path.join(root, 'src', 'lint.cache'), 'x'); // an ignored tool file: not a change, but it moves the dir mtime
  touch(path.join(root, 'src'), t0 + 60 * MIN);
  assert.equal(onStop(S, root, t0 + 120 * MIN), '');
});

test('stop: a rename made in the session counts even though git mv keeps the file mtime', () => {
  const { root } = setup();
  commitAt(root, 'src/a.js', Date.now() - DAY);
  const { t0 } = begin(root);
  sh(['mv', 'src/a.js', 'src/b.js'], root);
  touch(path.join(root, 'src'), t0 + 60 * MIN);
  assert.match(JSON.parse(onStop(S, root, t0 + 120 * MIN)).reason, /changed 1 file;/);
});

test('stop: blocks once per window; a re-entrant Stop never blocks', () => {
  const { root } = setup();
  const { t0 } = begin(root);
  const later = t0 + 120 * MIN;
  assert.equal(onStop(S, root, later), '', 'stale board but no change in this session');
  const f = path.join(root, 'new.js');
  fs.writeFileSync(f, 'x');
  touch(f, later - MIN);
  assert.ok(blocks(root, later));
  assert.equal(onStop(S, root, later + 1000), '', 'throttled');
  const afterWindow = later + 2 * STALE_MINUTES * MIN;
  assert.equal(onStop({ ...S, stop_hook_active: true }, root, afterWindow), '');
  assert.ok(blocks(root, afterWindow));
});

test('stop: silent while the board is fresh', () => {
  const { root } = setup();
  begin(root);
  fs.writeFileSync(path.join(root, 'new.js'), 'x');
  assert.equal(onStop(S, root), '');
});

test('stop: a safety note is not a board update and restarts the session window', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'mine'], root);
  cli(['claim', 'T-001'], root);
  const { pm, t0 } = begin(root);
  writeState(pm, 'session-s', { ...readState(pm, 'session-s'), start: t0 - 60 * MIN }); // the session began an hour ago
  const f = path.join(root, 'new.js');
  fs.writeFileSync(f, 'x');
  touch(f, t0 - 30 * MIN);
  const task = path.join(pm, 'tasks', 'T-001.md');
  const before = manualMtime(pm, task);
  onSafetyNote(S, root, 'pre-compact');
  assert.match(fs.readFileSync(task, 'utf8'), /auto: changed files: new\.js/);
  assert.equal(manualMtime(pm, task), before, 'the auto line is not a manual board update');
  assert.equal(onStop(S, root, t0 + 120 * MIN), '', 'nothing new since the note');
  commitAt(root, 'b.js', t0 + 60 * MIN);
  assert.ok(blocks(root, t0 + 120 * MIN), 'a commit after the note');
});

test('stop: PM_DEBUG prints what Stop saw to stderr', () => {
  const { root } = setup();
  begin(root);
  const r = cli(['hook', 'stop'], root, { input: JSON.stringify({ ...S, cwd: root }), env: { PM_DEBUG: '1' } });
  assert.equal(r.code, 0);
  assert.match(r.err, /^\[pm\] stop: no block — /m);
});

test('pre-compact appends an auto note to in-progress tasks of this worktree only', () => {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'mine'], root);
  cli(['claim', 'T-001'], root);
  cli(['task', 'new', '--title', 'other'], root);
  cli(['set', 'T-002', 'status=in_progress', 'worktrees=other-wt'], root);
  onSessionStart({ session_id: 's1' }, root);
  const f = path.join(root, 'feature.js');
  fs.writeFileSync(f, 'x');
  const future = new Date(Date.now() + MIN);
  fs.utimesSync(f, future, future);
  assert.equal(onSafetyNote({ session_id: 's1' }, root, 'pre-compact'), '');
  const pm = pmDir(root);
  assert.match(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), /auto: changed files: feature\.js · last commit: \w+ init/);
  assert.doesNotMatch(fs.readFileSync(path.join(pm, 'tasks', 'T-002.md'), 'utf8'), /auto:/);
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: auto pre-compact');
});

test('without a session_id: summary still prints, but no state and no auto note', () => {
  const { root } = setup();
  cli(['init'], root);
  const pm = pmDir(root);
  const orphan = path.join(pm, '.state', 'session-undefined.json');
  assert.match(onSessionStart({}, root), /^\[pm\] /, 'the summary is still worth printing');
  assert.ok(!fs.existsSync(orphan), 'an empty payload must not claim the "undefined" state key');
  cli(['task', 'new', '--title', 'mine'], root);
  cli(['claim', 'T-001'], root);
  const f = path.join(root, 'feature.js');
  fs.writeFileSync(f, 'x');
  const future = new Date(Date.now() + MIN);
  fs.utimesSync(f, future, future);
  fs.appendFileSync(path.join(pm, 'PLAN.md'), '\nedited\n'); // a real board change for persist to commit
  assert.equal(onSafetyNote({}, root, 'session-end'), '');
  assert.ok(!fs.existsSync(orphan), 'still none after the safety note');
  assert.doesNotMatch(fs.readFileSync(path.join(pm, 'tasks', 'T-001.md'), 'utf8'), /auto:/);
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: auto session-end', 'the board is still committed');
});

test('hook entry point always exits 0', () => {
  const { root } = setup();
  const input = JSON.stringify({ session_id: 'x', cwd: root });
  assert.equal(cli(['hook', 'session-start'], root, { input }).code, 0);
  assert.equal(cli(['hook', 'no-such-event'], root, { input: '{}' }).code, 0);
  assert.equal(cli(['hook', 'stop'], root, { input: 'not json' }).code, 0);
  cli(['init'], root);
  const r = cli(['hook', 'session-start'], root, { input });
  assert.equal(r.code, 0);
  assert.match(r.out, /^\[pm\]/);
});

test('hook stop never throws regardless of stdin shape', () => {
  const { root } = setup();
  cli(['init'], root);
  // Each of these parses without a JSON.parse error, so the fallback-to-{} catch never fires;
  // the handler must still normalize a non-object result instead of crashing on `input.cwd`.
  for (const stdin of ['null', '5', '"text"', '[]', 'not json', '']) {
    const r = cli(['hook', 'stop'], root, { input: stdin });
    assert.equal(r.code, 0, `stdin ${JSON.stringify(stdin)} should exit 0`);
    assert.equal(r.err, '', `stdin ${JSON.stringify(stdin)} should print nothing to stderr`);
  }
});

test('stop: the repeated Stop after a block still commits a hand edit of the board', () => {
  const { root } = setup();
  cli(['init'], root);
  const pm = pmDir(root);
  fs.appendFileSync(path.join(pm, 'PLAN.md'), '- ATS-1: edited by hand\n');
  assert.equal(onPostToolUse({ tool_name: 'Edit', tool_input: { file_path: path.join(pm, 'PLAN.md') } }, root), '');
  assert.match(sh(['status', '--porcelain'], pm), /PLAN\.md/, 'PostToolUse only redraws the board');
  assert.equal(onStop({ stop_hook_active: true }, root), '');
  assert.equal(sh(['status', '--porcelain'], pm), '', 'the re-entrant Stop is the only commit path for this edit');
  assert.equal(sh(['log', '-1', '--format=%s'], pm), 'pm: stop');
});
