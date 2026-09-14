import fs from 'node:fs';
import path from 'node:path';

export const planFile = (pm) => path.join(pm, 'PLAN.md');

export function planTemplate(name, date) {
  return `# ${name}

<!-- One board per git repository, shared by every worktree and every direction of work. -->
## Goal

<!-- The goal of the repository or product. A direction's own plan is a separate file, linked from its tasks with --links. -->

## Milestones

## Current focus

<!-- One line per epic: "- ATS-1224: what is happening now". Leave other epics' lines alone. -->

## Changelog
- ${date} · board created
`;
}

function read(pm) {
  const file = planFile(pm);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
}

export function projectName(pm) {
  return read(pm).match(/^# (.+)$/m)?.[1].trim() ?? '';
}

const KEY = /^[-*]\s+([A-Za-z0-9][A-Za-z0-9._-]*):\s*(.+)$/;

// Every "## Current focus" section (a direction may have its own under a "# …" heading), without
// HTML comments and sub-headings. A line is an epic's line only when that epic exists on the board
// (`keys`), so "- M1: core" on a board without epics stays the plain focus it always was.
function focusEntries(pm, keys) {
  const lines = read(pm)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/^#{1,2} /m)
    .filter((s) => s.startsWith('Current focus\n'))
    .flatMap((s) => s.split('\n').slice(1))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const tagged = lines.map((l) => l.match(KEY)).filter((m) => m && (!keys || keys.has(m[1])));
  return { tagged, plain: lines[0] ?? '' };
}

// With an epic: its own line. Without one: the single-line format as before, or '' once the
// section is a list — another epic's focus never leaks into a session.
export function currentFocus(pm, epic = '', keys) {
  const { tagged, plain } = focusEntries(pm, keys);
  if (!tagged.length) return plain;
  return epic ? tagged.find((m) => m[1] === epic)?.[2].trim() ?? '' : '';
}

// The shared board has no epic of its own: it shows every line.
export function focusList(pm, keys) {
  const { tagged, plain } = focusEntries(pm, keys);
  return tagged.length ? tagged.map((m) => `${m[1]}: ${m[2].trim()}`) : plain ? [plain] : [];
}
