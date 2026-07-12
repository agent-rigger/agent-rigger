# Security Policy

## Supported versions

agent-rigger is pre-1.0 (M0). Only the latest `main` and the most recent tagged
release receive security fixes. There is no backport guarantee for older
versions — upgrade to the latest before reporting.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/agent-rigger/agent-rigger/security/advisories/new)
(Security → Advisories → _Report a vulnerability_).

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal case if possible),
- affected version or commit.

You can expect an acknowledgement within a few days. Once triaged, we will
confirm the issue, agree on a disclosure timeline, and credit you in the
advisory unless you prefer to stay anonymous.

## Scope and threat model

agent-rigger installs harness configuration fetched from a **remote catalog**.
Two properties are central to its security posture:

- **Fetched content is scanned before it lands on disk.** Everything fetched
  from a remote catalog, `catalog.json` included, is scanned with gitleaks
  and/or trivy: there is no trusted built-in exception. A blocking finding
  stops the install unless `--force` is passed (fail-closed on findings).
  A missing scanner is the one deliberate exception to that posture: with
  neither gitleaks nor trivy installed, the scan is degraded, the install
  proceeds with a warning telling you the content was not scanned, and
  `rigger doctor` reports the warn-only mode. On such a host, content that was
  never scanned can reach your machine. Installing gitleaks or trivy restores
  the real scan.
- **The scan covers secrets and misconfiguration, not arbitrary behaviour.** It
  catches leaked credentials and misconfigurations, **not** behavioural analysis
  of a malicious script. You are responsible for the catalogs you configure and
  the content you install with `--force`.

Reports about either of these boundaries — a bypass of the scan, a write outside
the declared scope, a missing backup before overwrite — are in scope and
welcome.
