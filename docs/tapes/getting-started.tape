# agent-rigger — getting-started recording (VHS tape) — flux R1
#
# ┌───────────────────────────────────────────────────────────────────────────────┐
# │ BLOCKED (2026-07-14): this tape does NOT render on the current machine.        │
# │ `rigger install jr/pack:secu jr/pack:baseline` (24 artifacts) is GLACIAL under │
# │ VHS's ttyd backend — a 170s Wait window still did not reach `Applied 24        │
# │ file(s)`; only ~5 of 24 Plan artifacts printed. The IDENTICAL install finishes │
# │ in ~2.3s in a raw Python forkpty and ~4s non-TTY. A single-skill install       │
# │ (`jr/skill:diagnose`) DOES render fine under VHS. So the throttle scales with  │
# │ the install's work/output volume — most likely per-artifact scanner subprocess │
# │ spawns (gitleaks+trivy, ~48 spawns for the pack) being slow under ttyd, plus   │
# │ VHS rendering the large plain Plan/Result. Not fixable from the tape.          │
# │ Ruled out: catalog-add proposal picker (fixed with `| cat`), the "Which        │
# │ assistant" prompt (fixed with `--assistant claude`), the scanners themselves   │
# │ (no-op shims still slow), stdin (`< /dev/null`), stderr spinner (`2>&1 | cat`), │
# │ git-clone (completes under ttyd), and rate limiting (fresh clone = 899ms).      │
# │ Everything below IS correct and reproducible off-VHS; it renders as soon as the │
# │ ttyd install-throttle is resolved (needs a decision — see verification note).  │
# └───────────────────────────────────────────────────────────────────────────────┘
#
# Companion film for start/getting-started.md: the whole tutorial run once, end to
# end, against the REAL team catalog jr (https://github.com/jrobic/jr-agent-rigger-catalog).
# The page itself still teaches the public `example` catalog; this recording shows
# the same five steps as a real team-catalog session.
#
# Emits:
#   site/src/assets/recordings/getting-started.gif   (tracked, published asset)
#   docs/tapes/.out/getting-started.txt              (untracked raw VHS capture)
# The tracked golden is the NORMALISED capture (design D4):
#   docs/tapes/golden/getting-started.txt
#
# Regenerate (from the agent-rigger submodule root, branch feat/vhs-recordings):
#   bun install && bun run build                      # -> packages/cli/dist/agent-rigger (shim target, R7)
#   vhs docs/tapes/getting-started.tape               # -> gif + .out/getting-started.txt
#   docs/tapes/lib/normalize.sh < docs/tapes/.out/getting-started.txt > docs/tapes/golden/getting-started.txt
#
# Requires on PATH: vhs, ttyd, ffmpeg + git, glab, gitleaks, trivy (doctor lists all
#   four in ✓; a missing scanner flips its line to ✗ and breaks the golden — see the
#   freshness workflow's four-dep parity contract, D3). github.com must be reachable:
#   the jr catalog is cloned on install and version-resolved on check (D3).
# jr pinned version at recording time: v0.2.2 (largest semver tag; the golden pins it
#   in the check output — a jr tag bump is legitimate drift, D3).
# Runs under a throwaway $RIGGER_HOME (docs/tapes/lib/setup.sh) — the real ~/.claude
#   is never touched (R5). Colour is left ON (Catppuccin); VHS strips ANSI from the
#   .txt capture, so the golden stays byte-stable regardless (GATE A convention).
#
# Timing: fixed Sleeps, no `Wait /regexp/`, no quoted pipelines. ttyd drops the odd
# Timing: fixed Sleeps for the fast local steps; `Wait /regexp/` gates the three
# steps whose duration is variable (network fetch + gitleaks/trivy scan) so the
# recording never cuts mid-scan and the freshness CI (slower runner) stays in sync.
# Two TTY traps are neutralised inline: `catalog add | cat` skips its post-add
# install-proposal picker (isTTY-gated), and `install --assistant claude` skips the
# "Which assistant…" prompt a throwaway home would otherwise raise under --yes.

Output site/src/assets/recordings/getting-started.gif
Output docs/tapes/.out/getting-started.txt

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 760
Set Padding 24
Set TypingSpeed 50ms
Set Theme "Catppuccin Mocha"

# --- hidden setup: throwaway home + `rigger` shim (setup.sh: RIGGER_HOME mktemp
#     fail-closed FIRST, PS1='$ ', shim, teardown trap on EXIT). No visible frame
#     leaks it. Settle Sleeps let bash print each prompt before the next line types.
Hide
Sleep 1s
Type 'source docs/tapes/lib/setup.sh'
Enter
Sleep 800ms
Type 'clear'
Enter
Show
Sleep 800ms

# --- Step 1 — read the environment: deps, scan mode, empty installed state --------
Type "rigger doctor"
Sleep 500ms
Enter
Sleep 2s

# --- Step 2 — add the team catalog (a git URL recorded in config) -----------------
# Piped through `cat`: in a TTY, `catalog add` follows the persisted source with an
# interactive "propose to install" picker (cli.ts, gated on process.stdout.isTTY).
# That picker would open here and swallow every command typed after it. Piping makes
# stdout a non-TTY, so the proposal is skipped while the "added" line still prints —
# matching the page's Step 2, which shows only the confirmation.
Type "rigger catalog add jr https://github.com/jrobic/jr-agent-rigger-catalog.git | cat"
Sleep 500ms
Enter
Sleep 2s

# --- Step 3 — see what the catalog offers (truncated with head to keep the frame
#     readable). No quotes: a dropped quote under ttyd would open a `>` continuation.
Type "rigger ls | head -20"
Sleep 500ms
Enter
Wait+Screen@30s /Catalog \(/
Sleep 2500ms

# --- Step 4 — install the two packs in one command: PLAN first, then RESULT.
#     `| cat`: in a TTY, install renders the Plan/Result through clack, which CLEARS
#     its own output on completion — VHS would capture a blank final frame and the
#     golden would lose the whole step. Piping makes stdout non-TTY, so install emits
#     the plain, persistent Plan/Result the page shows, and applies non-interactively.
#     `--assistant claude`: the throwaway home has no ~/.claude yet, so the target is
#     ambiguous and a TTY install would prompt "Which assistant…" even under --yes
#     (assistant-select.ts); the explicit flag resolves it silently.
#     Wait on the LAST Result line (the final applied artifact, an absolute
#     RIGGER_HOME path — the Plan prints the same id under `~/`, so anchoring on the
#     `rigger-rec` temp prefix means the apply is done, not just planned). `Applied N
#     file(s)` is the first Result line and scrolls off the top of a full frame.
Type "rigger install jr/pack:secu jr/pack:baseline --assistant claude --yes | cat"
Sleep 500ms
Enter
Wait+Screen@90s /rigger-rec[^ ]*workflow-analysis/
Sleep 3s

# --- Step 5 — audit: zero drift. `| cat` for the same reason as Step 4 (check also
#     renders through clack in a TTY and would clear its final frame).
Type "rigger check | cat"
Sleep 500ms
Enter
Wait+Screen@45s /up-to-date/
Sleep 3s

# No visible teardown: setup.sh's `trap ... EXIT` drops the throwaway home when the
# recording's shell exits (R5) — one less quoted line for ttyd to mangle.
