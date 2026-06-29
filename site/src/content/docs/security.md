---
title: Security
description: How agent-rigger scans fetched content, and what the scan does and does not cover.
---

agent-rigger installs harness configuration fetched from a remote catalog. Two
properties define its security posture.

## Fetched content is scanned before it lands on disk

Remote `external` artifacts are scanned with gitleaks and/or trivy. The check is
**fail-closed**: with no scanner installed, a remote install is blocked unless
you pass `--force`. All fetched content is scanned uniformly — there is no
trusted built-in exception.

## The scan covers secrets and misconfiguration, not arbitrary behaviour

It catches leaked credentials and misconfigurations, **not** behavioural
analysis of a malicious script. You are responsible for the catalogs you
configure and the content you install with `--force`.

## Invariants

These hold across every command:

- **Idempotence** — running `install` twice leaves the same state as running it
  once. An up-to-date plan produces zero writes.
- **Backup before write** — every existing file is copied to `.bak-<timestamp>`
  before being overwritten. No data is lost silently.
- **Human-in-the-loop** — `install` never writes without explicit confirmation.
  The plan is shown first; declining writes nothing.
- **No silent failures** — every error maps to an actionable message and a
  non-zero exit code. The process never exits 0 on a partial failure.

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting on the
[repository](https://github.com/agent-rigger/agent-rigger/security/advisories/new).
See `SECURITY.md` for the full policy.
