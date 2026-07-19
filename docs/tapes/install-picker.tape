# agent-rigger — R4 interactive install picker recording (VHS tape, T5).
#
# Films the interactive `install` (no ids) flow against the real jr catalog:
#   scope select -> grouped picker (required ∪ recommended pre-checked, B4 fix)
#   -> check one non-recommended entry -> deselect the two bundles -> confirm the
#   one-artifact plan -> applied result.
#
# Why the film does NOT install the pre-checked bundles: pack:secu ∪ pack:baseline
# expands to ~24 member artifacts whose plan renders full content diffs (context,
# guardrails) — 300+ lines. That confirm prompt overruns the terminal, fails the
# recording and would blow the ≤800 KB GIF budget. The film therefore shows the
# B4 pre-check on the opening frame (its job, R4), then the user overrides it and
# installs a single agent so the plan stays legible. See the T5 report / verdict.
#
# Regenerate (from the agent-rigger/ repo root, deps installed):
#   bun run build
#   vhs docs/tapes/install-picker.tape
#   ./docs/tapes/lib/normalize.sh \
#       < docs/tapes/.out/install-picker.txt > docs/tapes/golden/install-picker.txt
#
# Prerequisites: vhs 0.11.0, ttyd, ffmpeg; git + a secret scanner (gitleaks or
#   trivy) on PATH — without a scanner the remote install falls to warn-only and
#   the golden gains a "content not scanned" line; network access to github.com.
#
# Hidden staging that the R6 verifier AND the freshness workflow must replay
# verbatim, else the golden diverges:
#   1. source docs/tapes/lib/setup.sh  -> throwaway $RIGGER_HOME (R5), rigger shim.
#   2. mkdir -p "$RIGGER_HOME/.claude" -> makes detectAssistants() find claude, so
#      the visible flow opens on "Select installation scope:" and NOT on the
#      "Which assistant do you want to target?" prompt (empty .claude, no manifest
#      -> every jr entry still classes as "To install").
#   3. rigger catalog add jr <url>     -> wires the real jr catalog (network).
# The whole run stays under the throwaway $RIGGER_HOME; the real ~/.claude is
# never read or written (R5), and setup.sh's trap removes it in teardown.

Output site/src/assets/recordings/install-picker.gif
Output docs/tapes/.out/install-picker.txt

Set Shell bash
Set FontSize 13
Set Width 1180
Set Height 1150
Set Padding 20
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
# 60s (was 40s): the `install` picker only appears after the real jr catalog is
# cloned and version-resolved over the network — slower on a cold CI runner than
# locally. Widened so a healthy-but-slow clone doesn't trip the Wait.
Set WaitTimeout 60s

# --- hidden setup: isolated home + shim + trap, claude detected, jr catalog ---
Hide
Type 'source docs/tapes/lib/setup.sh'
Enter
Type 'mkdir -p "$RIGGER_HOME/.claude"'
Enter
Type 'rigger catalog add jr https://github.com/jrobic/jr-agent-rigger-catalog.git >/dev/null 2>&1 && echo READY'
Enter
Wait+Screen /READY/
Type 'clear'
Enter
# Anti-race guard (vhs#130): hold the reveal until ttyd has flushed the `clear`
# redraw so the hidden staging lines cannot bleed into the first visible frame
# (leak is load- and machine-dependent). Purely hidden — the visible flow and the
# golden are unchanged, so this tape is not re-rendered.
Sleep 2s
Show
Sleep 800ms

# --- 1. launch the interactive picker (no ids) ---
Type "rigger install"
Sleep 400ms
Enter

# scope prompt appears after the catalog fetch (resolveEffectiveCatalogFull, network)
Wait+Screen /Select installation scope/

# --- 2. scope: keep the default (user) so the plan shows ~/.claude paths ---
Sleep 1200ms
Enter

# grouped picker appears after remote-version resolution (computeArtifactStatuses, network)
Wait+Screen /Select artifacts to install/

# --- 3. B4 headline: the opening frame shows pack:secu (required) and pack:baseline
#         (recommended) pre-checked, every other entry unchecked. Hold on it. ---
Sleep 2800ms

# --- 4. check a single non-recommended entry (agent:tdd-coach, row 12) ---
Down 12
Sleep 900ms
Space
Sleep 1400ms

# --- 5. override the catalog's opinion: uncheck the two pre-checked bundles
#         (pack:secu row 34, pack:baseline row 39) so the plan is one artifact ---
Down 22
Sleep 700ms
Space
Sleep 700ms
Down 5
Sleep 700ms
Space
Sleep 1200ms

# --- 6. submit the selection ---
Enter

# --- 7. plan confirm — initialValue is No, so a bare Enter would abort; press y
#         (@clack/core emits "confirm" on y/n and submits immediately) ---
Wait+Screen /Apply the following plan/
Sleep 2000ms
Type "y"

# --- 8. applied result ---
Wait+Screen /Applied/
# 30s reading hold: the GIF lingers on the final state before looping.
Sleep 30s

# --- teardown: setup.sh's EXIT/INT/TERM trap rm -rf's $RIGGER_HOME (R5), hidden ---
