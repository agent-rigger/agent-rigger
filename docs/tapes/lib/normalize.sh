#!/usr/bin/env bash
# agent-rigger — normalise a recorded session for comparison (design D4).
#
# Reads a VHS `.txt` capture on stdin, writes the normalised text on stdout. This
# is the SINGLE definition of the volatile fields of a session: both the R6
# verdict (docs/specs/vhs-recordings/verifications/) and the freshness workflow
# (.github/workflows/recordings-freshness.yml) pipe through it, so "real
# divergence" has exactly one meaning. A field left un-normalised produces a false
# red verdict; an over-eager rule hides a real drift — the test suite
# (normalize.test.ts) pins both failure modes.
#
# Two classes are erased:
#
#   1. Volatile VALUES — mktemp paths, catalog checkout tmpdir, resolved binary
#      paths (doctor phase 1), backup timestamps, 40-char git shas. Semver tags
#      (vX.Y.Z) are preserved: a version change is real drift.
#
#   2. Screen GEOMETRY — a VHS `.txt` is a stack of full-screen snapshots, and the
#      geometry is not stable across machines (found empirically: the Linux CI
#      runner emits a few extra blank rows per snapshot, pads rules and the prompt
#      with trailing spaces, and the box-rule width follows the resolved column
#      count). None of that is session content, so:
#        - trailing whitespace is stripped from every line;
#        - runs of the box-drawing rule ─ (U+2500, >=4) collapse to <RULE> — the
#          count is terminal width, not content;
#        - runs of blank lines collapse to one (`cat -s`) — snapshot padding, not
#          content. Collapse (not delete) keeps a single separator so section
#          breaks stay legible; a real double-blank in output would be flattened,
#          but CLI output never relies on blank-line COUNT to carry meaning.
#
#   3. Recorder ARTEFACTS — a line that is exactly a bare ">" (PS2 echo of a
#      dropped keystroke, machine-dependent) is removed.
#
# Deliberately NOT normalised: messages, command order, exit codes, artefact names
# and content wraps stay verbatim — that is the drift a recording exists to expose.
#
# Comparison semantics note: a VHS `.txt` stacks one full-screen snapshot per
# redraw, and the redraw COUNT and SAMPLING INSTANTS are machine-dependent (a CI
# runner can capture transient UI frames the recording machine never saw, or
# fewer duplicate snapshots). Byte-diffing two normalised captures is therefore
# unstable by construction; the freshness workflow compares DIRECTIONALLY on the
# unique-line set — every golden line must still be produced, extra CI lines are
# sampling noise. Trade-off (documented in ADR-0026): pure additions (a new
# catalog entry) are not flagged; changed or vanished lines are.
#
# perl (present on macOS and on the Linux CI runner) is used for \b and lazy
# quantifiers that BSD/GNU sed handle inconsistently; it runs in byte mode, so the
# rule is matched by ─'s UTF-8 bytes (E2 94 80). Substitutions are ordered: rstrip
# and tmp-path tokens run before the generic "(abs path)" rule so already tokenised
# values (starting with '<') are never re-matched. Blank runs collapse last.
perl -ne '
  # Geometry — trailing whitespace and terminal-width rules.
  s/[ \t]+$//;
  s/(?:\xe2\x94\x80){4,}/<RULE>/g;

  # Recorder artefact — a line that is EXACTLY a bare ">" is the PS2 continuation
  # prompt echoed when the recorder drops a keystroke (TypingSpeed under ttyd);
  # it appears or not depending on the machine, never carries session content,
  # and "> anything" (real output) is untouched. Dropped entirely.
  next if /^>$/;

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

  print;
' | cat -s
