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
 *   and formatting the user had. Edits are LEAF-granular (review M6): the current
 *   and desired values are diffed and only changed/added/removed leaves get a
 *   deep-path edit, so comments INSIDE the key (e.g. inside `permission`) survive.
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

/** jsonc-parser modification options shared by every surgical edit. */
const MODIFY_OPTIONS = {
  formattingOptions: { insertSpaces: true, tabSize: 2 },
};

/** Whether `v` is a plain (non-null, non-array) object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Structural deep equality for plain JSON data (object key order insensitive). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    return aKeys.length === Object.keys(b).length
      && aKeys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** One surgical edit: set (or remove, when `value` is undefined) at a deep path. */
interface LeafEdit {
  path: string[];
  value: unknown;
}

/**
 * Diff `current` against `next` into leaf-granular edits (review M6).
 *
 * Recurses only where BOTH sides are plain objects, so every emitted path's
 * parent chain already exists in the document — jsonc-parser never has to
 * create intermediate containers. Untouched leaves produce no edit at all,
 * which is what keeps the comments attached to them alive.
 */
function diffLeafEdits(
  basePath: string[],
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  out: LeafEdit[],
): void {
  for (const [k, nextValue] of Object.entries(next)) {
    const currentValue = current[k];
    if (deepEqual(currentValue, nextValue)) {
      continue;
    }
    if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
      diffLeafEdits([...basePath, k], currentValue, nextValue, out);
    } else {
      out.push({ path: [...basePath, k], value: nextValue });
    }
  }
  for (const k of Object.keys(current)) {
    if (!(k in next)) {
      out.push({ path: [...basePath, k], value: undefined });
    }
  }
}

/**
 * Set a single top-level `key` to `value` in opencode.json, preserving all
 * existing comments / formatting — including comments INSIDE the key's value
 * (review M6). Reads the raw text, diffs the current value of `key` against
 * `value`, applies one surgical jsonc-parser edit per changed/added/removed
 * leaf (deep json paths), and writes back atomically (via core writeText).
 *
 * When the current value of `key` (or `value` itself) is not a plain object,
 * there is no interior to preserve: the whole key is replaced in one edit.
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

  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const currentValue = errors.length === 0 && isPlainObject(parsed) ? parsed[key] : undefined;

  let updated: string;
  if (isPlainObject(currentValue) && isPlainObject(value)) {
    const leafEdits: LeafEdit[] = [];
    diffLeafEdits([key], currentValue, value, leafEdits);
    updated = source;
    for (const leafEdit of leafEdits) {
      updated = applyEdits(updated, modify(updated, leafEdit.path, leafEdit.value, MODIFY_OPTIONS));
    }
  } else {
    updated = applyEdits(source, modify(source, [key], value, MODIFY_OPTIONS));
  }

  await writeText(filePath, updated.endsWith('\n') ? updated : updated + '\n');
}
