# agent-rigger — demo recording (VHS tape)
#
# Renders docs/demo.gif. Reproducible: anyone can regenerate it.
#
#   # from the repo root, with deps installed:
#   bun run build                 # produces packages/cli/dist/agent-rigger
#   vhs docs/demo.tape            # writes docs/demo.gif
#
# Requires: vhs (https://github.com/charmbracelet/vhs), ffmpeg, ttyd,
#           plus git + gitleaks/trivy on PATH (the catalog is scanned on install).
# Runs against a throwaway $RIGGER_HOME — your real ~/.claude is never touched.

Output docs/demo.gif

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"

# --- hidden setup: isolated home, `rigger` shim, team catalog plugged in -----
# The long catalog URL is wired here so the visible demo stays focused.
Hide
Type 'export RIGGER_HOME="$(mktemp -d /tmp/rigger-demo.XXXXXX)"'
Enter
Type 'rigger() { ./packages/cli/dist/agent-rigger "$@"; }'
Enter
Type 'rigger catalog add jr https://github.com/jrobic/jr-agent-rigger-catalog.git >/dev/null'
Enter
Type 'clear'
Enter
Show
Sleep 800ms

# --- 1. deps + scan mode -----------------------------------------------------
Type "rigger doctor"
Sleep 500ms
Enter
Sleep 2s

# --- 2. what the team rig offers (catalog already plugged in) -----------------
Type "rigger ls | head -16"
Sleep 500ms
Enter
Sleep 2500ms

# --- 3. install the rig in one command — PLAN first, never a blind write -----
Type "rigger install jr/pack:secu jr/pack:baseline --yes"
Sleep 500ms
Enter
Sleep 6s

# --- 4. verify: zero drift ---------------------------------------------------
Type "rigger check"
Sleep 500ms
Enter
Sleep 3s

# --- hidden teardown: throwaway home removed, machine clean ------------------
Hide
Type 'rm -rf "$RIGGER_HOME"'
Enter
Show
