/**
 * Shared fixture: pin `process.stdout.isTTY` / `process.stdin.isTTY` for the
 * duration of a test file.
 *
 * bun test runs all ~148 files in a single process. Several suites need
 * `process.stdout.isTTY` pinned to a fixed value (usually `false`) so the
 * interactive-picker branch of the CLI is never accidentally taken when the
 * suite happens to run in a real terminal. Historically each file redefined
 * `process.stdout.isTTY` locally and its `afterEach` just forced the value
 * back to `false` instead of restoring the pre-suite descriptor — so the
 * *original* descriptor was never captured, and a suite that ran in an
 * environment where `isTTY` was, say, non-configurable or absent would leak
 * a stale redefinition into whichever file bun scheduled next.
 *
 * `process.stdin.isTTY` has its own pin/set pair: R4's fail-closed gate keys
 * off stdin (the stream clack's `Prompt` actually blocks on), and a suite
 * proving that must pin the two streams independently rather than assuming
 * they move together.
 */

import { afterEach, beforeEach } from 'bun:test';

/**
 * Raw setter — no capture, no restore. Kept for call sites that need to
 * override the pin mid-suite on top of a file-level `pinStdoutIsTTY` (e.g. a
 * single describe block that simulates a real TTY to prove a `--yes` flag
 * still primes over the interactive picker branch). The file-level
 * `pinStdoutIsTTY` afterEach still runs after such a test and restores the
 * original descriptor, so this override never leaks across tests.
 */
export function setStdoutIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

/**
 * Registers `beforeEach`/`afterEach` hooks that pin `process.stdout.isTTY` to
 * `value` for the duration of each test and restore the original descriptor
 * afterwards.
 *
 * The original descriptor is captured inside `beforeEach` — NOT at module
 * load time. Capturing at load time would fossilize whatever state a
 * previously-run test file (bun shares one process across all files) left
 * behind as this file's "original", instead of this file's own pre-test
 * baseline; restoring to a polluted baseline would just move the leak rather
 * than fix it.
 */
export function pinStdoutIsTTY(value: boolean | undefined = false): void {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    setStdoutIsTTY(value);
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(process.stdout, 'isTTY', original);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });
}

/**
 * Raw setter for `process.stdin.isTTY` — mirrors `setStdoutIsTTY`.
 *
 * R4's fail-closed gate (`assertConfirmableOrYes`, `confirmToolChecks`) reads
 * `process.stdin.isTTY`, not stdout: the hang it prevents is clack's `Prompt`
 * blocking on stdin keypresses, a property of the input stream, not the
 * output stream. A suite proving the gate is bypassable by stream
 * desalignment (stdout TTY, stdin not) needs to pin the two independently.
 */
export function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
}

/**
 * Registers `beforeEach`/`afterEach` hooks that pin `process.stdin.isTTY` to
 * `value` for the duration of each test and restore the original descriptor
 * afterwards. See `pinStdoutIsTTY` for the rationale on capturing the
 * original descriptor inside `beforeEach` rather than at module load time.
 */
export function pinStdinIsTTY(value: boolean | undefined = false): void {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    setStdinIsTTY(value);
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(process.stdin, 'isTTY', original);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
}
