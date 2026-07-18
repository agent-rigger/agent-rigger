# agent-rigger — scan-blocked recording (VHS tape) — flux R3
#
# A single visible command (`rigger install trapped/skill:scan-demo`) hits the
# install-time secret scan and fails closed: gitleaks flags a planted fake AWS
# access key in the trapped-catalog fixture, so the install stops before writing
# anything (exit 1). This is the fail-closed behaviour documented on
# guides/install-from-catalog.md (§ scan warning).
#
# Renders (raw, untracked — see docs/tapes/.gitignore):
#   docs/tapes/.out/scan-blocked.gif
#   docs/tapes/.out/scan-blocked.txt
# The tracked artefacts are derived from those (see Regeneration below):
#   docs/tapes/golden/scan-blocked.txt          (raw .txt piped through normalize.sh)
#   site/src/assets/recordings/scan-blocked.gif  (raw .gif, published asset — D2)
#
# Regeneration (run from the agent-rigger repo root — paths below are relative):
#   bun install && bun run build                          # packages/cli/dist/agent-rigger
#   docs/tapes/fixtures/trapped-catalog/validate.sh       # MUST exit 0 (R3 S2/S4)
#   vhs docs/tapes/scan-blocked.tape
#   docs/tapes/lib/normalize.sh < docs/tapes/.out/scan-blocked.txt > docs/tapes/golden/scan-blocked.txt
#   cp docs/tapes/.out/scan-blocked.gif site/src/assets/recordings/scan-blocked.gif
#
# Requires on PATH: vhs (0.11.0 — the version pinned by the freshness workflow,
# D1), ttyd, ffmpeg, git, gitleaks (8.30.1 is the pinned reference — the finding
# text is fixed by this version). Runs under a throwaway $RIGGER_HOME sourced
# from docs/tapes/lib/setup.sh — the real ~/.claude is never touched (R5).

Output site/src/assets/recordings/scan-blocked.gif
Output docs/tapes/.out/scan-blocked.txt

Set Shell bash
Set FontSize 15
Set Width 1280
Set Height 640
Set Padding 24
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"

# --- hidden setup: isolated home + shim + fail-closed gate + staged fixture ---
Hide
# setup.sh (T1): exports a throwaway RIGGER_HOME (fail-closed), a `rigger` shim →
# packages/cli/dist/agent-rigger, a deterministic PS1='$ ' (no cwd leak), and an
# EXIT/INT/TERM teardown trap. Sourced, so RIGGER_HOME precedes every rigger call.
Type 'source docs/tapes/lib/setup.sh'
Enter
# Pin the catalog checkout under /tmp. remote.ts clones into
# `os.tmpdir()/agent-rigger-catalog-XXXXXX`, and that path is echoed verbatim in
# the gitleaks finding. On macOS os.tmpdir() is a long `/var/folders/<hash>/T`
# path; on the CI Linux runner it is already `/tmp`. The finding line is ~270
# chars and WRAPS — with the long macOS prefix the wrap falls THROUGH the random
# mkdtemp suffix, splitting it across two physical lines so normalize.sh (line-
# based) cannot collapse it and the suffix leaks (record≠record, macOS≠Linux).
# TMPDIR=/tmp gives macOS the exact CI path shape, so the whole `/tmp/agent-
# rigger-catalog-XXXX/...` token lands on one physical line and normalize rule 3
# collapses it to <CATALOG_TMP> identically on both. RIGGER_HOME is unaffected
# (setup.sh mktemp's an explicit /tmp/rigger-rec path, not TMPDIR).
Type 'export TMPDIR=/tmp'
Enter
# R3 S2/S4 fail-closed gate: abort the take unless gitleaks is present AND the
# fixture still trips it. Without this a warn-only (no-scanner) run would film an
# install that PASSES where the page documents a block.
Type 'docs/tapes/fixtures/trapped-catalog/validate.sh >/dev/null 2>&1 || { echo "ABORT: gitleaks absent or fixture no longer trips (R3 S2/S4)"; exit 1; }'
Enter
# Stage the trapped catalog as a local git repo INSIDE the throwaway home (R5 S3
# — all staged state stays disposable), tagged v1.0.0 so resolveVersion picks a
# clean tag for the shallow clone. `-c tag.gpgSign=false` overrides an operator's
# global tag.gpgSign/forceSignAnnotated so the lightweight tag succeeds on any
# machine (CI has neither set; a signing operator would otherwise fail here).
Type 'TRAP="$RIGGER_HOME/trapped-catalog"'
Enter
Type 'cp -R docs/tapes/fixtures/trapped-catalog "$TRAP"'
Enter
Type 'git -C "$TRAP" init -q'
Enter
Type 'git -C "$TRAP" add -A'
Enter
Type 'git -C "$TRAP" -c user.name=rec -c user.email=rec@local commit -q -m "trapped catalog fixture"'
Enter
Type 'git -C "$TRAP" -c tag.gpgSign=false tag v1.0.0'
Enter
# Register the source. `>/dev/null` makes stdout non-TTY, which suppresses the
# interactive post-add proposal picker (cmd-catalog.ts) — the exact trick
# demo.tape uses. Keeps the staging path off-screen (hidden) and picker-free.
Type 'rigger catalog add trapped "$TRAP" >/dev/null'
Enter
Type 'clear'
Enter
# Anti-race guard (vhs#130): hold the reveal until ttyd has flushed the `clear`
# redraw, else the hidden staging lines bleed into the first visible frame (leak
# is load- and machine-dependent; probed 60 hidden lines → 9 leaks, 0 with this
# `clear → Enter → Sleep 2s → Show` idiom).
Sleep 2s
Show
Sleep 800ms

# --- the block: a qualified-id install fails closed at the scan gate ----------
# No --yes: the scan throws INSIDE buildRemoteInstallPlan (remote-install.ts)
# BEFORE any plan/confirm, so this blocks cleanly with no confirm prompt and
# nothing written. `--assistant claude` is load-bearing for DETERMINISM, not
# cosmetics: on a throwaway RIGGER_HOME the assistant is unresolved, so under a
# TTY resolveAssistant would pop an interactive picker and hang the take
# (decideAssistant → needsPrompt). Worse, that picker only appears where >1
# assistant is detected — it fires on this macOS box (claude+opencode) but not
# on the CI Linux runner (none detected → 'claude' fallback), so without the
# flag the two machines would diverge. The flag pins the assistant on BOTH
# (decideAssistant: flag wins first), giving one byte-identical golden. It is
# the documented resolution path (`--assistant`, shown in `rigger --help`).
Type "rigger install trapped/skill:scan-demo --assistant claude"
Sleep 500ms
Enter
# Gate on the actual block message, generously (60s): the clone + a COLD gitleaks
# run on a fresh CI runner is much slower than the ~1s local scan, and the earlier
# @30s window lapsed there — the `[error] Security scan…` block was missing from
# the CI capture. Wait for the last block line so the whole finding has rendered
# before the linger, whatever the timing; the short settles absorb the few-ms gap
# between the last output line and the returning `$` prompt (frame-cadence jitter).
Sleep 2s
Wait+Screen@60s /Re-run with --force/
Sleep 2s

# --- hidden teardown: throwaway home removed (also on INT/TERM via setup trap) -
# No final Show: a Show after `rm -rf` can capture it in the LAST GIF frame via
# the reverse Hide/Show race (vhs#130) — it did (`$ rm -rf "$RIGGER_HOME"` leaked
# into golden line 63). Keeping capture hidden ends the film on the clean block
# message; setup.sh's EXIT trap still removes $RIGGER_HOME.
Hide
Type 'rm -rf "$RIGGER_HOME"'
Enter
