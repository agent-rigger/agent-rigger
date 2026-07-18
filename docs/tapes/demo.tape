# agent-rigger — demo recording (VHS tape) — the README hero.
#
# The one-take tour embedded at README.md:22 (./docs/demo.gif): check deps,
# browse the team rig, install it in a single planned command, verify zero drift.
# The install renders through the compact `--summary` plan (plan-compact-summary
# change): the 24-artifact `jr/pack:secu jr/pack:baseline` install prints ~31
# lines and settles in a few seconds under VHS/ttyd, where the old verbose plan
# (123 raw stdout lines) throttled the ttyd backend and never reached the Result.
#
# Renders (raw .txt untracked — see docs/tapes/.gitignore):
#   docs/demo.gif                 the published pixels embedded in the README
#   docs/tapes/.out/demo.txt      raw session text, distilled into the golden
# The tracked contract artefact is the normalised golden (see Regeneration):
#   docs/tapes/golden/demo.txt    raw .txt piped through lib/normalize.sh
#
# Regeneration (run from the agent-rigger repo root — Output paths are relative,
# vhs 0.11.0 rejects absolute Output):
#   bun install && bun run build                   # packages/cli/dist/agent-rigger
#   mkdir -p docs/tapes/.out
#   vhs docs/tapes/demo.tape                        # -> docs/demo.gif + .out/demo.txt
#   docs/tapes/lib/normalize.sh \
#     < docs/tapes/.out/demo.txt \
#     > docs/tapes/golden/demo.txt                  # refresh the golden
#
# Prerequisites: vhs 0.11.0, ttyd, ffmpeg, and git + glab + gitleaks + trivy on
# PATH (doctor phase 1 lists all four; all present => a clean all-checkmark "full
# scan"). Network: the hidden setup clones the real jr catalog from github.com.
# Runs entirely under a throwaway $RIGGER_HOME (setup.sh) — the operator's real
# ~/.claude is never read or written (R5).

Output docs/demo.gif
Output docs/tapes/.out/demo.txt

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
# Cold-runner margin: the hidden setup clones the real jr catalog and each visible
# install scans 24 artifacts (network + scanners), all slower than local on a fresh
# CI runner. The default WaitTimeout (15s) can lapse before the first anchor; 60s
# covers the clone + scan without hanging a healthy run.
Set WaitTimeout 60s

# --- hidden setup: isolated home + `rigger` shim, team catalog plugged in -------
# setup.sh (T1) exports a throwaway RIGGER_HOME (/tmp/rigger-rec.*, normalize rule
# 1), a `rigger` shim → packages/cli/dist/agent-rigger, a deterministic PS1='$ '
# (no cwd leak), and an EXIT/INT/TERM teardown trap. Sourced, so RIGGER_HOME
# precedes every rigger call. The long catalog URL is wired here so the visible
# demo stays focused; `>/dev/null` makes stdout non-TTY, suppressing the
# interactive post-add proposal picker (cmd-catalog.ts).
Hide
Type 'source docs/tapes/lib/setup.sh'
Enter
Type 'rigger catalog add jr https://github.com/jrobic/jr-agent-rigger-catalog.git >/dev/null && echo RIG_READY'
Enter
# Gate on the clone completing before clear: the catalog add is a network clone,
# and its typed command echo sits in the terminal buffer. Without this gate a
# slow clone could still be running when Show fires, bleeding the hidden setup
# lines into the first visible frame (vhs#130).
Wait+Screen /RIG_READY/
Type 'clear'
Enter
# Anti-race guard (vhs#130): hold the reveal until ttyd has flushed the `clear`
# redraw, else the hidden setup bleeds into the first visible frame (leak is load-
# and machine-dependent; probed 60 hidden lines → 9 leaks, 0 with this idiom).
Sleep 2s
Show
Sleep 800ms

# --- 1. deps + scan mode -----------------------------------------------------
Type "rigger doctor"
Sleep 500ms
Enter
Wait+Screen /no findings/
Sleep 2s

# --- 2. what the team rig offers (catalog already plugged in) -----------------
Type "rigger ls | head -16"
Sleep 500ms
Enter
Wait+Screen /Catalog \(/
Sleep 2500ms

# Reset the screen before the heavy step. ttyd re-renders the whole screen buffer
# per frame, so its throughput degrades as content accumulates (the same output-
# volume throttle that blocked getting-started): doctor + ls + the install plan on
# one screen crosses the knee and the plan stalls mid-render. A visible `clear`
# drops the buffer back to a clean prompt so the install renders in ~7 s, and the
# demo reads as a crisp per-command screen rather than a long scroll.
Type "clear"
Sleep 500ms
Enter
Sleep 500ms

# --- 3. install the rig in one command — a compact PLAN first, never a blind
#        write. `--summary` collapses the 24-artifact plan to one line per target
#        plus a Σ tally, so the take renders where the verbose plan throttled ttyd.
# `--assistant claude` is load-bearing for DETERMINISM (same rationale as
# scan-blocked): on a throwaway RIGGER_HOME the assistant is unresolved, so under
# a TTY resolveAssistant pops an interactive picker where >1 assistant is detected
# — it fires on this macOS box (claude+opencode) and hangs the take, but not on
# the CI Linux runner (none detected → 'claude' fallback). The flag pins claude on
# BOTH (decideAssistant: flag wins first), giving one byte-identical golden.
Type "rigger install jr/pack:secu jr/pack:baseline --yes --summary --assistant claude"
Sleep 500ms
Enter
# Gate on the summary Result line (the per-target lists are gone in --summary, so
# `Applied N file(s)` is the stable anchor that survives the flag).
Wait+Screen /Applied 24 file/
Sleep 2s

# --- 4. verify: zero drift ---------------------------------------------------
Type "rigger check"
Sleep 500ms
Enter
Wait+Screen /up-to-date/
Sleep 2500ms

# --- hidden teardown (setup.sh EXIT/INT/TERM trap also removes $RIGGER_HOME) ---
# No final Show: the same Hide/Show race (vhs#130) runs in reverse at teardown —
# a Show after `rm -rf` can capture that command in the LAST GIF frame. Leaving
# capture hidden ends the film on the clean `check` result; the EXIT trap cleans up.
Hide
Type 'rm -rf "$RIGGER_HOME"'
Enter
