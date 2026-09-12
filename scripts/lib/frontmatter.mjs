// Restricted frontmatter: `key: value`, `key: [a, b]`, `key: ""`. Nothing else.

export function parse(text) {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { data: {}, body: src };
  const end = src.indexOf('\n---\n', 3);
  if (end === -1) return { data: {}, body: src };
  const data = {};
  for (const line of src.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) data[m[1]] = parseValue(m[2].trim());
  }
  return { data, body: src.slice(end + 5) };
}

function parseValue(v) {
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

export function serialize(data, body) {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${formatValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

function formatValue(v) {
  if (Array.isArray(v)) return `[${v.join(', ')}]`;
  const s = String(v);
  return s === '' || /^[\s["]|[:#]|\s$/.test(s) ? JSON.stringify(s) : s;
}
