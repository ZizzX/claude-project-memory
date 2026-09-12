import fs from 'node:fs';
import path from 'node:path';

export const planFile = (pm) => path.join(pm, 'PLAN.md');

export function planTemplate(name, date) {
  return `# ${name}\n\n## Goal\n\n## Milestones\n\n## Current focus\n\n## Changelog\n- ${date} · board created\n`;
}

function read(pm) {
  const file = planFile(pm);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : '';
}

export function projectName(pm) {
  return read(pm).match(/^# (.+)$/m)?.[1].trim() ?? '';
}

export function currentFocus(pm) {
  return read(pm).match(/^## Current focus\n+([^\n#][^\n]*)/m)?.[1].trim() ?? '';
}
