/**
 * Smoke tests for gitleaks.ts's defaultScanRunner and defaultWhich — the real
 * Bun.spawn / Bun.which implementations. gitleaks.test.ts (same directory)
 * injects a fake ScanRunner/WhichFn for every case, so these two production
 * defaults have never been exercised by a real spawn / real PATH lookup
 * before this file (M16 residual, lot7, gitleaks.ts:39/64).
 */

import { describe, expect, it } from 'bun:test';

import { defaultScanRunner, defaultWhich } from './gitleaks';

// ---------------------------------------------------------------------------
// defaultScanRunner — real spawn
// ---------------------------------------------------------------------------

describe('defaultScanRunner — real spawn', () => {
  it('returns the exact exit code of the spawned command', async () => {
    const result = await defaultScanRunner('sh', ['-c', 'exit 4']);
    expect(result.exitCode).toBe(4);
  });

  it('captures stdout', async () => {
    const result = await defaultScanRunner('sh', ['-c', 'printf scan-stdout']);
    expect(result.stdout).toBe('scan-stdout');
  });

  it('captures stderr', async () => {
    const result = await defaultScanRunner('sh', ['-c', 'printf scan-stderr 1>&2']);
    expect(result.stderr).toBe('scan-stderr');
  });
});

// ---------------------------------------------------------------------------
// defaultWhich — real PATH lookup (Bun.which, no shell spawn)
// ---------------------------------------------------------------------------

describe('defaultWhich — real PATH lookup', () => {
  it('resolves "sh" to a non-null path', () => {
    expect(defaultWhich('sh')).not.toBeNull();
  });

  it('returns null for a command that does not exist on PATH', () => {
    expect(defaultWhich('commande-inexistante-xyz-123')).toBeNull();
  });
});
