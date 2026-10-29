import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, cli } from './helpers.mjs';
import { pmDir } from '../scripts/lib/paths.mjs';

function board() {
  const { root } = setup();
  cli(['init'], root);
  cli(['task', 'new', '--title', 'a'], root);
  cli(['claim', 'T-001'], root);
  return { root, file: path.join(pmDir(root), 'tasks', 'T-001.md') };
}

test('pm later keeps a declined finding as later#n on the task; numbers are per task and never reused', () => {
  const { root, file } = board();
  assert.equal(cli(['later', 'T-001', 'the date picker drops the time zone'], root).out, 'T-001 later#1 recorded');
  assert.match(fs.readFileSync(file, 'utf8'), /^- \d{4}-\d{2}-\d{2} · \S+ · later#1: the date picker drops the time zone$/m);
  assert.equal(cli(['later', 'T-001', '- [ ] second\nline'], root).out, 'T-001 later#2 recorded');
  assert.match(fs.readFileSync(file, 'utf8'), / · later#2: second line$/m, 'one line, no checklist marker');
  assert.equal(cli(['later'], root).out, 'T-001 later#1: the date picker drops the time zone\nT-001 later#2: second line', "this worktree's open items");
  assert.equal(cli(['later', 'T-001', '--keep', '1'], root).out, 'T-001 later#1 kept');
  assert.equal(cli(['later', 'T-001'], root).out, 'T-001 later#2: second line');
  assert.equal(cli(['later', 'T-001', '--dismiss', 'all'], root).out, 'T-001 later#2 dismissed');
  assert.equal(cli(['later'], root).out, '(no open later items)');
  assert.equal(cli(['later', 'T-001', 'third'], root).out, 'T-001 later#3 recorded');
  assert.match(fs.readFileSync(file, 'utf8'), / · later#1 kept\n.* · later#2 dismissed\n.* · later#3: third\n$/);
});

test('pm task new --from <id> --later <n> turns a later item into a task and resolves it', () => {
  const { root, file } = board();
  cli(['later', 'T-001', 'export ignores filters'], root);
  const r = cli(['task', 'new', '--title', 'export filters', '--from', 'T-001', '--later', '1'], root);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^T-002 created: /);
  assert.match(fs.readFileSync(file, 'utf8'), / · later#1 → T-002$/m);
  assert.equal(cli(['later'], root).out, '(no open later items)');
  const tasks = () => fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.md')).length;
  const gone = cli(['task', 'new', '--title', 'x', '--from', 'T-001', '--later', '1'], root);
  assert.equal(gone.code, 1);
  assert.equal(gone.err, 'later#1 is not open on T-001 — open: none — nothing created — pm later T-001 lists them');
  const lone = cli(['task', 'new', '--title', 'x', '--later', '1'], root);
  assert.equal(lone.code, 1);
  assert.match(lone.err, /^--later needs --from — /);
  assert.equal(tasks(), 2, 'no id was reserved');
});

test('pm later errors say what, why and the next command', () => {
  const { root } = board();
  const unknown = cli(['later', 'T-999', 'x'], root);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.err, 'T-999 not found — pm ready --all lists tasks');
  assert.equal(cli(['later', 'T-001', '  - [ ] '], root).err, 'nothing to record: the text is empty — pm later T-001 "<what was found>"');
  cli(['later', 'T-001', 'x'], root);
  assert.equal(cli(['later', 'T-001', '--keep', '9'], root).err, 'later#9 is not open on T-001 — open: 1 — pm later T-001 lists them');
  assert.equal(cli(['later', 'T-001', '--keep', '1', '--dismiss', '1'], root).code, 1);
});
