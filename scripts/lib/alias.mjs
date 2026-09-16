import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { marketplaceEntry, runningPlugin } from './update.mjs';

const HERE = fileURLToPath(new URL('../pm.mjs', import.meta.url));
const MARK = '# pm: project-memory CLI (written by pm alias)';
const DEFINES_PM = /^\s*(alias\s+pm=|function\s+pm\b|pm\s*\(\s*\))/i;
const TIMEOUT_MS = 10_000;
const BOM = String.fromCharCode(0xfeff);

// The marketplace copy keeps its path across updates; the running copy may sit in a versioned cache folder.
export function stableScript(plugin = runningPlugin()) {
  const dir = plugin?.name ? marketplaceEntry(plugin.name)?.dir : null;
  const script = dir && path.join(dir, 'scripts', 'pm.mjs');
  return script && fs.existsSync(script) ? script : HERE;
}

// Single quotes on both sides: nothing in the path is expanded, a quote inside it is escaped.
const psQuote = (s) => `'${s.replace(/'/g, "''")}'`;
const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export const aliasLine = (shell, script) =>
  shell === 'powershell' ? `function pm { node ${psQuote(script)} @args }` : `alias pm=${shQuote(`node ${shQuote(script.replace(/\\/g, '/'))}`)}`;

// $PROFILE is asked from PowerShell itself: it may live under OneDrive or a localized Documents folder.
function powershellProfiles() {
  const out = [];
  for (const exe of ['powershell.exe', 'pwsh']) {
    try {
      const [profile, policy] = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $PROFILE; Get-ExecutionPolicy'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: TIMEOUT_MS,
      }).split(/\r?\n/);
      if (profile) out.push({ shell: 'powershell', file: profile, policy });
    } catch {
      // that PowerShell is not installed or did not answer in time
    }
  }
  return out;
}

// Windows: every PowerShell plus Git Bash (git is required, Git for Windows ships bash).
// macOS: Terminal opens login shells, so bash reads ~/.bash_profile. Elsewhere: the login shell's rc file.
export function aliasTargets({ platform = process.platform, shell = process.env.SHELL ?? '', home = os.homedir(), profiles = powershellProfiles } = {}) {
  const at = (name, file) => ({ shell: name, file: path.join(home, file) });
  if (platform === 'win32') return [...profiles(), at('bash', '.bashrc')];
  if (path.basename(shell) === 'zsh') return [at('zsh', '.zshrc')];
  return [platform === 'darwin' ? at('bash', '.bash_profile') : at('bash', '.bashrc')];
}

// Only the line under our own marker is ever replaced; a pm the user defined is left alone.
export function writeAlias(file, line, { bom = false } = {}) {
  const exists = fs.existsSync(file);
  const bytes = exists ? fs.readFileSync(file) : Buffer.alloc(0);
  // `>` in Windows PowerShell 5.1 writes UTF-16LE; that encoding is kept. Anything not valid UTF-8 (an ANSI profile) is not touched.
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  let text;
  try {
    text = utf16 ? bytes.toString('utf16le') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return 'skipped, the file is not UTF-8 or UTF-16: add the line by hand';
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const mark = lines.findIndex((l) => l.replace(BOM, '') === MARK);
  const ours = mark >= 0 && DEFINES_PM.test(lines[mark + 1] ?? '') ? mark + 1 : -1;
  if (ours >= 0 && lines[ours] === line) return 'already there';
  if (ours < 0 && lines.some((l, i) => (mark < 0 || i !== mark + 1) && DEFINES_PM.test(l))) return 'skipped, pm is already defined there by hand';
  if (ours >= 0) lines[ours] = line;
  else if (mark >= 0) lines.splice(mark + 1, 0, line);
  else {
    while (lines.length && lines.at(-1) === '') lines.pop();
    lines.push(...(lines.length ? [''] : []), MARK, line, '');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Windows PowerShell 5.1 reads a BOM-less script as ANSI: a new profile gets a BOM so a non-ASCII path survives.
  fs.writeFileSync(file, `${!exists && bom ? BOM : ''}${lines.join(eol)}`, utf16 ? 'utf16le' : 'utf8');
  return ours >= 0 ? 'updated' : 'added';
}

export function installAliases(targets = aliasTargets(), script = stableScript()) {
  if (!targets.length) return 'no shell profile found: add the alias by hand (see README, "pm in an ordinary terminal")';
  // Editing a signed profile breaks its signature, and AllSigned then rejects the whole profile.
  const write = (t) => (t.policy === 'AllSigned' ? 'skipped, AllSigned rejects a profile edited without re-signing' : writeAlias(t.file, aliasLine(t.shell, script), { bom: t.shell === 'powershell' }));
  const out = targets.map((t) => `${write(t)}: ${t.file}`);
  // A profile is not loaded under Restricted; changing the policy is the user's call, never ours.
  if (targets.some((t) => /^Restricted$/.test(t.policy ?? ''))) {
    out.push('PowerShell will not load the profile under this execution policy; to allow it: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned');
  }
  out.push(`alias points to ${script}`, 'open a new terminal, then: pm board');
  return out.join('\n');
}
