#!/usr/bin/env bash
# Render the Homebrew formula from agent-rigger.rb.tmpl, filling the version and
# the per-platform sha256 sums produced by the release build.
#
#   render-formula.sh <version> <SHA256SUMS.txt> > Formula/agent-rigger.rb
#
#   <version>         release version WITHOUT the leading "v" (e.g. 0.1.0).
#   <SHA256SUMS.txt>  the checksums file from the release ("<sha>  <filename>" per line).
set -euo pipefail

VERSION="${1:?usage: render-formula.sh <version> <SHA256SUMS.txt>}"
SUMS="${2:?usage: render-formula.sh <version> <SHA256SUMS.txt>}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Exact-match the filename column (field 2) so darwin-x64 never matches arm64, etc.
sha_for() { awk -v f="agent-rigger-$1" '$2 == f { print $1 }' "$SUMS"; }

DA="$(sha_for darwin-arm64)"
DX="$(sha_for darwin-x64)"
LA="$(sha_for linux-arm64)"
LX="$(sha_for linux-x64)"

for pair in "darwin-arm64:$DA" "darwin-x64:$DX" "linux-arm64:$LA" "linux-x64:$LX"; do
  if [ -z "${pair#*:}" ]; then
    echo "render-formula: missing sha256 for agent-rigger-${pair%%:*} in $SUMS" >&2
    exit 1
  fi
done

sed \
  -e "s/__VERSION__/${VERSION}/g" \
  -e "s/__SHA_DARWIN_ARM64__/${DA}/g" \
  -e "s/__SHA_DARWIN_X64__/${DX}/g" \
  -e "s/__SHA_LINUX_ARM64__/${LA}/g" \
  -e "s/__SHA_LINUX_X64__/${LX}/g" \
  "$HERE/agent-rigger.rb.tmpl"
