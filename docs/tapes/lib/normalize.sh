#!/usr/bin/env bash
# agent-rigger — normalise a recorded session for comparison (design D4).
#
# Reads a VHS `.txt` capture on stdin, writes the normalised text on stdout. This
# is the SINGLE definition of the volatile fields of a session: both the R6
# verdict (docs/specs/vhs-recordings/verifications/) and the T6 freshness
# workflow (.github/workflows/recordings-freshness.yml) pipe through it, so
# "real divergence" has exactly one meaning. A field left un-normalised produces
# a false red verdict; an over-eager rule hides a real drift — the test suite
# (normalize.test.ts) pins both failure modes.
#
# Deliberately NOT normalised: messages, command order, exit codes and artefact
# names stay verbatim — that is the drift a recording exists to expose.
#
# perl (present on macOS and on the Linux CI runner) is used for \b and lazy
# quantifiers that BSD/GNU sed handle inconsistently. Substitutions are ordered:
# tmp-path tokens are applied before the generic "(abs path)" rule so already
# tokenised values (starting with '<') are never re-matched.
exec perl -pe '
  # 1. Throwaway RIGGER_HOME from setup.sh: /tmp/rigger-rec.XXXXXX (macOS may
  #    surface it realpath-ed under /private).
  s{(?:/private)?/tmp/rigger-rec\.[A-Za-z0-9]+}{<RIGGER_HOME>}g;

  # 2. Catalog checkout under os.tmpdir() (mkdtemp prefix agent-rigger-catalog-,
  #    remote.ts): /var/folders/.../T/... on macOS, /tmp/... on Linux CI. The
  #    catalog NAME (jr-agent-rigger-catalog) has no tmp prefix and is untouched.
  s{(?:/private)?/var/folders/\S+?/agent-rigger-catalog-[A-Za-z0-9]+}{<CATALOG_TMP>}g;
  s{/tmp/agent-rigger-catalog-[A-Za-z0-9]+}{<CATALOG_TMP>}g;

  # 3. Timestamped backup names: <path>.bak-<ISO>-<uuid8> (backup.ts). The <path>
  #    prefix is kept; only the volatile timestamp+token is erased.
  s{\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}}{.bak-<TIMESTAMP>}g;

  # 4. Absolute binary paths resolved by doctor phase 1: "✓ git (/opt/.../git)".
  #    The dependency name is kept, the machine-specific path erased.
  s{\(/[^)]*\)}{(<path>)}g;

  # 5. Full 40-char git shas. Semver tags (vX.Y.Z) are NOT hex-40, so a version
  #    change stays visible as real drift.
  s{\b[0-9a-f]{40}\b}{<SHA>}g;
'
