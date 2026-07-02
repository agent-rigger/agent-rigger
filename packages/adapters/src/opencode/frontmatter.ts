/**
 * Pure hand-rolled YAML-frontmatter parser/serializer for opencode sub-agent
 * translation (design.md §7.2, C3). No runtime dependency: the frontmatter
 * used by the catalog's sub-agents is a small subset — flat `key: value`
 * scalars, an occasional inline `[a, b]` or one-per-line list, and (on the
 * opencode output side) a one-level-deep nested map such as `permission:`.
 *
 * Total, side-effect-free:
 * - parseFrontmatter never throws — a missing/malformed fence returns `{ data: {}, body: md }`.
 * - serializeFrontmatter never auto-inserts a blank line after the closing fence: the
 *   `body` is appended verbatim, exactly as `parseFrontmatter` would have extracted it
 *   (leading blank line included when present) — this is what keeps
 *   `parseFrontmatter(serializeFrontmatter(data, body))` an exact round-trip.
 */

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

/** Result of parsing a Markdown file with an optional YAML frontmatter block. */
export interface ParsedFrontmatter {
  /** Frontmatter fields (flat scalars, arrays, or a one-level-deep nested map). */
  data: Record<string, unknown>;
  /** Everything after the closing `---` fence, verbatim (or the whole input if no fence). */
  body: string;
}

/**
 * Parse a Markdown file's frontmatter block, if any.
 *
 * - No leading `---` fence (or no closing fence) → `{ data: {}, body: md }` (input untouched).
 * - Valid `---\n...\n---\n` block → `{ data: <parsed fields>, body: <everything after> }`.
 */
export function parseFrontmatter(md: string): ParsedFrontmatter {
  const lines = md.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') {
    return { data: {}, body: md };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').replace(/\r$/, '') === '---') {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    return { data: {}, body: md };
  }

  const blockLines = lines.slice(1, closingIndex);
  const bodyLines = lines.slice(closingIndex + 1);
  return { data: parseBlockLines(blockLines), body: bodyLines.join('\n') };
}

// ---------------------------------------------------------------------------
// serializeFrontmatter
// ---------------------------------------------------------------------------

/**
 * Serialize frontmatter fields + a body back into a Markdown string with a
 * `---`-fenced YAML-ish block. Field order follows `Object.entries(data)`
 * insertion order. `undefined` values are omitted entirely.
 *
 * Supported value shapes: string/number/boolean scalars, string arrays
 * (rendered as an inline `[a, b]` list), and one-level-deep plain objects
 * (rendered as an indented nested map).
 */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else if (value !== null && typeof value === 'object') {
      lines.push(`${key}:`);
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`  ${subKey}: ${String(subValue)}`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return `---\n${lines.join('\n')}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Internal helpers — block parsing
// ---------------------------------------------------------------------------

/** Count of leading ASCII space characters (tabs are not treated as indentation). */
function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch !== ' ') {
      break;
    }
    n++;
  }
  return n;
}

/** Strip a single layer of matching surrounding quotes, if present. */
function stripQuotes(s: string): string {
  if (
    s.length >= 2
    && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse a scalar value, or an inline `[a, b, c]` list. */
function parseScalarOrInlineList(rest: string): unknown {
  if (rest.startsWith('[') && rest.endsWith(']')) {
    const inner = rest.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((s) => s.trim());
  }
  return stripQuotes(rest);
}

/**
 * Consume the indented lines following a `key:` line with no inline value.
 * Returns either a one-per-line list (`- item`) or a nested one-level map,
 * plus the number of lines consumed (blank lines included).
 */
function parseNestedBlock(lines: string[], start: number): { value: unknown; consumed: number } {
  const nested: string[] = [];
  let consumed = 0;

  for (let j = start; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (line.trim() === '') {
      consumed++;
      continue;
    }
    if (leadingSpaces(line) === 0) {
      break;
    }
    nested.push(line.trim());
    consumed++;
  }

  if (nested.length === 0) {
    return { value: '', consumed };
  }

  const first = nested[0] ?? '';
  if (first.startsWith('- ') || first === '-') {
    return { value: nested.map((l) => l.replace(/^-\s*/, '')), consumed };
  }

  const map: Record<string, string> = {};
  for (const l of nested) {
    const idx = l.indexOf(':');
    if (idx === -1) {
      continue;
    }
    map[l.slice(0, idx).trim()] = l.slice(idx + 1).trim();
  }
  return { value: map, consumed };
}

/** Parse the top-level `key: value` lines of a frontmatter block. */
function parseBlockLines(lines: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || leadingSpaces(line) > 0) {
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest !== '') {
      data[key] = parseScalarOrInlineList(rest);
      continue;
    }

    const { value, consumed } = parseNestedBlock(lines, i + 1);
    data[key] = value;
    i += consumed;
  }

  return data;
}
