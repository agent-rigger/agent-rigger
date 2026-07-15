/**
 * Tests for docs/tapes/lib/setup.sh — the shared hidden-setup sourced by every
 * `.tape` of this change (design D5, isolation R5).
 *
 * The load-bearing invariant is R5 scenario 2, and it has two halves:
 *   - ORDER: RIGGER_HOME is set (and exported) before any `rigger` command;
 *   - FAIL-CLOSED: a failed `mktemp` never leaves RIGGER_HOME="", because
 *     resolveHome("") falls back to the real $HOME (packages/core/src/paths.ts:94)
 *     — an invisible (hidden setup), irreversible write into ~/.claude.
 * The shim adds a last-gate guard so even a tampered RIGGER_HOME cannot escape
 * onto the real home. All four are pinned below (last one behaviourally).
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SETUP_PATH = join(import.meta.dir, 'setup.sh');
const setup = readFileSync(SETUP_PATH, 'utf8');

test('setup.sh: RIGGER_HOME comes from mktemp /tmp/rigger-rec, guarded before export (SC2155)', () => {
  // The literal /tmp/rigger-rec template is load-bearing — normalize.sh rule 1
  // matches it. mktemp's exit code must not be masked: assign, verify non-empty
  // AND a directory, only then export. Never a bare `export X="$(mktemp …)"`.
  expect(setup).toMatch(/RIGGER_HOME="\$\(mktemp -d \/tmp\/rigger-rec\.XXXXXX\)"\s*\|\|\s*exit 1/);
  expect(setup).toMatch(/\[ -n "\$RIGGER_HOME" \] && \[ -d "\$RIGGER_HOME" \] \|\| exit 1/);
  expect(setup).toMatch(/^\s*export RIGGER_HOME\s*$/m);
  // Guard against a regression to the masked form.
  expect(setup).not.toMatch(/export RIGGER_HOME="\$\(mktemp/);
});

test('setup.sh: no rigger invocation precedes the RIGGER_HOME export (R5 S2 order)', () => {
  const lines = setup.split('\n');
  const exportIdx = lines.findIndex((l) => /^\s*export RIGGER_HOME\b/.test(l));
  expect(exportIdx).toBeGreaterThanOrEqual(0);

  // A rigger *invocation* calls the shim (`rigger <args>`); the shim definition
  // (`rigger()`) and comments do not count. None may appear before the export.
  const invocationBeforeExport = lines.slice(0, exportIdx).some((raw) => {
    const l = raw.trim();
    if (l === '' || l.startsWith('#')) return false;
    return /(?:^|[;&|]\s*|&&\s*|\|\|\s*)rigger\s+[^(]/.test(l);
  });
  expect(invocationBeforeExport).toBe(false);
});

test('setup.sh: exports a deterministic PS1 after the RIGGER_HOME guard (no cwd leak in goldens)', () => {
  // Without a fixed prompt every filmed frame carries the operator's default PS1
  // (cwd, host, git branch…) and every golden .txt leaks a machine-specific path,
  // producing a spurious per-machine diff in the freshness workflow (D1) and the
  // R6 verdict. The prompt must be the bare `$ `, set after the export so it never
  // precedes the isolation guard.
  expect(setup).toMatch(/^\s*export PS1='\$ '\s*$/m);
  const lines = setup.split('\n');
  const homeIdx = lines.findIndex((l) => /^\s*export RIGGER_HOME\b/.test(l));
  const ps1Idx = lines.findIndex((l) => /^\s*export PS1=/.test(l));
  expect(homeIdx).toBeGreaterThanOrEqual(0);
  expect(ps1Idx).toBeGreaterThan(homeIdx);
});

test('setup.sh: defines a rigger shim and a teardown trap on the temp home', () => {
  expect(setup).toMatch(/rigger\s*\(\s*\)\s*\{/);
  // Teardown removes the throwaway home so an interrupted take leaves only /tmp
  // (R5 scenarios 1 & 4).
  expect(setup).toMatch(/trap .*rm -rf .*RIGGER_HOME.* (EXIT|INT|TERM)/);
});

test('setup.sh: the rigger shim refuses to run when RIGGER_HOME is empty (fail-closed, R5)', async () => {
  // Source the real setup, then invoke the shim in a subshell with a broken
  // RIGGER_HOME. The guard must refuse (non-zero, stderr message) BEFORE reaching
  // the binary — so no filmed command can ever fall back to the real home. The
  // genuine throwaway home is removed explicitly (belt-and-suspenders vs the trap).
  const harness = [
    `source '${SETUP_PATH}'`,
    'real_home="$RIGGER_HOME"',
    'err=$( RIGGER_HOME=""; rigger doctor 2>&1 1>/dev/null ); rc=$?',
    'rm -rf "$real_home"',
    'printf "RC=%s\\n" "$rc"',
    'printf "ERR=%s\\n" "$err"',
  ].join('\n');

  const proc = Bun.spawn(['bash', '-c', harness], { stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  expect(code).toBe(0); // the harness itself runs cleanly
  expect(out).toMatch(/RC=[1-9]/); // the shim returned non-zero
  expect(out).toMatch(/refusing to run/); // and said why on stderr
});
