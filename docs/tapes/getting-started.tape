# agent-rigger — getting-started recording (VHS tape) — flux R1.
#
# The companion film for start/getting-started.md: the whole tutorial run once,
# end to end, against the PUBLIC example catalog the page teaches — read the
# environment, register the catalog, see what it offers, install a small pack,
# audit the result — all in a disposable sandbox.
#
# Resurrected 2026-07-18 (retournage-tapes-gif change). The original R1 tape was
# abandoned: it filmed the real jr team rig, whose 24-artifact install throttled
# VHS's ttyd backend and never reached the Result (output-volume knee, vhs#130).
# Two things unblock it: this tape films the LIGHT example pack (2 artifacts, the
# flow the page actually teaches), and the install renders through the compact
# `--summary` plan (plan-compact-summary change) — the per-target Wait anchor of
# the old tape (`/rigger-rec…workflow-analysis/`) no longer exists in summary
# mode, so the take gates on the summary Result line instead.
#
# Renders (raw .txt untracked — see docs/tapes/.gitignore):
#   site/src/assets/recordings/getting-started.gif   the published pixels embedded
#                                                     in the getting-started page
#   docs/tapes/.out/getting-started.txt              raw session text
# The tracked contract artefact is the normalised golden (see Regeneration):
#   docs/tapes/golden/getting-started.txt            raw .txt piped through normalize.sh
#
# Regeneration (run from the agent-rigger repo root — Output paths are relative,
# vhs 0.11.0 rejects absolute Output):
#   bun install && bun run build                   # packages/cli/dist/agent-rigger
#   mkdir -p docs/tapes/.out
#   vhs docs/tapes/getting-started.tape             # -> gif + .out/getting-started.txt
#   docs/tapes/lib/normalize.sh \
#     < docs/tapes/.out/getting-started.txt \
#     > docs/tapes/golden/getting-started.txt       # refresh the golden
#
# Prerequisites: vhs 0.11.0, ttyd, ffmpeg, and git + glab + gitleaks + trivy on
# PATH (doctor phase 1 lists all four; all present => a clean all-checkmark "full
# scan"). Network: the visible `catalog add` clones the public example catalog from
# github.com, and `check` version-resolves it (the example tag is pinned in the
# golden — an example tag bump is legitimate drift). Runs entirely under a throwaway
# $RIGGER_HOME (setup.sh) — the operator's real ~/.claude is never read or written (R5).

Output site/src/assets/recordings/getting-started.gif
Output docs/tapes/.out/getting-started.txt

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
# Cold-runner margin: the visible `catalog add` clones the example catalog over the
# network and `check` re-resolves it, both slower on a fresh CI runner. The default
# WaitTimeout (15s) can lapse before the first anchor; 60s covers the clone without
# hanging a healthy run.
Set WaitTimeout 60s

# --- hidden setup: throwaway home + `rigger` shim ------------------------------
# setup.sh (T1) exports a throwaway RIGGER_HOME (/tmp/rigger-rec.*, normalize rule
# 1), a `rigger` shim → packages/cli/dist/agent-rigger, a deterministic PS1='$ '
# (no cwd leak), and an EXIT/INT/TERM teardown trap. Sourced, so RIGGER_HOME
# precedes every rigger call. Unlike demo.tape, the catalog is NOT plugged in here:
# `catalog add` is Step 2 of the tutorial and must be filmed.
Hide
Sleep 1s
Type 'source docs/tapes/lib/setup.sh'
Enter
Sleep 800ms
# Anti-race guard (vhs#130): drop the hidden setup lines, then hold the reveal until
# ttyd has flushed the `clear` redraw. Without the Sleep the hidden setup bleeds
# into the first visible frame (leak is load- and machine-dependent; probed 60
# hidden lines → 9 leaks, 0 with this clear → Sleep 2s → Show idiom).
Type 'clear'
Enter
Sleep 2s
Show
Sleep 800ms

# --- Step 1 — read the environment: deps, scan mode, empty installed state -----
Type "rigger doctor"
Sleep 500ms
Enter
Wait+Screen /no findings/
Sleep 2s

# --- Step 2 — register the public example catalog (a git URL recorded in config).
# `| cat`: in a TTY, `catalog add` follows the persisted source with an interactive
# "propose to install" picker (cmd-catalog.ts, gated on process.stdout.isTTY) that
# would open here and swallow every command typed after it. Piping makes stdout a
# non-TTY, so the proposal is skipped while the "added" line still prints — matching
# the page's Step 2, which shows only the confirmation.
Type "rigger catalog add example https://github.com/agent-rigger/agent-rigger-catalog-example.git | cat"
Sleep 500ms
Enter
Wait+Screen /"example" added/
Sleep 2s

# --- Step 3 — see what the catalog offers (7 entries fit the frame; no head) ---
Type "rigger ls"
Sleep 500ms
Enter
Wait+Screen /Catalog \(/
Sleep 2500ms

# --- Step 4 — install the demo pack: a compact PLAN first, then RESULT. The pack
#     bundles the hello-rigger skill and the demo sub-agent. `--summary` prints one
#     line per target plus a Σ tally (the flag the retournage standardises on).
#     `--assistant claude` is load-bearing for determinism (same rationale as
#     demo.tape): on a throwaway RIGGER_HOME the assistant is unresolved, so under a
#     TTY resolveAssistant pops a picker where >1 assistant is detected — it fires on
#     this macOS box (claude+opencode) and hangs the take, but not on the CI Linux
#     runner (none detected → 'claude' fallback). The flag pins claude on BOTH, for
#     one byte-identical golden.
Type "rigger install example/pack:demo --yes --summary --assistant claude"
Sleep 500ms
Enter
# Gate on the summary Result line (the per-target install blocks are gone in
# --summary, so `Applied N file(s)` is the stable anchor).
Wait+Screen /Applied 2 file/
Sleep 2s

# --- Step 5 — audit: zero drift ------------------------------------------------
Type "rigger check"
Sleep 500ms
Enter
Wait+Screen /up-to-date/
# 30s reading hold: the GIF lingers on the final state before looping.
Sleep 30s

# --- hidden teardown (setup.sh EXIT/INT/TERM trap also removes $RIGGER_HOME) ----
# No final Show: the Hide/Show race (vhs#130) runs in reverse at teardown — a Show
# after `rm -rf` can capture that command in the LAST GIF frame. Leaving capture
# hidden ends the film on the clean `check` result; the EXIT trap cleans up.
Hide
Type 'rm -rf "$RIGGER_HOME"'
Enter
