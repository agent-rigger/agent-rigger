# shellcheck shell=bash
# agent-rigger — shared hidden setup for VHS tapes (design D5, isolation R5).
#
# Sourced (not executed) from the hidden `Hide … Show` block of every .tape of
# the vhs-recordings change:
#
#   Hide
#   Type 'source docs/tapes/lib/setup.sh'
#   Enter
#   ...
#   Show
#
# It gives each recording a throwaway home and a `rigger` shim, so no filmed
# command ever reads or writes the operator's real ~/.claude / ~/.config.
#
# ORDER + FAIL-CLOSED are the invariant (R5 scenario 2). resolveHome()
# (packages/core/src/paths.ts:94) treats an EMPTY RIGGER_HOME as absent and falls
# back to the real $HOME — an invisible (hidden setup), irreversible write into the
# maintainer's ~/.claude. So this must run before any rigger command AND mktemp's
# exit code must not be masked (SC2155): a failed mktemp must never leave
# RIGGER_HOME="". Assign, verify, only then export. The literal /tmp/rigger-rec
# template is load-bearing — normalize.sh rule 1 matches it.
RIGGER_HOME="$(mktemp -d /tmp/rigger-rec.XXXXXX)" || exit 1
[ -n "$RIGGER_HOME" ] && [ -d "$RIGGER_HOME" ] || exit 1
export RIGGER_HOME

# Deterministic prompt for every filmed frame. Without it the interactive prompt
# carries the operator's default PS1 (cwd, host, git branch…) and every golden
# would leak a machine-specific path — a spurious, per-machine diff in the .txt
# the freshness workflow (D1) and the R6 verdict compare. A bare `$ ` is the same
# on every machine. Set here (once, in the shared setup) so no tape re-invents it.
export PS1='$ '

# Repo root resolved from this file's own location, not a machine-specific path:
# setup.sh lives at <root>/docs/tapes/lib/, so three levels up is the repo root.
# BASH_SOURCE[0] is the sourced path even when $0 is the interactive shell.
RIGGER_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# `rigger` shim → the built CLI. Prerequisite (documented per tape): `bun run
# build` has produced packages/cli/dist/agent-rigger. Quoted so a repo path with
# spaces still resolves.
#
# Fail-closed guard (the real "by construction" of D5): even if RIGGER_HOME were
# tampered with after setup, the shim refuses to run a command that would fall
# back to the real home. This closes R5 at the last gate, not just at export time.
rigger() {
  if [ -z "${RIGGER_HOME:-}" ] || [ ! -d "${RIGGER_HOME}" ]; then
    echo 'rigger shim: refusing to run — RIGGER_HOME is empty or not a directory (would fall back to the real HOME, R5).' >&2
    return 1
  fi
  "${RIGGER_REPO_ROOT}/packages/cli/dist/agent-rigger" "$@"
}

# Teardown: drop the throwaway home. Fires on normal end (EXIT) and on
# interruption (INT/TERM) so an aborted take leaves only the /tmp dir behind and
# never an escape onto the real home (R5 scenarios 1 & 4). `-f` keeps it a no-op
# if a tape already removed it in a visible teardown step.
trap 'rm -rf "${RIGGER_HOME}"' EXIT INT TERM
