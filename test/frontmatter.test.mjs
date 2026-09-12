import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../scripts/lib/frontmatter.mjs';

test('parse and serialize round-trip', () => {
  const text = '---\nid: T-001\ntitle: "Fix: login"\ndepends_on: [T-002, T-003]\nwaiting_on: ""\norder: 2\n---\n## Goal\n';
  const { data, body } = parse(text);
  assert.deepEqual(data, { id: 'T-001', title: 'Fix: login', depends_on: ['T-002', 'T-003'], waiting_on: '', order: '2' });
  assert.equal(body, '## Goal\n');
  assert.equal(serialize(data, body), text);
});

test('CRLF input is normalized and empty lists parse as []', () => {
  const { data, body } = parse('---\r\nlinks: []\r\ntitle: x\r\n---\r\nbody\r\n');
  assert.deepEqual(data, { links: [], title: 'x' });
  assert.equal(body, 'body\n');
});

test('text without frontmatter is all body', () => {
  assert.deepEqual(parse('# hi\n'), { data: {}, body: '# hi\n' });
});

test('values that would be misread are quoted', () => {
  assert.equal(serialize({ a: '[not a list]', b: ' lead', c: 'ok' }, ''), '---\na: "[not a list]"\nb: " lead"\nc: ok\n---\n');
});
