# shellcheck shell=bash
# agent-rigger — stage a reproducible broken installed-state for the
# doctor --fix recording (flux R2 / isolation R5 scenario 3).
#
# Sourced (not executed) in the hidden setup of docs/tapes/doctor-fix.tape,
# AFTER docs/tapes/lib/setup.sh — it uses the `rigger` shim and the throwaway
# $RIGGER_HOME that setup.sh exports. All fabrication lives under $RIGGER_HOME;
# the operator's real ~/.claude is never touched (R5).
#
# It produces EXACTLY two findings, one per consent tier — so the film shows the
# two prompt texts and the two consent paliers of ADR-0025:
#   1. untracked-but-conforming skill  -> adopt (safe)          -> "Apply repair?"   [fix]
#   2. dangling symlink, no manifest   -> unlink (item-confirm)  -> "Confirm repair?" [confirm]
#
# A subshell carries `set -euo pipefail` so a staging failure aborts loudly
# instead of leaking a half-broken state into the interactive VHS shell, while
# the sourced `rigger` shell-function itself stays defined in the outer shell.
(
  set -euo pipefail

  # Real jr catalogue (design D3): the film shows the catalogue a reader would
  # actually configure. `catalog add` registers the source; it installs nothing.
  rigger catalog add jr https://github.com/jrobic/jr-agent-rigger-catalog.git >/dev/null

  # One lone skill — skill:diagnose has no `requires`, so exactly one artifact is
  # written (store + symlink + one manifest entry). --scope=user is EXPLICIT:
  # a project-scope install writes to the repo's own cwd/.claude (not redirected
  # by RIGGER_HOME) — pollution and the wrong scope.
  rigger install jr/skill:diagnose --yes --scope=user >/dev/null

  # Empty the manifest: the store dir + symlink survive on disk but no entry
  # tracks them -> untracked-but-conforming (adapter.audit == 'present') -> one
  # untracked-adoptable finding, adopt/safe.
  printf '{"version":1,"artifacts":[]}' \
    > "$RIGGER_HOME/.config/agent-rigger/state.json"

  # A bare dead symlink under the claude/user skills root: target absent, no
  # manifest entry -> one dangling-untracked finding, unlink/item-confirm.
  ln -s "$RIGGER_HOME/.claude/skills/_gone" \
    "$RIGGER_HOME/.claude/skills/ghost-skill"
)
