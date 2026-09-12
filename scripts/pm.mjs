#!/usr/bin/env node
// Spike version: proves plugin hooks can run this script. Replaced in Task 9.
import fs from 'node:fs';

const [cmd, event] = process.argv.slice(2);
if (cmd === 'hook') {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    // no stdin
  }
  if (event === 'session-start') {
    process.stdout.write(`[pm] spike ok on ${process.platform}\n`);
  } else if (event === 'post-tool-use') {
    const file = String(input.tool_input?.file_path ?? '');
    const additionalContext = `[pm] plan updated: ${file}`;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } })}\n`);
  }
}
process.exit(0);
