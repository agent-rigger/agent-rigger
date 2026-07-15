#!/usr/bin/env bash
# Validate that the trapped-catalog fixture still trips gitleaks (R3 scenarios 2 & 4).
#
# gitleaks rules vary by version (entropy thresholds, example-key allow-lists); a
# fixture that silently stops triggering would produce a scan-blocked film where
# the install actually succeeds. This script re-plays the documented validation
# and must be run before every `scan-blocked` shoot and by the freshness workflow.
#
# Exit semantics are INVERTED relative to gitleaks: gitleaks exits 1 when it FINDS
# secrets, which is the success condition here. So:
#   exit 0  → fixture triggers the expected finding (safe to record)
#   exit 1  → fixture no longer triggers (STOP: do not record)
#   exit 2  → gitleaks absent on PATH (cannot validate)
set -uo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXPECTED_RULE="aws-access-token"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "ERROR: gitleaks not found on PATH — cannot validate the trapped-catalog fixture." >&2
  echo "Install gitleaks, then re-run. (R3 scenario 4: without a scanner the scan-blocked film must not be produced.)" >&2
  exit 2
fi

echo "gitleaks version: $(gitleaks version 2>/dev/null)"
echo "fixture:          ${FIXTURE_DIR}"
echo "command:          gitleaks detect --no-git --source ${FIXTURE_DIR}"

REPORT="$(mktemp -t trapped-catalog-gitleaks.XXXXXX)"
trap 'rm -f "${REPORT}"' EXIT

gitleaks detect --no-git --source "${FIXTURE_DIR}" \
  --report-format json --report-path "${REPORT}" --log-level error
GL_EXIT=$?

if [ "${GL_EXIT}" -eq 1 ] && grep -q "${EXPECTED_RULE}" "${REPORT}"; then
  COUNT="$(grep -c '"RuleID":' "${REPORT}")"
  echo "OK: gitleaks reported ${COUNT} finding(s), including rule '${EXPECTED_RULE}'. Fixture triggers the scanner."
  exit 0
fi

echo "FAIL: expected gitleaks to report rule '${EXPECTED_RULE}' with exit 1; got exit ${GL_EXIT}." >&2
echo "The fixture no longer trips this gitleaks version — do NOT record the scan-blocked flow until it is fixed (R3 scenario 2)." >&2
exit 1
