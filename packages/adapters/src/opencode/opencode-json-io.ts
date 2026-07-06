/**
 * JSONC-tolerant read/write for opencode.json (E-jsonc, review MEDIUM-1).
 *
 * opencode allows comments and trailing commas in `opencode.json` (it is JSONC).
 * The strict `readJson` from core would throw `InvalidJsonError` on such a valid
 * config (exit 2), and `writeJson` (JSON.stringify) would strip the user's
 * comments on every merge. This module fixes both:
 *
 * - `readOpencodeJson` parses tolerantly (comments / trailing commas allowed),
 *   returning `{}` for an absent file and throwing an actionable error only for
 *   genuinely malformed content.
 * - `applyOpencodeKey` sets a single top-level key on the RAW text via
 *   jsonc-parser's `modify` + `applyEdits`, preserving every comment, key order
 *   and formatting the user had.
 *
 * The claude adapter (settings.json) keeps using strict `readJson`/`writeJson`.
 */

import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type ParseError,
  printParseErrorCode,
} from 'jsonc-parser';

import { readText, writeText } from '@agent-rigger/core/fs-json';

/**
 * Thrown when opencode.json exists but is not parseable even as JSONC.
 * Carries the file path for an actionable CLI message (exit 2).
 */
export class InvalidOpencodeJsonError extends Error {
  readonly path: string;

  constructor(filePath: string, detail: string) {
    super(`Invalid opencode.json in "${filePath}": ${detail}`);
    this.name = 'InvalidOpencodeJsonError';
    this.path = filePath;
  }
}

/**
 * Read and JSONC-parse opencode.json.
 *
 * - Absent file → `{}`.
 * - Valid JSON/JSONC object → the parsed object.
 * - Valid JSONC but not an object (array/primitive) → `{}` (callers spread it).
 * - Genuinely malformed → throws InvalidOpencodeJsonError.
 */
export async function readOpencodeJson(filePath: string): Promise<Record<string, unknown>> {
  const raw = await readText(filePath);
  if (raw.trim() === '') {
    return {};
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new InvalidOpencodeJsonError(filePath, printParseErrorCode(first.error));
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}

/**
 * Set a single top-level `key` to `value` in opencode.json, preserving all
 * existing comments / formatting. Reads the raw text, applies a surgical
 * jsonc-parser edit, and writes it back atomically (via core writeText).
 *
 * An absent file is created from `{}` (a plain, comment-free document).
 */
export async function applyOpencodeKey(
  filePath: string,
  key: string,
  value: unknown,
): Promise<void> {
  const existing = await readText(filePath);
  const source = existing.trim() === '' ? '{}' : existing;

  const edits = modify(source, [key], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  const updated = applyEdits(source, edits);

  await writeText(filePath, updated.endsWith('\n') ? updated : updated + '\n');
}
