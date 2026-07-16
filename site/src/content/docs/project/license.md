---
title: License
description: "agent-rigger is Apache-2.0: what that lets you do, the conditions attached, and the disclaimer that ships with it. The LICENSE file in the repository is the version that governs."
---

agent-rigger is released under the Apache License, Version 2.0. In plain terms, you may use
it, read its source, change it, and pass it on — for personal, commercial, or internal work —
provided you keep the notices the license asks you to keep.

It is a summary, not the license itself. The wording on this page has no legal force. The only
version that governs is the [`LICENSE` file in the repository](https://github.com/agent-rigger/agent-rigger/blob/main/LICENSE);
where anything here differs from that file, the file wins. This page is not legal advice. If you
need a determination for your own situation, read the license text and consult someone qualified.

The copyright notice reads `Copyright 2026 Jonathan Robic`.

## What the license lets you do

| You may                    | Under Apache-2.0                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Use the software           | For any purpose, including commercial and internal use, at no charge.                                       |
| Read and modify the source | The [harness](/reference/glossary/#harness) configuration and the CLI source are open; you can change them. |
| Redistribute it            | With or without your modifications, in source or compiled form.                                             |
| Sublicense and combine     | Bundle it into a larger work and distribute that work under your own terms.                                 |
| Rely on a patent grant     | Each contributor grants a royalty-free patent license covering their contributions.                         |

The patent grant has one condition attached by the license itself: if you start patent
litigation claiming the software infringes a patent, the patent license you were granted for it
ends. That is a term of Apache-2.0, stated here only so the summary is not misleading.

## The conditions attached

The permissions come with a small set of obligations that apply when you redistribute the
software or a work derived from it:

- **Include the license.** Give anyone you distribute to a copy of the Apache-2.0 license.
- **Keep the notices.** Retain the existing copyright, patent, trademark, and attribution
  notices found in the source.
- **Preserve `NOTICE`.** If a distribution includes a `NOTICE` file, carry its attribution text
  through to your distribution.
- **State your changes.** Mark any files you modified as changed.

You may add your own copyright statement to your modifications and offer them under additional
or different terms, as long as your use of the original work still complies with Apache-2.0.

The license does not grant permission to use the licensor's trade names, trademarks, or product
names, beyond the customary use needed to describe where the software came from.

## Disclaimer

The software is distributed with the disclaimer below. It carries the project's own caveats
alongside the "AS IS" terms of the license; what is binding lives in the `LICENSE` and
`DISCLAIMER.md` files of the repository, not on this page.

### No warranty

The software is provided "AS IS", without warranty of any kind, express or implied, including
merchantability, fitness for a particular purpose, and non-infringement. The entire risk as to
the quality and performance of the software is with you.

### Limitation of liability

In no event are the authors or copyright holders liable for any claim, damages, or other
liability, whether in contract, tort, or otherwise, arising from the software or its use. This
covers direct, indirect, incidental, special, exemplary, and consequential damages, including
loss of data, loss of profits, and business interruption.

### Precompiled binaries

The release binaries and bundled distributions are provided for convenience and are covered by
the same Apache-2.0 license as the source. They come with no warranties or conditions of any
kind. Verifying the integrity and suitability of a binary before use is your responsibility;
verify checksums when they are available. (The Homebrew formula, for instance, pins a SHA-256
checksum per platform.)

### Third-party dependencies

The software incorporates third-party open-source components, each governed by its own license.
The authors make no representations or warranties about these dependencies and accept no
liability for issues arising from them.

### Use at your own risk

agent-rigger reads from and writes to your [AI coding assistant](/reference/glossary/#assistant) harness configuration
(for example `~/.claude`) and your file system, and can run external commands on your behalf. Making
sure its use fits your environment — and complies with any policies, regulations, or agreements
that apply to you — is your responsibility. The authors are not responsible for unintended side
effects of its use. Review what will be installed or removed before you confirm any operation.

## Where the authoritative text lives

Two files in the repository carry the binding text:

- [`LICENSE`](https://github.com/agent-rigger/agent-rigger/blob/main/LICENSE) — the full Apache
  License 2.0 under which the software is distributed.
- [`DISCLAIMER.md`](https://github.com/agent-rigger/agent-rigger/blob/main/DISCLAIMER.md) — the
  disclaimer summarised above.

If this page and either file disagree, the file is correct.
