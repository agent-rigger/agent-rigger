# Terminal recordings (VHS tapes)

The `.tape` files here record real `agent-rigger` sessions with
[VHS](https://github.com/charmbracelet/vhs). Each published recording exists so a doc page shows
what a reader will actually see — and stays honest over time through the freshness contract below.

## Freshness contract (R7 / ADR-0026)

Every tape emits **two** outputs: a `.gif` (the published pixels) and a `.txt` (the session text).
The `.txt`, run through [`lib/normalize.sh`](lib/normalize.sh) to erase volatile fields (mktemp
paths, resolved binary paths, backup timestamps, git shas — semver tags preserved), is committed as
the **golden** in [`golden/`](golden). The CI workflow
[`.github/workflows/recordings-freshness.yml`](../../.github/workflows/recordings-freshness.yml)
re-plays the tapes on every push to `main` that touches `packages/**`, `docs/tapes/**`, `bun.lock`
or the workflow itself, plus a weekly cron (the catalog lives in its own repo and drifts silently).
The comparison is **directional on the unique-line set**: every golden line must still be produced
by the replay; extra replay lines are ignored. A VHS `.txt` stacks one full-screen snapshot per
redraw, and redraw count and sampling instants are machine-dependent — a runner captures transient
frames or duplicate counts the recording machine never saw, so a byte-diff is unstable by
construction. Trade-off (ADR-0026): a changed or vanished line reds the check; a pure addition (a
new catalog entry) does not — the film goes slightly dated, never lying.

Pixels are **not** compared: VHS renders are non-deterministic across machines, so only the
normalised `.txt` is the contract. The maintainer regenerates the `.gif` locally (below); CI never
commits a pixel.

## Prerequisites

- [vhs](https://github.com/charmbracelet/vhs) **v0.11.0**, plus its `ttyd` and `ffmpeg` runtime deps.
- `git`, `glab`, `gitleaks` **8.30.1**, `trivy` on PATH — `doctor` phase 1 lists all four, and a
  missing one flips its line to `✗` and breaks the `doctor-fix` golden. gitleaks is version-sensitive:
  the `scan-blocked` golden freezes 8.30.1's finding text (RuleID + Description).
- Network access to `github.com`: the `install-picker` flow and the `doctor-fix` staging clone the
  real `jr` catalog.
- A built CLI: `bun install && bun run build` produces `packages/cli/dist/agent-rigger`, the target
  of the `rigger` shim in [`lib/setup.sh`](lib/setup.sh).

## Isolation (R5)

Every tape sources [`lib/setup.sh`](lib/setup.sh) in its hidden setup. That script exports a
throwaway `RIGGER_HOME` under `/tmp/rigger-rec.*` **before** any `rigger` command (fail-closed: a
failed `mktemp` aborts rather than falling back to the real `$HOME`), defines the `rigger` shim, and
traps teardown on `EXIT`/`INT`/`TERM`. The operator's real `~/.claude` / `~/.config/agent-rigger` is
never read or written — an interrupted take leaves only the `/tmp` dir behind.

## Regenerating a recording

From the `agent-rigger` submodule root (branch `feat/vhs-recordings`):

```bash
bun install && bun run build                 # -> packages/cli/dist/agent-rigger (shim target)
mkdir -p docs/tapes/.out
vhs docs/tapes/<flux>.tape                    # -> <gif> + docs/tapes/.out/<flux>.txt
docs/tapes/lib/normalize.sh \
  < docs/tapes/.out/<flux>.txt \
  > docs/tapes/golden/<flux>.txt              # refresh the golden from the same normaliser
```

Then review the new `.gif` and golden, have the recording verified independently (R6), and **commit
the `.gif` and the golden together** — they are one atomic update of what the page shows.

| Flux             | Tape                                         | Published GIF                                   | Golden                                                   |
| ---------------- | -------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `doctor-fix`     | [`doctor-fix.tape`](doctor-fix.tape)         | `site/src/assets/recordings/doctor-fix.gif`     | [`golden/doctor-fix.txt`](golden/doctor-fix.txt)         |
| `scan-blocked`   | [`scan-blocked.tape`](scan-blocked.tape)     | `site/src/assets/recordings/scan-blocked.gif`   | [`golden/scan-blocked.txt`](golden/scan-blocked.txt)     |
| `install-picker` | [`install-picker.tape`](install-picker.tape) | `site/src/assets/recordings/install-picker.gif` | [`golden/install-picker.txt`](golden/install-picker.txt) |

Before re-shooting `scan-blocked`, re-run
[`fixtures/trapped-catalog/validate.sh`](fixtures/trapped-catalog/validate.sh): it proves the fixture
still trips gitleaks on the installed version (R3 scenario 2). The freshness workflow runs it too.

## Not filmed

- **`getting-started`** (flow R1) was **abandoned**. Its 24-artifact install
  (`jr/pack:secu jr/pack:baseline`) is throttled under VHS's ttyd backend: the Plan prints a full
  content preview per artifact (hundreds of lines) and ttyd renders it so slowly the session never
  reaches the Result. Measured cause: with the scanners removed entirely (warn-only, zero spawns)
  the install stalls identically — it is the **output volume**, not the ~48 gitleaks/trivy spawns
  (hypothesis disproven). The page keeps its hand-written text blocks and the tape was removed.
- **`../demo.tape` / `../demo.gif`** installs the same pack and hits the same throttle, so `demo.gif`
  is **not regenerable at the current `jr` catalog volume** and is deliberately excluded from the
  freshness workflow (ADR-0026). It waits on the backlog item **"plan compact (`--summary`)"**
  (`docs/specs/BACKLOG.md`): once the Plan output is compact enough to record, `demo.gif` can be
  regenerated with a golden and folded into the workflow.
