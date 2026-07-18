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

### Authoring: the anti-race idiom (mandatory)

Every tape hides its setup (sourcing `lib/setup.sh`, exporting `RIGGER_HOME`) behind `Hide … Show`.
VHS has a **load- and volume-dependent race between `Hide`/`Show` and its ttyd backend**
([vhs#130](https://github.com/charmbracelet/vhs/issues/130), open since 2022): under load, the
reveal fires before ttyd has finished redrawing, so hidden setup lines **bleed into the first visible
frame** of the GIF. Probed here: 60 hidden lines produced 9 leaks; the idiom below produced 0.

**Reveal — always clear, then hold, then show:**

```
Hide
Type 'source docs/tapes/lib/setup.sh'
Enter
# … any other hidden setup …
Type 'clear'
Enter
Sleep 2s          # let ttyd flush the clear redraw BEFORE revealing
Show
```

The `clear` scrubs the hidden lines from the buffer; the `Sleep 2s` gives ttyd time to render that
clear before capture resumes. Neither alone is enough — without the `clear` the lines are still in
the buffer, without the `Sleep` the reveal can outrun the redraw.

**Teardown — keep it hidden, no final `Show`:** the same race runs in reverse. A `Show` after a hidden
`rm -rf "$RIGGER_HOME"` can capture that command in the **last** GIF frame. End the film on the last
visible result and leave teardown hidden (the `setup.sh` EXIT/INT/TERM trap cleans up anyway). If a
tape must reveal after a hidden teardown, insert the same `clear` + `Sleep 2s` before the `Show`.

After every re-shoot, **verify the normalised golden carries no setup residue** — grep it for
`source …setup.sh`, `export`, `mktemp`, `rm -rf`, and any raw `rigger-rec.*` path the normaliser
should have erased. A leak in the `.txt` means a leak in the GIF.

| Flux              | Tape                                           | Published GIF                                    | Golden                                                     |
| ----------------- | ---------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| `doctor-fix`      | [`doctor-fix.tape`](doctor-fix.tape)           | `site/src/assets/recordings/doctor-fix.gif`      | [`golden/doctor-fix.txt`](golden/doctor-fix.txt)           |
| `scan-blocked`    | [`scan-blocked.tape`](scan-blocked.tape)       | `site/src/assets/recordings/scan-blocked.gif`    | [`golden/scan-blocked.txt`](golden/scan-blocked.txt)       |
| `install-picker`  | [`install-picker.tape`](install-picker.tape)   | `site/src/assets/recordings/install-picker.gif`  | [`golden/install-picker.txt`](golden/install-picker.txt)   |
| `demo`            | [`demo.tape`](demo.tape)                       | `../demo.gif`                                    | [`golden/demo.txt`](golden/demo.txt)                       |
| `getting-started` | [`getting-started.tape`](getting-started.tape) | `site/src/assets/recordings/getting-started.gif` | [`golden/getting-started.txt`](golden/getting-started.txt) |

Before re-shooting `scan-blocked`, re-run
[`fixtures/trapped-catalog/validate.sh`](fixtures/trapped-catalog/validate.sh): it proves the fixture
still trips gitleaks on the installed version (R3 scenario 2). The freshness workflow runs it too.

## Previously not filmed (now covered)

Both `getting-started` (flow R1) and `demo` were once excluded here and are now filmed — the two
rows added to the table above. The history is worth keeping, because it explains why the contract
grew from three flows to five.

Both filmed the same 24-artifact install (`jr/pack:secu jr/pack:baseline`), whose Plan printed
enough raw stdout (123 lines) that VHS's ttyd backend rendered it too slowly to ever reach the
Result. The cause was **measured** — with the scanners removed entirely (warn-only, zero spawns) the
install stalled identically, so it was the **output volume**, not the ~48 gitleaks/trivy spawns
(hypothesis disproven). `getting-started`'s tape was removed and `demo.gif` was frozen out of the
freshness workflow (ADR-0026).

Two changes lifted the block (2026-07-18):

- The **`--summary`** flag (plan-compact-summary change, delivered 2026-07-17) renders the install in
  a fraction of the lines, under the ttyd throttle's knee.
- `getting-started` now films the **light example pack** (`example/pack:demo`, 2 artifacts — the flow
  the page actually teaches), not the 24-artifact jr rig, cutting the output further.

Both tapes apply the anti-race idiom above, carry a normalised golden, and ride the freshness
workflow like the other three. Nothing in the documented flow set is currently unfilmed; re-filming
the install-picker **bundle** variants remains a possible future addition (out of this change's scope).
