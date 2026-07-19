/**
 * d2-scanner-degraded.test.ts — Warn-only when no scanner deps available (D2 / ADR-0018).
 *
 * Strategy:
 * - Inject a degraded scanner ({ ok: true, degraded: true }) into scanEntries directly.
 * - Verify that scanEntries does NOT throw and emits a warning.
 * - Verify that a scanner with real findings ({ ok: false }) still throws ScanBlockedError.
 * - scanEntries now materialises the union into a staging mirror before scanning,
 *   so each test runs against a real on-disk checkout fixture (catalog.json +
 *   skills/demo); the injected fake scanners ignore the staging path and return
 *   a fixed verdict, so every locked invariant here is still the SAME verdict
 *   policy — degraded/blocked/force and the anyBlocked-before-anyDegraded order.
 *
 * Scenarios:
 * 1. degraded scanner (no tool available) → scanEntries proceeds + returns warning message.
 * 2. degraded scanner → warning mentions actionable install hint (gitleaks/trivy / rigger doctor).
 * 3. blocking scanner (real findings) + no force → ScanBlockedError thrown (unchanged).
 * 4. blocking scanner + force → proceeds, no ScanBlockedError.
 * 5. clean scanner (tool present, no findings) → no warning, no error.
 * 6. empty entries list → catalog.json is still scanned unconditionally (T3), so
 *    scanEntries is no longer a no-op: degraded/blocking verdicts on catalog.json
 *    still surface, a clean verdict still returns no warnings.
 * 7. mixed degraded+blocked verdict → anyBlocked-before-anyDegraded order guard.
 * 8. partial presence (T2, signal-degraded-partiel): exactly one of gitleaks/
 *    trivy installed. Blocking still wins (zero partial warning) when the
 *    present tool finds something; an all-ok verdict names the absent tool.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ArtifactEntry } from '@agent-rigger/catalog';
import type { Scanner } from '@agent-rigger/core/scan';

import { ScanBlockedError, scanEntries } from '../src/remote-install';

// ---------------------------------------------------------------------------
// Helpers: fake scanner builders
// ---------------------------------------------------------------------------

function degradedScanner(): Scanner {
  return {
    scan: (_source: string) => Promise.resolve({ ok: true, degraded: true }),
  };
}

function blockingScanner(findings: string[]): Scanner {
  return {
    scan: (_source: string) => Promise.resolve({ ok: false, findings }),
  };
}

function cleanScanner(): Scanner {
  return {
    scan: (_source: string) => Promise.resolve({ ok: true }),
  };
}

/**
 * All-ok verdict with exactly one tool missing (composite.ts partial-presence
 * case, T1). The other tool ran and found nothing.
 */
function partialOkScanner(missingTools: ('gitleaks' | 'trivy')[]): Scanner {
  return {
    scan: (_source: string) => Promise.resolve({ ok: true, missingTools }),
  };
}

/**
 * Blocking verdict (real findings from the one present tool) that ALSO carries
 * missingTools — the real composite scanner sets missingTools on both the ok
 * and !ok branches of the partial-presence case (composite.ts). Used to lock
 * "blocage prime partiel": the present tool's finding blocks the install, and
 * no partial-scan warning is emitted alongside the block.
 */
function partialBlockingScanner(
  findings: string[],
  missingTools: ('gitleaks' | 'trivy')[],
): Scanner {
  return {
    scan: (_source: string) => Promise.resolve({ ok: false, findings, missingTools }),
  };
}

/**
 * Scanner that returns a verdict that is simultaneously blocking (ok: false, findings)
 * and degraded (degraded: true).
 *
 * The real composite scanner never produces this mix, but this helper exists to lock the
 * evaluation order inside scanEntries: anyBlocked must be checked BEFORE anyDegraded
 * (defense-in-depth). If the order were inverted, this scanner would be treated as
 * warn-only instead of fail-closed, which would be a security regression.
 */
function degradedBlockingScanner(findings: string[]): Scanner {
  return {
    scan: (_source: string) => Promise.resolve({ ok: false, findings, degraded: true }),
  };
}

// ---------------------------------------------------------------------------
// Minimal skill entry stub — scanPathFor returns a non-null path for skills
// ---------------------------------------------------------------------------

const SKILL_ENTRY: ArtifactEntry = {
  kind: 'artifact',
  id: 'skill:demo',
  nature: 'skill',
  targets: ['claude'],
  scopes: ['user', 'project'],
};

// Real on-disk checkout: materializeUnion (inside scanEntries) mirrors
// catalog.json + skills/demo into a staging dir. The fake scanners below ignore
// that dir, so the verdict — and every invariant asserted here — is unchanged.
let BASE_DIR: string;

beforeEach(async () => {
  BASE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'rigger-d2-checkout-'));
  await fs.writeFile(
    path.join(BASE_DIR, 'catalog.json'),
    '{"meta":{"name":"d2"},"entries":[]}\n',
    'utf8',
  );
  await fs.mkdir(path.join(BASE_DIR, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(path.join(BASE_DIR, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(BASE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Scenario 1 & 2: degraded scanner → proceeds + warning
// ---------------------------------------------------------------------------

describe('scanEntries — degraded scanner (no tool available)', () => {
  it('does not throw when scanner is degraded', async () => {
    await expect(
      scanEntries({
        entries: [SKILL_ENTRY],
        baseDir: BASE_DIR,
        scanner: degradedScanner(),
        force: false,
      }),
    ).resolves.toBeDefined();
  });

  it('returns a non-empty warnings array when scanner is degraded', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('warning mentions that content was not scanned', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    const combined = result.warnings.join(' ');
    expect(combined.toLowerCase()).toMatch(/non scanné|not scanned|unscanned/i);
  });

  it('warning mentions how to fix (gitleaks or trivy)', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    const combined = result.warnings.join(' ');
    expect(combined).toMatch(/gitleaks|trivy/i);
  });

  it('warning mentions rigger doctor', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    const combined = result.warnings.join(' ');
    expect(combined).toMatch(/rigger doctor/i);
  });

  it('does not need --force to proceed when degraded', async () => {
    // force: false should not matter — degraded is warn-only
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: blocking scanner (real findings), no force → ScanBlockedError (unchanged)
// ---------------------------------------------------------------------------

describe('scanEntries — blocking scanner, no force', () => {
  it('throws ScanBlockedError when scanner returns ok: false', async () => {
    await expect(
      scanEntries({
        entries: [SKILL_ENTRY],
        baseDir: BASE_DIR,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: blocking scanner + force → proceeds
// ---------------------------------------------------------------------------

describe('scanEntries — blocking scanner, with force', () => {
  it('does not throw when force is true', async () => {
    await expect(
      scanEntries({
        entries: [SKILL_ENTRY],
        baseDir: BASE_DIR,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
        force: true,
      }),
    ).resolves.toBeDefined();
  });

  it('returns security scan warning in output when forced', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (config.env)']),
      force: true,
    });

    expect(result.warnings.join(' ')).toContain('[warning]');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: clean scanner → no warning, no error
// ---------------------------------------------------------------------------

describe('scanEntries — clean scanner (tool present, no findings)', () => {
  it('returns empty warnings when scanner is clean', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: cleanScanner(),
      force: false,
    });

    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: empty entries — catalog.json is still scanned unconditionally
// (T3): a selection with no scannable natures (e.g. guardrail-only before this
// change, or mcp-only) must still verify scanner presence and surface findings.
// ---------------------------------------------------------------------------

describe('scanEntries — empty entries list (catalog.json still scanned)', () => {
  it('still emits a degraded warning when entries is empty (catalog.json scan runs)', async () => {
    const result = await scanEntries({
      entries: [],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('still throws ScanBlockedError when entries is empty and the scanner blocks catalog.json', async () => {
    await expect(
      scanEntries({
        entries: [],
        baseDir: BASE_DIR,
        scanner: blockingScanner(['[gitleaks] aws-access-key: AWS key (catalog.json)']),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('returns empty warnings when entries is empty and the scanner is clean', async () => {
    const result = await scanEntries({
      entries: [],
      baseDir: BASE_DIR,
      scanner: cleanScanner(),
      force: false,
    });

    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: mixed verdict — both blocking (ok: false) AND degraded (degraded: true)
//
// Locks the anyBlocked-before-anyDegraded evaluation order in scanEntries.
// The real composite scanner never emits this combination, but a custom scanner
// injected via dependency injection could. In that case, fail-closed must win:
// anyBlocked is checked first, so the degraded flag does not bypass the block.
//
// Regression guard: if the order were inverted (anyDegraded checked first),
// these tests would fail because scanEntries would treat the verdict as warn-only
// and not throw ScanBlockedError.
// ---------------------------------------------------------------------------

describe('scanEntries — mixed degraded+blocked verdict (order guard)', () => {
  it('throws ScanBlockedError when verdict is both ok: false and degraded: true (no force)', async () => {
    await expect(
      scanEntries({
        entries: [SKILL_ENTRY],
        baseDir: BASE_DIR,
        scanner: degradedBlockingScanner(['[custom] suspicious-pattern: secret detected']),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('does not treat a blocking+degraded verdict as warn-only when force is false', async () => {
    const result = scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedBlockingScanner(['[custom] suspicious-pattern: secret detected']),
      force: false,
    });

    // Must reject — not resolve with warnings
    await expect(result).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('proceeds with a force warning when force is true, even if verdict is also degraded', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedBlockingScanner(['[custom] suspicious-pattern: secret detected']),
      force: true,
    });

    // anyBlocked-first: the force path emits a [warning] security scan message,
    // NOT the degraded "non scanné" message.
    expect(result.warnings.join(' ')).toContain('[warning]');
    expect(result.warnings.join(' ')).not.toMatch(/non scanné|not scanned|unscanned/i);
  });
});

// ---------------------------------------------------------------------------
// R5 / R6 — the warning literals pinned BYTE-FOR-BYTE. The other tests match
// them by loose regex; these lock the exact prod strings (remote-install.ts) so
// a typo in a user-facing warning turns the suite red.
// ---------------------------------------------------------------------------

describe('R5: degraded warning is byte-exact', () => {
  it('R5: emits exactly the "content not scanned" literal (single warning)', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: degradedScanner(),
      force: false,
    });

    expect(result.warnings).toEqual([
      '[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`',
    ]);
  });
});

describe('R6: force warning is byte-exact (findings joined by "; ")', () => {
  it('R6: emits exactly the "security scan findings" literal with the "; "-joined findings', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: blockingScanner(['[gitleaks] aws-access-key: token', '[trivy] CVE-2024-0001: vuln']),
      force: true,
    });

    expect(result.warnings).toEqual([
      '[warning] security scan findings (installed anyway via --force): '
      + '[gitleaks] aws-access-key: token; [trivy] CVE-2024-0001: vuln',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8a: partial presence + blocked — "blocage prime partiel" (T2).
//
// Only one tool is installed AND it finds something: the install still
// blocks (fail-closed, unchanged), and — the point of this scenario — the
// block emits ZERO partial-scan warning. Mirrors scenario 7's shape (no
// force → throws; force → the force warning only, never the partial one).
// ---------------------------------------------------------------------------

describe('scanEntries — partial presence + blocked (blocking wins over partial)', () => {
  it('throws ScanBlockedError when the present tool blocks, even though the other is missing', async () => {
    await expect(
      scanEntries({
        entries: [SKILL_ENTRY],
        baseDir: BASE_DIR,
        scanner: partialBlockingScanner(
          ['[gitleaks] aws-access-key: AWS key (config.env)'],
          ['trivy'],
        ),
        force: false,
      }),
    ).rejects.toBeInstanceOf(ScanBlockedError);
  });

  it('emits ONLY the force warning, never a partial-scan warning, when forced through a partial-presence block', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: partialBlockingScanner(
        ['[gitleaks] aws-access-key: AWS key (config.env)'],
        ['trivy'],
      ),
      force: true,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join(' ')).toContain('[warning] security scan findings');
    expect(result.warnings.join(' ')).not.toMatch(/partially scanned/i);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8b: partial presence + all-ok — names the absent tool (T2).
//
// Neither anyBlocked nor anyDegraded fires (the present tool ran clean), so
// scanEntries reaches the new branch driven by verdict.missingTools. The
// warning transits through the SAME `warnings` array as every other case
// here — these tests read only `result.warnings`, no other surface.
// ---------------------------------------------------------------------------

describe('scanEntries — partial presence + all-ok (names the absent tool)', () => {
  it('warns naming trivy as absent when only gitleaks ran clean', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: partialOkScanner(['trivy']),
      force: false,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/trivy/i);
    expect(result.warnings.join(' ')).not.toMatch(/security scan findings|content not scanned/i);
  });

  it('warns naming gitleaks as absent when only trivy ran clean (symmetric)', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: partialOkScanner(['gitleaks']),
      force: false,
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/gitleaks/i);
    expect(result.warnings.join(' ')).not.toMatch(/security scan findings|content not scanned/i);
  });

  it('does not throw and does not need --force (all-ok, warn-only like degraded)', async () => {
    await expect(
      scanEntries({
        entries: [SKILL_ENTRY],
        baseDir: BASE_DIR,
        scanner: partialOkScanner(['trivy']),
        force: false,
      }),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// R7 — the partial-presence warning literal, ratified at the gate, pinned
// BYTE-FOR-BYTE (both directions).
// ---------------------------------------------------------------------------

describe('R7: partial-presence warning is byte-exact', () => {
  it('R7a: emits exactly the trivy-missing literal', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: partialOkScanner(['trivy']),
      force: false,
    });

    expect(result.warnings).toEqual([
      '[warning] content partially scanned — trivy not installed (gitleaks ran); '
      + 'install trivy then re-run for a full scan; see `rigger doctor`',
    ]);
  });

  it('R7b: emits exactly the gitleaks-missing literal (symmetric)', async () => {
    const result = await scanEntries({
      entries: [SKILL_ENTRY],
      baseDir: BASE_DIR,
      scanner: partialOkScanner(['gitleaks']),
      force: false,
    });

    expect(result.warnings).toEqual([
      '[warning] content partially scanned — gitleaks not installed (trivy ran); '
      + 'install gitleaks then re-run for a full scan; see `rigger doctor`',
    ]);
  });
});
