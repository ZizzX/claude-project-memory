import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp } from './helpers.mjs';
import { aliasLine, aliasTargets, writeAlias, installAliases } from '../scripts/lib/alias.mjs';

const MARK = '# pm: project-memory CLI (written by pm alias)';

test('aliasLine: single-quoted paths, bash gets forward slashes', () => {
  assert.equal(aliasLine('powershell', 'C:\\p\\pm.mjs'), "function pm { node 'C:\\p\\pm.mjs' @args }");
  assert.equal(aliasLine('powershell', "C:\\it's\\pm.mjs"), "function pm { node 'C:\\it''s\\pm.mjs' @args }");
  assert.equal(aliasLine('bash', 'C:\\p\\pm.mjs'), `alias pm='node '\\''C:/p/pm.mjs'\\'''`);
});

// The generated lines really run: a path with $, a quote and a space reaches node unchanged.
test('aliasLine: the alias runs in a real shell with an awkward path', (t) => {
  const dir = path.join(tmp(), "it's $HOME dir");
  fs.mkdirSync(dir);
  const script = path.join(dir, 'pm.mjs');
  fs.writeFileSync(script, 'console.log("ran", process.argv.slice(2).join(","));\n');
  const shells = [
    ['bash', ['-c', `shopt -s expand_aliases\n${aliasLine('bash', script)}\npm a b`]],
    ...(process.platform === 'win32' ? [['powershell.exe', ['-NoProfile', '-Command', `${aliasLine('powershell', script)}; pm a b`]]] : []),
  ];
  for (const [exe, args] of shells) {
    const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 20_000 });
    if (r.error) {
      t.diagnostic(`${exe} not available`);
      continue;
    }
    assert.equal(r.stdout.trim(), 'ran a,b', `${exe}: ${r.stderr}`);
  }
});

test('aliasTargets: every PowerShell plus Git Bash on Windows, bash_profile on macOS, the login shell elsewhere', () => {
  const home = tmp();
  const ps = [{ shell: 'powershell', file: 'C:\\Docs\\profile.ps1', policy: 'RemoteSigned' }];
  assert.deepEqual(aliasTargets({ platform: 'win32', shell: '', home, profiles: () => ps }), [...ps, { shell: 'bash', file: path.join(home, '.bashrc') }]);
  assert.deepEqual(aliasTargets({ platform: 'darwin', shell: '/bin/zsh', home }), [{ shell: 'zsh', file: path.join(home, '.zshrc') }]);
  assert.deepEqual(aliasTargets({ platform: 'darwin', shell: '/bin/bash', home }), [{ shell: 'bash', file: path.join(home, '.bash_profile') }]);
  assert.deepEqual(aliasTargets({ platform: 'linux', shell: '', home }), [{ shell: 'bash', file: path.join(home, '.bashrc') }]);
});

test('writeAlias: creates with a BOM when asked, appends once, replaces only its own line, keeps CRLF', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'profile.ps1');
  assert.equal(writeAlias(file, 'function pm { a }', { bom: true }), 'added');
  assert.equal(fs.readFileSync(file, 'utf8'), `\uFEFF${MARK}\nfunction pm { a }\n`);
  assert.equal(writeAlias(file, 'function pm { a }', { bom: true }), 'already there');
  assert.equal(writeAlias(file, 'function pm { b }', { bom: true }), 'updated');
  assert.equal(fs.readFileSync(file, 'utf8').match(/function pm/g).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8').match(/\uFEFF/g).length, 1, 'an existing BOM is not doubled');

  const crlf = path.join(dir, 'crlf.ps1');
  fs.writeFileSync(crlf, 'Set-Alias ll ls\r\n\r\n');
  writeAlias(crlf, 'function pm { a }');
  assert.equal(fs.readFileSync(crlf, 'utf8'), `Set-Alias ll ls\r\n\r\n${MARK}\r\nfunction pm { a }\r\n`);
});

test('writeAlias: a pm defined by hand is left alone; a marker without its line gets the line back', () => {
  const dir = tmp();
  const own = path.join(dir, 'own.ps1');
  const handMade = 'function pm {\n  node x @args\n}\n';
  fs.writeFileSync(own, handMade);
  assert.match(writeAlias(own, 'function pm { a }'), /^skipped/);
  assert.equal(fs.readFileSync(own, 'utf8'), handMade);

  const orphan = path.join(dir, 'orphan.rc');
  fs.writeFileSync(orphan, `x\n${MARK}\ny\n`);
  assert.equal(writeAlias(orphan, "alias pm='a'"), 'added');
  assert.equal(fs.readFileSync(orphan, 'utf8'), `x\n${MARK}\nalias pm='a'\ny\n`, 'no second marker');
});

test('installAliases: reports each file, the target script and a policy that blocks the profile', () => {
  const dir = tmp();
  const out = installAliases([{ shell: 'powershell', file: path.join(dir, 'p.ps1'), policy: 'Restricted' }, { shell: 'bash', file: path.join(dir, '.bashrc') }], '/x/pm.mjs');
  assert.match(out, /^added: .*p\.ps1\nadded: .*\.bashrc\n.*Set-ExecutionPolicy -Scope CurrentUser RemoteSigned\nalias points to \/x\/pm\.mjs\nopen a new terminal/);
  assert.match(installAliases([], '/x'), /no shell profile found/);
});

test('writeAlias: UTF-16LE profile stays UTF-16LE, an ANSI profile and a shell-style pm() are not touched', () => {
  const dir = tmp();
  const wide = path.join(dir, 'wide.ps1');
  fs.writeFileSync(wide, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Set-Alias ll ls\r\n', 'utf16le')]));
  assert.equal(writeAlias(wide, 'function pm { a }'), 'added');
  const bytes = fs.readFileSync(wide);
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xfe]);
  assert.match(bytes.toString('utf16le'), /Set-Alias ll ls\r\n\r\n# pm: .*\r\nfunction pm \{ a \}\r\n$/);

  const ansi = path.join(dir, 'ansi.ps1');
  const cp1251 = Buffer.from([0x23, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]);
  fs.writeFileSync(ansi, cp1251);
  assert.match(writeAlias(ansi, 'function pm { a }'), /^skipped, the file is not UTF-8/);
  assert.deepEqual(fs.readFileSync(ansi), cp1251);

  for (const fn of ['pm() { node x "$@"; }', 'pm () {']) {
    const rc = path.join(dir, `rc-${fn.length}`);
    fs.writeFileSync(rc, `${fn}\n`);
    assert.match(writeAlias(rc, "alias pm='a'"), /^skipped, pm is already defined/, fn);
  }
});

test('installAliases: a profile under AllSigned is never edited', () => {
  const file = path.join(tmp(), 'signed.ps1');
  fs.writeFileSync(file, 'x\n');
  assert.match(installAliases([{ shell: 'powershell', file, policy: 'AllSigned' }], '/x/pm.mjs'), /^skipped, AllSigned/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\n');
});
