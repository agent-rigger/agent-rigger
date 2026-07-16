---
title: Security policy
description: "Which versions get security fixes, how to report a vulnerability privately, and what agent-rigger's scan does and does not protect against."
---

agent-rigger installs harness configuration fetched from a remote
[catalog](/reference/glossary/#catalog) — files that control how your AI assistant behaves.
That places security at the centre of the tool, so this page states the policy plainly: which
versions receive fixes, how to report a problem without exposing it, and where the built-in
protections stop. For the reasoning behind the design, see
[trust and security](/concepts/trust-and-security/).

## Supported versions

agent-rigger is pre-1.0. Security fixes go only to the
latest `main` and the most recent tagged release. There is no backport guarantee for older
versions: upgrade to the latest before reporting, so a fix does not land on a version you are
not running.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** A public issue discloses the
problem before there is a fix.

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/agent-rigger/agent-rigger/security/advisories/new)
(Security → Advisories → _Report a vulnerability_).

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal case if possible),
- the affected version or commit.

You can expect an acknowledgement within a few days. Once triaged, the issue is confirmed, a
disclosure timeline is agreed, and you are credited in the advisory unless you prefer to stay
anonymous.

## Scope and threat model

Content fetched from a remote catalog is treated as untrusted — your own catalog included,
because a single compromised account can change what a whole team installs. Two properties
define what the tool does about that, and two limits define what it does not.

### Fetched content is scanned before it reaches your harness

Everything fetched from a remote catalog, `catalog.json` included, is
[scanned](/reference/glossary/#scan--scanner) with gitleaks and/or trivy before any file is
written into your harness. There is no trusted built-in exception. The scan runs at a single gate, before the
plan is applied, so nothing is copied first and checked second.

A blocking finding stops the install
([fail-closed](/reference/glossary/#fail-closed--fail-open)). Without
[`--force`](/reference/glossary/#force), the command exits and
writes nothing:

```
Security scan blocked installation. Findings:
<findings>

Re-run with --force to install anyway.
```

### Warn-only when no scanner is installed

gitleaks and trivy are optional dependencies. If neither is present on the host, the tool
cannot scan. Rather than block every install on such a host, it degrades to
[warn-only](/reference/glossary/#warn-only): the install proceeds and prints a warning.

```
[warning] content not scanned — install gitleaks or trivy then re-run for a full scan; see `rigger doctor`
```

[`rigger doctor`](/reference/glossary/#doctor) surfaces the same degraded state afterwards, so
you can tell whether a host has been running with a real scan:

```
mode : warn-only (external content not scanned — install gitleaks or trivy)
```

This is the one deliberate exception to the fail-closed default. On a warn-only host, content
that was never scanned can reach your machine. Installing gitleaks or trivy restores the real
scan.

### The scan covers secrets and misconfiguration, not behaviour

gitleaks finds leaked credentials; trivy flags misconfigurations and also reports the
secrets it finds. Neither performs behavioural
analysis of a script. A malicious payload written to hide what it does — an obfuscated
`curl … | sh`, for example — passes both. The scan narrows the attack surface; it does not
certify that content is safe to run.

### You are responsible for `--force` and for what you configure

`--force` overrides a blocking scan finding and installs anyway.
It is a deliberate choice to accept a scan risk on your own judgment. You remain responsible
for the catalogs you configure and for any content you install with `--force`.

Note that `--force` covers the scan gate only. It does not bypass the provenance re-check that
refuses content whose commit does not match the version it claims to be; see
[trust and security](/concepts/trust-and-security/) for that boundary and the rest of the
model.

## In scope for a report

Reports about the boundaries above are in scope and welcome — for example a bypass of the scan
gate, a write outside the declared install location, or a missing backup before an overwrite.
