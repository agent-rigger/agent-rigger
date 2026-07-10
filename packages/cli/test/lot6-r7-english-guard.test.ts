/**
 * lot6-r7-english-guard.test.ts — R7: user-facing messages stay in English.
 *
 * Anti-regression guard (design D7): every string/template literal under
 * `packages/*\/src` (across all workspace packages — catalog, cli, adapters,
 * core) SHALL contain zero accented Latin characters (à è é ê ë ï î ô ö ù û ü
 * ç, upper and lower case). The check is scoped to LITERALS, not source text
 * at large, so legitimate French stays allowed in comments/JSDoc (a lot of
 * `qualify.ts`'s prose predates this lot and is out of R7's scope — L15 only
 * covers user-facing strings) while a translated message can never silently
 * regress back to French.
 *
 * A hand-rolled scanner (not a full parser) walks each file once, character
 * by character, and extracts the raw text of every `'...'`, `"..."` and
 * `` `...` `` literal while skipping `//` and `/* *\/` comments and the
 * `${...}` interpolation holes of template literals (those holes are code,
 * not literal text — e.g. an interpolated variable name is not user-facing
 * copy). This is what keeps the guard from matching accented characters that
 * only ever appear in comments.
 *
 * TDD: written to prove RED against the pre-T8 French sites in fetch.ts/ui.ts,
 * then GREEN once T8's translations land.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'bun:test';

// ---------------------------------------------------------------------------
// Source walker — every packages/*/src, recursively, excluding test files
// ---------------------------------------------------------------------------

const PACKAGES_DIR = path.resolve(import.meta.dirname, '../../../packages');

/** Recursively collect every non-test `.ts` file under `dir` (recursion, no while loop). */
function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((name) => {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) return collectTsFiles(full);
    if (!full.endsWith('.ts')) return [];
    if (full.endsWith('.test.ts')) return []; // tests may legitimately quote French fixtures
    return [full];
  });
}

/** Every `packages/<name>/src` directory, e.g. `packages/catalog/src`. */
function collectSrcFiles(): string[] {
  const packageNames = readdirSync(PACKAGES_DIR).filter((name) =>
    statSync(path.join(PACKAGES_DIR, name)).isDirectory()
  );
  return packageNames.flatMap((name) => {
    const srcDir = path.join(PACKAGES_DIR, name, 'src');
    try {
      statSync(srcDir);
    } catch {
      return [];
    }
    return collectTsFiles(srcDir);
  });
}

const SRC_FILES = collectSrcFiles();

// ---------------------------------------------------------------------------
// Literal extraction — comments and `${...}` holes are never literal text
// ---------------------------------------------------------------------------

/**
 * Extracts the raw contents of every string/template literal in `source`,
 * skipping `//` line comments, `/* *\/` block comments, and the `${...}`
 * interpolation holes inside template literals (their contents are
 * expressions, not literal text). Not a full parser — a single left-to-right
 * pass with just enough state (in-comment / in-string / in-template /
 * in-interpolation-hole) to separate "string literal" from "everything else"
 * for this guard's purposes. Regex literals are not specially handled: their
 * body is scanned as ordinary code (never captured as a literal), which is
 * correct here since no regex in this codebase embeds `//` or `/*`.
 */
function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment — skip to end of line.
    if (c === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment — skip to closing `*/`.
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Single/double-quoted string.
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let buf = '';
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\') {
          buf += source[j] + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        buf += source[j];
        j++;
      }
      literals.push(buf);
      i = j + 1;
      continue;
    }

    // Template literal — `${...}` holes are code, not literal text.
    if (c === '`') {
      let j = i + 1;
      let buf = '';
      while (j < n && source[j] !== '`') {
        if (source[j] === '\\') {
          buf += source[j] + (source[j + 1] ?? '');
          j += 2;
          continue;
        }
        if (source[j] === '$' && source[j + 1] === '{') {
          j += 2;
          let depth = 1;
          while (j < n && depth > 0) {
            if (source[j] === '{') depth++;
            else if (source[j] === '}') depth--;
            j++;
          }
          continue;
        }
        buf += source[j];
        j++;
      }
      literals.push(buf);
      i = j + 1;
      continue;
    }

    i++;
  }

  return literals;
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

const ACCENTED_RE = /[àâäéèêëïîôöùûüçÀÂÄÉÈÊËÏÎÔÖÙÛÜÇ]/;

describe('lot6-R7: English-only string literals guard', () => {
  it('has at least one .ts file to scan (sanity check on the walker)', () => {
    expect(SRC_FILES.length).toBeGreaterThan(10);
  });

  it('zero string/template literal under packages/*/src contains an accented character', () => {
    const offenders: string[] = [];

    for (const file of SRC_FILES) {
      const source = readFileSync(file, 'utf8');
      const literals = extractStringLiterals(source);
      for (const literal of literals) {
        if (ACCENTED_RE.test(literal)) {
          offenders.push(`${path.relative(PACKAGES_DIR, file)}: ${JSON.stringify(literal)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
