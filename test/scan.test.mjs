import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setup, cli } from './helpers.mjs';
import { scanPlans } from '../scripts/lib/scan.mjs';

test('scanPlans finds plan files with checkbox counts', () => {
  const { root } = setup();
  fs.mkdirSync(path.join(root, 'docs', 'superpowers', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'superpowers', 'plans', '2026-09-12-x.md'), '# x\n- [x] a\n- [ ] b\n  - [X] c\n');
  fs.mkdirSync(path.join(root, 'docs', 'designs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'designs', 'y.md'), '# y\n');
  fs.writeFileSync(path.join(root, 'docs', 'designs', 'z.txt'), 'ignored');
  const found = scanPlans(root).map((p) => [path.basename(p.path), p.done, p.total]);
  assert.deepEqual(found, [['2026-09-12-x.md', 2, 3], ['y.md', 0, 0]]);
  cli(['init'], root);
  assert.match(cli(['scan'], root).out, /2\/3 .*2026-09-12-x\.md/);
});

test('scan reports when nothing is found', () => {
  const { root } = setup();
  cli(['init'], root);
  assert.equal(cli(['scan'], root).out, '(no plans found)');
});
