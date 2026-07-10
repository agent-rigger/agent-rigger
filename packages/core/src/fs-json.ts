/**
 * Filesystem JSON helpers for agent-rigger.
 *
 * Design invariants:
 * - Never call process.exit() — callers (CLI) map typed errors to exit codes.
 * - Missing file → safe defaults (empty object / empty string), not an error.
 * - Invalid JSON → throws InvalidJsonError (actionable, carries file path).
 * - writeJson always creates parent directories and appends a trailing newline.
 * - All writes are atomic (tmp + rename) so a crash/concurrent reader never
 *   observes a half-written file.
 *
 * Bun-native: uses Bun.file() for reads and Bun.write() for writes.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Thrown by readJson when a file exists but contains malformed JSON.
 *
 * The CLI maps this error to exit code 2.
 * Never call process.exit() here — keep the core testable and runtime-agnostic.
 */
export class InvalidJsonError extends Error {
  /** Absolute path of the file that failed to parse. */
  readonly path: string;

  constructor(filePath: string, cause?: unknown) {
    const message = `Invalid JSON in "${filePath}"`
      + (cause instanceof Error ? `: ${cause.message}` : '');
    super(message);
    this.name = 'InvalidJsonError';
    this.path = filePath;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ---------------------------------------------------------------------------
// readJson
// ---------------------------------------------------------------------------

/**
 * Read and parse a JSON file.
 *
 * - File absent  → returns `{}` (a fresh install has no settings.json yet).
 * - File present + valid JSON  → returns the parsed object.
 * - File present + invalid JSON  → throws `InvalidJsonError`.
 *
 * The file is never modified.
 */
export async function readJson(filePath: string): Promise<Record<string, unknown>> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return {};
  }

  try {
    const parsed: unknown = await file.json();
    // Bun.file.json() returns unknown; we trust it's an object for valid JSON
    // objects. If it parsed but is not an object we still return it wrapped —
    // callers (engine) expect Record<string, unknown> for settings files.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Valid JSON but not an object (array, primitive) — treat as empty map so
    // callers can safely use object spread without type errors.
    return {};
  } catch (cause) {
    throw new InvalidJsonError(filePath, cause);
  }
}

// ---------------------------------------------------------------------------
// readText
// ---------------------------------------------------------------------------

/**
 * Read a file as a UTF-8 string.
 *
 * - File absent  → returns `''`.
 * - File present → returns full content.
 */
export async function readText(filePath: string): Promise<string> {
  const file = Bun.file(filePath);
  const exists = await file.exists();

  if (!exists) {
    return '';
  }

  return file.text();
}

// ---------------------------------------------------------------------------
// writeJson
// ---------------------------------------------------------------------------

/**
 * Write `content` to `filePath` atomically: stage it in a temp file in the SAME
 * directory, then rename(2) over the target (atomic on the same filesystem).
 * A crash or concurrent reader therefore never sees a partially written file —
 * the path either holds the old content or the new one. Parent directories are
 * created if absent; the temp file is cleaned up if the rename never happens.
 */
async function atomicStage(
  filePath: string,
  data: string | ArrayBuffer | Uint8Array,
): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmp = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  try {
    await Bun.write(tmp, data);
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await atomicStage(filePath, content);
}

/**
 * Write raw `bytes` to `filePath` atomically (tmp + rename in the same
 * directory). Byte-exact: the bytes are staged and renamed verbatim, with NO
 * UTF-8 decode/encode round-trip — so binary or non-UTF-8 content survives
 * intact. A crash or concurrent reader never observes a partial file under the
 * final name; the temp file is cleaned up if the rename never happens.
 *
 * Shared staging primitive behind writeJson/writeText (text) and the backup
 * recovery paths (bytes) — see backup.ts (R6, lot3-robustesse-moteur).
 */
export async function atomicWriteBytes(
  filePath: string,
  bytes: ArrayBuffer | Uint8Array,
): Promise<void> {
  await atomicStage(filePath, bytes);
}

/**
 * Serialize `data` to JSON (2-space indent, trailing newline) and write it to
 * `filePath` atomically. Parent directories are created if absent.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// writeText
// ---------------------------------------------------------------------------

/**
 * Write a UTF-8 string to `filePath` atomically. Parent directories are created
 * if absent. Symmetric with readText: writeText then readText returns the
 * original content.
 */
export async function writeText(filePath: string, content: string): Promise<void> {
  await atomicWrite(filePath, content);
}
