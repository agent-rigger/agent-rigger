---
title: Diagnose your installation
description: Run doctor to read a healthy report, provoke and read a finding, repair the safe ones with --fix under consent, and check remote sources with --remote.
---

You want to know whether your installed harness still matches its recorded state, and repair it when
it does not. This guide runs `doctor` through one task: read a clean report, provoke a finding on
purpose, then repair it under consent. For a first install, see
[getting started](/start/getting-started/). For the complete flag surface and every
[finding](/reference/glossary/#finding) class, see the [`doctor` reference](/reference/cli/doctor/).

## Read a healthy report

Run doctor with no flags:

```
agent-rigger doctor
```

It runs two diagnostics in order. Phase 1 lists the external tools agent-rigger depends on and the
scan mode they buy you; phase 2 reads the installed state and reports anything that has
[drifted](/reference/glossary/#drift). On a machine with the scanners present and nothing wrong, the
whole run is short:

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed state is healthy — no findings.
```

The mode line reads `mode : full scan` when `gitleaks` or `trivy` is on your PATH. Without either, it
reads `mode : warn-only (external content not scanned — install gitleaks or trivy)`: agent-rigger
still works, but it cannot scan catalog content before install. That trade-off is covered in
[trust and security](/concepts/trust-and-security/).

Plain doctor is read-only. It exits `0` and writes nothing.

## Provoke a finding

Doctor only speaks up when the installed state and the [manifest](/reference/glossary/#manifest)
disagree. To see a finding without waiting for real drift, fabricate one you can clean up: a
[dangling symlink](/reference/glossary/#symlink), a link whose target does not exist, under your
skills root.

```
ln -s ~/.claude/skills/_gone ~/.claude/skills/ghost-skill
```

Run doctor again:

```
--- agent-rigger doctor ---

✓ git (/opt/homebrew/bin/git)
✓ glab (/opt/homebrew/bin/glab)
✓ gitleaks (/opt/homebrew/bin/gitleaks)
✓ trivy (/opt/homebrew/bin/trivy)

mode : full scan

Installed-state check · 1 finding

Dangling symlinks (1)
  + "/Users/you/.claude/skills/ghost-skill" is a dangling symlink with no manifest entry — removable.  [confirm]
```

Now the command exits `3`. That is doctor's "found something" code: not a crash, a report to read
(see [exit codes](/reference/exit-codes/)). The ghost symlink is still on disk. Diagnosis touched
nothing.

Every finding line ends in a tag that tells you how it can be repaired: `[fix]` for a safe repair,
`[confirm]` for one that needs your per-item confirmation, `[report]` for one doctor will not touch.
Findings are grouped into six classes; the [`doctor` reference](/reference/cli/doctor/#phase-2-installed-state)
lists all of them. The one above is a `dangling` finding, tagged `[confirm]` because removing a
symlink is destructive.

## Repair with --fix

`--fix` applies the repairs the findings carry. The [consent](/reference/glossary/#consent) it needs
depends on the act:

- **Safe repairs (`[fix]`).** Adopting a conforming artifact, deleting staging debris, backing up a
  malformed `state.json`. [`--yes`](/reference/glossary/#yes) grants these; in a terminal without
  `--yes`, each is confirmed.
- **Destructive repairs (`[confirm]`).** Removing a dangling symlink, deleting a phantom store,
  breaking a run-lock, deleting an aged backup. `--yes` never grants these. They are confirmed one
  item at a time in a terminal, and skipped where no one can confirm them.

In an interactive terminal, `doctor --fix` prompts once per item:

![A doctor --fix run against a fabricated broken state. Phase 1 lists four dependencies (git, glab, gitleaks, trivy), all present with a check mark, then the line "mode : full scan". Phase 2 reports two findings: an untracked skill that conforms to its store, tagged as a safe fix, and a dangling symlink with no manifest entry, tagged as needing per-item confirmation. The command then prompts once per item. The first prompt reads "Apply repair?", the second "Confirm repair?"; both start on No, and each is deliberately moved to Yes before confirming. A Repairs section finally lists two ok results: adopting skill:diagnose, then unlinking the ghost symlink.](../../../assets/recordings/doctor-fix.gif)

_A real `doctor --fix` with no `--yes`: each repair is confirmed one item at a time, and every prompt starts on No. Pressing Enter out of reflex skips the repair. The safe adopt is granted the same way as the destructive unlink, which `--yes` alone can never grant. <small>Generated from docs/tapes/doctor-fix.tape, 2026-07-15. Regenerate: bun run build && vhs docs/tapes/doctor-fix.tape.</small>_

Applied repairs are listed under a `Repairs` block. A safe adopt, for example, reports:

```
Repairs
  [ ok  ]  adopt skill:hello-rigger  — adopted "skill:hello-rigger".
```

### In a script

Without a terminal, `doctor --fix` needs `--yes`, and then applies only the safe repairs. Run it
against the ghost symlink from above and nothing is removed: its `[confirm]` repair cannot be
granted in bulk, so it is left in place and the command still exits `3`.

Run `doctor --fix` with no terminal and no `--yes` and it refuses before touching anything:

```
[error] doctor --fix needs an interactive terminal (per-item confirmation), or --yes to apply the safe repairs only.
```

That refusal exits `2`. For the non-interactive contract shared across commands, see
[CI and scripts](/guides/ci-and-scripts/).

### Clean up the ghost

The dangling symlink you made is a `[confirm]` repair, so remove it yourself or confirm it in an
interactive `doctor --fix`:

```
rm ~/.claude/skills/ghost-skill
```

A final `agent-rigger doctor` should print `Installed state is healthy — no findings.` again.

## Check remote sources with --remote

By default phase 2 touches no network. Some drift leaves no trace on disk: a
[guardrail](/reference/glossary/#guardrail) rule, a [context](/reference/glossary/#context) block, or
an [mcp](/reference/glossary/#mcp) server that is present on your host but tracked by no catalog.

`--remote` surfaces those. It fetches every configured [catalog](/reference/glossary/#catalog)'s
content, read-only, and compares it against your host:

```
agent-rigger doctor --remote
```

The fetch is [fail-closed](/reference/glossary/#fail-closed--fail-open): any fetch error stops the
command and names the offending catalog rather than quietly falling back to a disk-only scan. Give
the run credentials for your catalogs. `--remote` combines with `--fix`, and the reference documents
the extra exit codes the network step can return.

For the full contract (every finding class, every flag, and the complete exit-code table), see the
[`doctor` reference](/reference/cli/doctor/).
