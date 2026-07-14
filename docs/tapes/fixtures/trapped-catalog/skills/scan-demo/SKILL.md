---
name: scan-demo
description: Trapped skill — exists only to demonstrate agent-rigger's install-time security scan.
---

# scan-demo

This skill is a **fixture**. It has no useful behaviour. Its single purpose is to
carry a planted, fake credential so that installing this catalog is blocked by the
secret scan (gitleaks / trivy) — the fail-closed behaviour documented on
`guides/install-from-catalog.md` (§ scan warning) and filmed by the `scan-blocked`
tape.

The value below is a **FAKE, INERT AWS access key id**. It is not a real
credential: it grants no access, corresponds to no account, and there is nothing
to revoke. It is shaped to match gitleaks' default `aws-access-token` rule on
purpose. Do NOT "fix" or remove it — the demo depends on the scanner flagging
this exact line. The `AKIA…EXAMPLE` canonical value is allow-listed by gitleaks,
so a distinct fake pattern is used instead (validated by `validate.sh`).

<!-- FAKE / INERT / FOR SCAN DEMO ONLY — not a real AWS key, no access, nothing to revoke -->

aws_access_key_id = AKIAQYLPMN5HGXAZ2WVI
