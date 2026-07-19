---
title: Install from a catalog
description: Install artifacts from a configured catalog interactively or by qualified id, choose the scope, and act on the plan's scan and tool-check prompts.
---

You have a catalog configured and you want its artifacts on this machine. This guide covers the
interactive picker, one-command installs by id, choosing the scope, and the two decision points the
plan can put in front of you. For a first run end to end, see
[getting started](/start/getting-started/). For the complete flag surface, see the
[`install` reference](/reference/cli/install/).

<details>
<summary>Diagram: The install pipeline</summary>

![Install pipeline: fetch (shallow clone at the resolved tag to sha), scan with gitleaks and trivy, resolve requires and packs, show the plan, human confirmation, back up touched files as .bak-*, apply the WriteOps, then write the manifest — with a blocking scan finding exiting 1 before any write and a refused plan exiting 0.](../../../assets/diagrams/install-pipeline.svg)

_What a run does between your command and the manifest, and the two exits a decision can take: a blocking scan finding stops before any write (exit 1), and refusing the plan writes nothing (exit 0). <small>Generated from packages/cli/src/remote-install.ts, 2026-07-12.</small>_

</details>

## Install interactively

Run install with no ids:

```
rigger install
```

It asks for the [scope](/reference/glossary/#scope) (unless you passed `--scope`), then shows a
grouped picker that classifies every entry against what you already have:

- **To install**: entries not yet installed.
- **To update**: entries installed at an older version, shown as `old → new`.
- **Up to date (check to reinstall)**: entries already current. Left unchecked; tick one only to
  force a reinstall — a [pack](/reference/glossary/#pack) whose members are all current lands here
  too, and ticking it reinstalls every member.

To-update rows always come pre-checked. To-install rows do too, unless the catalog declares
[`recommended`](/reference/glossary/#recommended): once it does, only its `required` and
`recommended` entries start checked in that group, and the rest are listed unchecked. Space on a
group header toggles the whole group at once — the way to check all of "To install" regardless of
the catalog's opinion. Confirm your selection, review the [plan](/reference/glossary/#plan-dry-run),
then approve it to write. When every entry is already current for the chosen scope, install skips
the picker and tells you so:

```
✓ Everything already up-to-date for scope "user" (N artifact(s) installed). Use `rigger remove` to uninstall.
```

A [pack](/reference/glossary/#pack) itself is never recorded as installed — it expands into its
members at install time — but its row here follows those members: current when every one of them
is, `To update` when one has drifted, `To install` when one is missing. A pack made only of
[tools](/reference/glossary/#tool) is the exception: tool installs aren't tracked yet, so that row
keeps showing "To install" regardless.

![Terminal recording of `rigger install` with no ids against the jr catalog. It asks "Select installation scope:" and the user keeps the default, user (~/.claude/). A grouped picker "Select artifacts to install / update (Space on a group header toggles the whole group):" opens with a single "To install" group: the catalog's required pack (pack:secu) and recommended pack (pack:baseline) start checked while every other entry starts unchecked — the B4 fix. The user arrows down and checks a single entry, agent:tdd-coach, with Space, then arrows down to pack:secu and pack:baseline and unchecks both — overriding the catalog's opinion. Enter submits the selection. "Apply the following plan?" shows a one-change plan installing jr/agent:tdd-coach to ~/.claude/agents/tdd-coach.md; the user confirms by pressing y. The run ends with the --- Plan --- and --- Result --- sections and "&#91;ok&#93; Applied 1 file(s)."](../../../assets/recordings/install-picker.gif)

_The interactive install picker: scope choice, the catalog's required and recommended entries pre-checked, then a manual override and apply. <small>Generated from docs/tapes/install-picker.tape, 2026-07-14.</small>_

## Install specific artifacts in one command

When you already know what you want, pass [qualified ids](/reference/glossary/#qualified-id) in the
form `<catalog>/<nature>:<name>`:

```
rigger install example/skill:hello-rigger example/agent:demo --yes
```

`--yes` skips the confirmation prompt. Find the exact ids with `rigger ls`, whose first column
is the qualified id:

```
Catalog (7 entries):
  [available]  example/skill:hello-rigger  skill
  [available]  example/agent:demo          agent
  [available]  example/guardrail:demo      guardrail
  [available]  example/pack:demo           pack       (2 members)
```

A bare id is rejected before any network access:

```
[error] unqualified id "skill:hello-rigger" — use `<catalog>/skill:hello-rigger` (see `rigger ls`)
```

So is a prefix that names no configured catalog:

```
[error] catalog "<prefix>" not configured — see `rigger catalog ls`
```

Without `--yes`, the command shows the plan and waits for your confirmation:

```
--- Plan ---
Plan · 2 changes · scope: user (~/.claude)

+ example/skill:hello-rigger   ~/.claude/skills/hello-rigger
  link  ~/.claude/skills/hello-rigger → store

+ example/agent:demo   ~/.claude/agents/demo.md
  link  ~/.claude/agents/demo.md → store

Σ  2 links
```

## Choose where it lands

Pass `--scope`:

- `--scope user` (the default): machine-wide, under your home directory.
- `--scope project`: the current repository only.

If you install into a project that is a git repository, the plan warns you before writing so you can
decide whether those files belong in version control:

```
[warning] This directory is a git repo — files written here will appear
          in version control. Commit or .gitignore them intentionally.
```

## When the plan raises a scan warning

Catalog content is [untrusted](/reference/glossary/#untrusted-content) and
[scanned](/reference/glossary/#scan--scanner) before it reaches disk. Three outcomes need a decision.

No scanner installed: the scan cannot run, so install proceeds and warns.

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

If you want the content scanned, install gitleaks or trivy, then re-run.

One scanner installed, nothing found: the tool that ran found nothing, but the other one is
missing, so the scan only covers half the ground. Install proceeds and names the gap:

```
[warning] content partially scanned — trivy not installed (gitleaks ran); install trivy then re-run for a full scan; see `rigger doctor`
```

(The reverse holds too: with trivy installed and gitleaks missing, the warning names gitleaks as
absent and trivy as the one that ran.) Install the missing tool if you want a full scan.

A scanner found something: with a scanner present and a real finding, install stops and writes
nothing — this takes priority even when the other scanner is missing, so a blocking finding never
shows the partial-scan warning instead.

```
Security scan blocked installation. Findings:
  - <finding>

Re-run with --force to install anyway.
```

Read the finding first. If it is a false positive you accept, re-run with `--force` (see below).

![Terminal recording. `rigger install trapped/skill:scan-demo --assistant claude` runs against the trapped-catalog fixture, whose skill carries a planted, fake AWS access key id. The composite scanner (gitleaks) flags it, so the install fails closed before writing anything: the output shows &#91;error&#93; Security scan blocked installation. Findings:, then a single finding — &#91;gitleaks&#93; aws-access-token on the skill's `SKILL.md` in the fetched checkout — then `Re-run with --force to install anyway.` The process exits 1 and nothing is installed.](../../../assets/recordings/scan-blocked.gif)

_A real run of the fail-closed scan gate: the finding stops the install before any file is written; only `--force`, after you have read the finding, would override it. <small>Generated from docs/tapes/scan-blocked.tape, 2026-07-14.</small>_

## When the plan lists a tool presence-check

If your selection pulls in a [tool](/reference/glossary/#tool), the plan lists its `check` command
under its own block so you can read the command before anything runs:

```
--- Tool presence-checks (run after you confirm) ---
  <id>  →  <check command>
```

Confirming the plan is a separate decision from agreeing to run that command. After you confirm, a
second prompt asks for [consent](/reference/glossary/#consent):

```
Run the following tool presence-checks?
```

Granting it records the decision in the consent ledger, so the same command under the same id is
never asked again. Under `--yes`, confirming the plan carries this consent. Refuse it and no command
runs: the tool is reported as unverified and the install still completes.

## When `--force` is legitimate

[`--force`](/reference/glossary/#force) overrides a blocking scan finding and installs anyway.
Reach for it only after you have read the finding and judged it safe. It widens nothing else:

- It does not bypass a provenance check. A `ref`/`sha` mismatch still refuses the install (exit
  `2`).
- It does not create a missing catalog or resolve an unknown id. Those you correct, you do not force
  them.

For what each step does and why the content is treated as hostile, see
[trust and security](/concepts/trust-and-security/).
