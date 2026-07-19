# agent-rigger — doctor --fix consented per-item repair (VHS tape, flux R2).
#
# Renders the published GIF + a raw .txt capture. The .txt is normalised into the
# tracked golden; the GIF is the vetted asset embedded in the docs page.
#
# Reproducible (run from the agent-rigger repo root):
#   bun install && bun run build                      # packages/cli/dist/agent-rigger
#   mkdir -p docs/tapes/.out
#   vhs docs/tapes/doctor-fix.tape                    # gif + docs/tapes/.out/doctor-fix.txt
#   docs/tapes/lib/normalize.sh < docs/tapes/.out/doctor-fix.txt \
#       > docs/tapes/golden/doctor-fix.txt            # tracked golden
#
# Prerequisites: vhs 0.11.0, ffmpeg, ttyd, and git + glab + gitleaks + trivy on
# PATH (doctor phase 1 lists all four; all present => a clean all-checkmark
# "full scan"). Network: the hidden staging clones the real jr catalogue from
# github.com. Runs entirely under a throwaway $RIGGER_HOME (setup.sh) — the
# operator's real ~/.claude is never read or written (R5).

Output site/src/assets/recordings/doctor-fix.gif
Output docs/tapes/.out/doctor-fix.txt

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 860
Set Padding 24
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"
# Cold-runner margin: the hidden staging clones the real jr catalog and installs a
# skill (network), then `doctor --fix` runs the scanners — all slower than local on
# a fresh CI runner. The default WaitTimeout (15s) can lapse before the first
# consent prompt appears; 60s covers the clone + scan without hanging a healthy run.
Set WaitTimeout 60s

# --- hidden setup: throwaway home + shim, then the staged broken state ---------
Hide
Type 'source docs/tapes/lib/setup.sh'
Enter
Type 'source docs/tapes/fixtures/doctor-fix/stage.sh'
Enter
# Gate on stage.sh's STAGED marker: the visible `doctor --fix` must not run until
# the clone + install + breakage are all in place. Without this, a slow runner
# films "Installed state is healthy — no findings" (staging not yet applied).
Wait+Screen /STAGED/
Type 'clear'
Enter
# Anti-race guard (vhs#130): the hidden setup lines can bleed into the first
# visible frame when Show fires before ttyd has flushed the `clear` redraw — the
# leak is load- and machine-dependent (probed: 60 hidden lines → 9 leaks). The
# `clear → Enter → Sleep 2s → Show` idiom holds the reveal until the screen is a
# clean prompt (0 leaks at the probe).
Sleep 2s
Show
Sleep 800ms

# --- the ONE visible command: two diagnostics + per-item consent --------------
Type "rigger doctor --fix"
Sleep 500ms
Enter

# Phase 1 (four deps all present, "full scan") + the two-finding report, then the
# scanners hand off to the consent driver. Wait for the FIRST prompt (safe adopt).
Wait+Screen /Apply repair/
Sleep 1200ms

# clack confirm defaults to No (initialValue:false) — Enter alone would SKIP.
# Move deliberately to Yes, then confirm. (This is the reflex-trap made visible.)
Left
Sleep 700ms
Enter

# Second finding: the DESTRUCTIVE item-confirm prompt. --yes could never grant it.
Wait+Screen /Confirm repair/
Sleep 1200ms
Left
Sleep 700ms
Enter

# Repairs applied: two [ ok  ] lines (adopt + unlink), exit 0.
Wait+Screen /\[ ok/
# 30s reading hold: the GIF lingers on the final state before looping.
Sleep 30s

# --- hidden teardown (setup.sh EXIT/INT/TERM trap also removes $RIGGER_HOME) ---
# No final Show: the same Hide/Show race (vhs#130) runs in reverse at teardown —
# a Show after `rm -rf` can capture that command in the LAST GIF frame (it did:
# `$ rm -rf "$RIGGER_HOME"` leaked into golden line 406). Leaving capture hidden
# ends the film on the clean repair result; setup.sh's EXIT trap still cleans up.
Hide
Type 'rm -rf "$RIGGER_HOME"'
Enter
