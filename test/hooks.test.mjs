import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, tmp, sh, cli } from './helpers.mjs';
import { pmDir, memoryDir } from '../scripts/lib/paths.mjs';
import { onSessionStart, onPostToolUse, onStop, onSafetyNote, STALE_MINUTES } from '../scripts/lib/hooks.mjs';

const MIN = 60_000;

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

test('stop: blocks once when code changed and the board is stale', () => {
  const { root } = setup();
  cli(['init'], root);
  const later = Date.now() + 120 * MIN;
  assert.equal(onStop({}, root, later), '', 'stale board but no code change');
  const f = path.join(root, 'new.js');
  fs.writeFileSync(f, 'x');
  fs.utimesSync(f, new Date(later - MIN), new Date(later - MIN));
  const block = JSON.parse(onStop({}, root, later));
  assert.equal(block.decision, 'block');
  assert.match(block.reason, /board/);
  assert.equal(onStop({}, root, later + 1000), '', 'throttled');
  const afterWindow = later + 2 * STALE_MINUTES * MIN;
  assert.equal(onStop({ stop_hook_active: true }, root, afterWindow), '');
  assert.notEqual(onStop({}, root, afterWindow), '');
});

test('stop: silent while the board is fresh', () => {
  const { root } = setup();
  cli(['init'], root);
  fs.writeFileSync(path.join(root, 'new.js'), 'x');
  assert.equal(onStop({}, root), '');
});

test('stop: a deleted tracked file counts as a code change even though it has no mtime', () => {
  const { root } = setup();
  cli(['init'], root);
  fs.rmSync(path.join(root, 'README.md')); // tracked, committed by setup(); now deleted, uncommitted
  const later = Date.now() + 120 * MIN;
  const block = JSON.parse(onStop({}, root, later));
  assert.equal(block.decision, 'block');
  assert.match(block.reason, /board/);
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
