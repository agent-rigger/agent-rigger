---
title: Trust and security
description: "Why agent-rigger treats every catalog as untrusted content, your own included: what it does about it, and where its protections stop."
---

agent-rigger installs files that control how your AI assistant behaves, and it fetches them
from a git repository someone can push to. That makes the content untrusted by default,
your own [catalog](/reference/glossary/#catalog) included: a single compromised account is
enough to change what a whole team installs. What follows is the trust model built on that
assumption, stated together with its limits, because a protection you overestimate is worse
than one you understand.

## The starting assumption: catalog content is untrusted

Everything a remote catalog carries is treated as hostile until checked: the artifact
files, `catalog.json` itself, and the `check` command strings it declares. This holds even
for a catalog your own team maintains. The point is not to distrust your colleagues but to
survive the case where an account is taken over or a repository is tampered with. From that
one assumption, [untrusted content](/reference/glossary/#untrusted-content), the rest of
the model follows.

## Nothing lands on disk unscanned

Before any fetched content is copied into place, it is [scanned](/reference/glossary/#scan--scanner)
by external tools: gitleaks for leaked secrets, trivy for misconfigurations. The scan
covers all fetched content without exception, including `catalog.json` itself, since a
secret hardcoded into the catalog file or a hostile `check` string is exactly the kind of
thing an attacker would place there. A blocking finding — any leaked secret, or a
high/critical misconfiguration — blocks the install. The scan runs at a single gate, before
any of it is copied into place, so untrusted content never lands first and gets checked
second.

## Nothing runs without confirmation, and consent is granular

Two separate protections cover execution.

First, every install shows a [plan](/reference/glossary/#plan-dry-run) and waits for you to
confirm before writing anything. You approve a change you can read.

Second, a catalog's `check` command is arbitrary shell, sourced from untrusted content.
Confirming the install plan is not by itself consent to run those commands, so that consent
is asked for separately and remembered in a ledger, `consent.json`, keyed by the pair of
the artifact's id and the exact command string. An unchanged command under the same id is
never re-prompted; change either the command or the id and consent is asked again, even if
the catalog's version is unchanged. What the match ignores is the catalog sha: bumping the
version alone never re-prompts, while editing what actually runs always re-earns your
approval.

## Symlinks in cloned content are rejected

Content cloned from a catalog is refused, before any file is written, if it is or contains
a symlink. The reason is specific: the scanners do not follow symlinks, so a malicious link
such as `secret -> ~/.ssh/id_rsa` passes the scan empty-handed. Were it then copied into
the [store](/reference/glossary/#store), the install's own symlink would re-expose whatever host path it points at. This
is a hard, fail-closed rejection, made before the offending content is touched.

## Secrets by reference, never by value

A catalog never stores a secret value. Where a secret is needed, the config holds an
[environment reference](/reference/glossary/#secret-by-environment-reference-var) in the
exact form `${VAR_NAME}`. A literal value in one of those fields is rejected when the
catalog is parsed, before any scanner even runs, so the leak is closed at the earliest
possible point. At install time the tool checks only that the variable is present, then
writes the assistant's own reference form into the config; the real value is never written
into any file the tool produces. The assistant itself reads the variable when it starts the
server, so rotating it takes effect without a reinstall. At install you map the reference to
a real variable with `--secret-env`.

## Provenance is re-verified after the clone

A version is resolved from a [tag](/reference/glossary/#tag) to an exact
[sha](/reference/glossary/#sha) before the clone. After the clone, the tool checks the
commit actually on disk against the sha it resolved. If they differ, the install is
refused. This closes two real vectors: a branch sharing a name with a tag (git clone
prefers the branch, so the wrong content would arrive under the tag's name), and a tag
re-pushed to a different commit between the resolution and the clone.

This check is not a scan-policy decision, and `--force` does not bypass it. A mismatched
sha is not unscanned content: it is content that is not the version the
[manifest](/reference/glossary/#manifest) is about to claim it is. The tool says so in the failure, verbatim: `Installation refused — this
check cannot be bypassed with --force.`

## The limits, stated plainly

A security model is only honest if it names what it does not do.

- **Without a scanner installed, the tool cannot scan.** Rather than block every install on
  a host that happens to lack gitleaks and trivy, it switches to
  [warn-only](/reference/glossary/#warn-only): the install proceeds, a warning tells you the
  content was not scanned, and [doctor](/reference/glossary/#doctor) surfaces the degraded
  state afterwards. This is a deliberate exception to the fail-closed default, because the
  scanners are optional dependencies. It also means an install done on such a host carried
  no scan at all.
- **A scanner does not catch a malicious script.** gitleaks and trivy find leaked
  credentials and misconfigurations, not intent. A script written to hide what it does, for
  example an obfuscated `curl … | sh`, passes them. You remain responsible for the catalogs
  you configure and the content you accept.
- **On opencode, a `read` deny is defense-in-depth, not a wall.** opencode sub-agents
  invoked through the Task tool bypass `read` and `grep` deny rules (opencode issue #32024).
  Treat the read side of a guardrail as one layer rather than a guarantee that a secret is
  unreadable. The `edit` and `external_directory` denies are not affected by this.

## What `--force` does, and does not, cover

[`--force`](/reference/glossary/#force) overrides a blocking security finding and installs
anyway. It is a deliberate, explicit choice to accept a scan risk on your own judgment,
and it is the single override of the fail-closed gate on findings.

<details>
<summary>Diagram: The trust gates</summary>

![The trust gates fetched content clears before anything is written, in execution order: provenance (HEAD sha re-verified against the resolved sha, refused with exit 2), scan (gitleaks and trivy, blocking finding exits 1 or warn-only when no scanner is installed), plan confirmation, and per-command consent recorded in a ledger — with --force covering only the scan gate and never the provenance gate.](../../../assets/diagrams/trust-gates.svg)

_The gates every fetched artifact clears before a byte is written. `--force` overrides only the scan gate; the provenance re-check is never bypassable. <small>Generated from packages/core/src/scan.ts, packages/catalog/src/fetch.ts, packages/core/src/consent.ts, packages/cli/src/remote-install.ts, 2026-07-12.</small>_

</details>

It stops there. `--force` does not override the provenance re-check: content whose sha does
not match its resolved ref is refused regardless. So `--force` lets you install content the
scanner objected to, on your own judgment. It never lets you install content that is not
the version it claims to be.

## Next

- See how a bad `check` returns [exit codes](/reference/exit-codes/) a script can react to.
- Look up any term in the [glossary](/reference/glossary/).
