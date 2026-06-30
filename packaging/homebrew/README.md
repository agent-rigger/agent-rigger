# Homebrew distribution

`agent-rigger` ships as a single self-contained binary, so the Homebrew formula
just downloads the right release asset and installs it — no build step.

## How it works

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) (triggered
by a `v*` tag) runs two jobs:

1. `release` — builds the per-platform binaries and a `SHA256SUMS.txt`, then
   publishes the GitHub Release with those assets.
2. `formula` (`needs: release`) — renders
   [`agent-rigger.rb.tmpl`](./agent-rigger.rb.tmpl) with the released version +
   checksums (via [`render-formula.sh`](./render-formula.sh)) and pushes the
   result to `Formula/agent-rigger.rb` in the tap repo.

The formula step lives **inside the release workflow**, not in a separate
`on: release` workflow: GitHub does not fire workflows for events emitted by the
`GITHUB_TOKEN` (the release is published with that token), so an `on: release`
trigger would never run. Keeping both jobs in one run sidesteps that.

The `formula` job is a **no-op until the tap is set up** — it skips when the
`HOMEBREW_TAP_TOKEN` secret is absent, so it never blocks a release.

## One-time setup (org admin)

1. Create a public repo **`agent-rigger/homebrew-tap`** (the `homebrew-` prefix
   is required by Homebrew's tap convention).
2. Create a token with **contents:write** on that repo (a fine-grained PAT or a
   deploy key) and add it to **this** repo's Actions secrets as
   `HOMEBREW_TAP_TOKEN`.
3. Cut a release (`git tag v0.1.0 && git push origin v0.1.0`). The Homebrew job
   populates `Formula/agent-rigger.rb` in the tap.

## Install (end users)

Once the tap is populated:

```sh
brew tap agent-rigger/tap
brew install agent-rigger      # provides `agent-rigger` and the `rigger` alias
```

Fallback before the tap exists (installs straight from a rendered formula URL):

```sh
brew install --formula \
  https://raw.githubusercontent.com/agent-rigger/homebrew-tap/main/Formula/agent-rigger.rb
```

Coverage: macOS (arm64 + x64) and Linux (arm64 + x64). Windows users take the
`agent-rigger-windows-x64.exe` asset from the release directly.

## Updating the template

Edit [`agent-rigger.rb.tmpl`](./agent-rigger.rb.tmpl) (placeholders: `__VERSION__`,
`__SHA_DARWIN_ARM64__`, `__SHA_DARWIN_X64__`, `__SHA_LINUX_ARM64__`,
`__SHA_LINUX_X64__`). Render locally to sanity-check:

```sh
packaging/homebrew/render-formula.sh 0.1.0 path/to/SHA256SUMS.txt
```
