#!/usr/bin/env bash
set -u -o pipefail

# Shared production/regression entry point for the required Secret scan gate.
# Contract: scan every commit reachable from the exact candidate HEAD, including
# second-parent/merged ancestry. Never derive the boundary from PR event commit
# lists and never reduce it to first-parent history.

readonly EXPECTED_IGNORE_FINGERPRINT_DEFAULT='68bc951e2c0c4017983bded88fc92186258154bd:mobile/tests/idempotent-mutation-contract.cjs:generic-api-key:213'
readonly CONTRACT='all-commits-reachable-from-exact-candidate-head'

fail_closed() {
  printf 'SECRET_SCAN_FAIL_CLOSED=%s\n' "$1" >&2
  exit 70
}

if [[ $# -ne 3 ]]; then
  echo 'usage: secret_scan_history.sh <repo> <exact-candidate-sha> <sarif-report>' >&2
  exit 64
fi

repo=$1
candidate=$2
report=$3
scanner=${GITLEAKS_BIN:-}
expected_version=${GITLEAKS_EXPECTED_VERSION:-}
scanner_source_sha=${GITLEAKS_SOURCE_SHA:-unknown}
expected_ignore=${SECRET_SCAN_REQUIRED_IGNORE_FINGERPRINT:-$EXPECTED_IGNORE_FINGERPRINT_DEFAULT}

[[ -n "$scanner" && -x "$scanner" ]] || fail_closed 'scanner-missing-or-not-executable'
[[ -n "$expected_version" ]] || fail_closed 'expected-scanner-version-missing'
[[ -d "$repo/.git" ]] || fail_closed 'git-repository-missing'
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || fail_closed 'candidate-is-not-an-exact-40-char-sha'

shallow=$(git -C "$repo" rev-parse --is-shallow-repository 2>/dev/null) || fail_closed 'cannot-determine-history-depth'
[[ "$shallow" == 'false' ]] || fail_closed 'history-is-shallow'

resolved=$(git -C "$repo" rev-parse --verify "${candidate}^{commit}" 2>/dev/null) || fail_closed 'candidate-commit-missing'
[[ "$resolved" == "$candidate" ]] || fail_closed 'candidate-sha-did-not-resolve-exactly'

head=$(git -C "$repo" rev-parse HEAD 2>/dev/null) || fail_closed 'cannot-resolve-checked-out-head'
[[ "$head" == "$candidate" ]] || fail_closed "checked-out-head-does-not-match-candidate head=$head candidate=$candidate"

# Walking the complete object graph must succeed before Gitleaks runs. A full
# checkout flag alone is not evidence that all required objects actually exist.
if ! git -C "$repo" rev-list --objects "$candidate" >/dev/null 2>&1; then
  fail_closed 'candidate-history-is-incomplete-or-corrupt'
fi

reachable_count=$(git -C "$repo" rev-list --count "$candidate" 2>/dev/null) || fail_closed 'cannot-count-reachable-commits'
merge_count=$(git -C "$repo" rev-list --merges --count "$candidate" 2>/dev/null) || fail_closed 'cannot-count-merge-commits'
first_parent_count=$(git -C "$repo" rev-list --first-parent --count "$candidate" 2>/dev/null) || fail_closed 'cannot-count-first-parent-commits'
[[ "$reachable_count" =~ ^[1-9][0-9]*$ ]] || fail_closed 'reachable-commit-count-is-invalid'
[[ "$merge_count" =~ ^[0-9]+$ ]] || fail_closed 'merge-commit-count-is-invalid'
[[ "$first_parent_count" =~ ^[1-9][0-9]*$ ]] || fail_closed 'first-parent-count-is-invalid'

commit_list_sha256=$(
  git -C "$repo" rev-list "$candidate" | sha256sum | awk '{print $1}'
) || fail_closed 'cannot-hash-reachable-commit-set'
[[ "$commit_list_sha256" =~ ^[0-9a-f]{64}$ ]] || fail_closed 'reachable-commit-set-hash-is-invalid'

ignore_file="$repo/.gitleaksignore"
[[ -f "$ignore_file" ]] || fail_closed 'gitleaksignore-missing'
mapfile -t active_ignores < <(awk '{ sub(/[[:space:]]+$/, ""); if ($0 !~ /^[[:space:]]*(#|$)/) print }' "$ignore_file")
if [[ ${#active_ignores[@]} -ne 1 || "${active_ignores[0]:-}" != "$expected_ignore" ]]; then
  fail_closed 'gitleaksignore-is-not-the-single-approved-fingerprint'
fi

actual_version=$($scanner version 2>/dev/null) || fail_closed 'scanner-version-command-failed'
actual_version=${actual_version#v}
[[ "$actual_version" == "$expected_version" ]] || fail_closed "scanner-version-mismatch actual=$actual_version expected=$expected_version"

if [[ "$report" != /* ]]; then
  report="$(pwd)/$report"
fi
mkdir -p "$(dirname "$report")" || fail_closed 'cannot-create-report-directory'
rm -f "$report" || fail_closed 'cannot-reset-report-path'

printf 'SECRET_SCAN_SCANNER=gitleaks\n'
printf 'SECRET_SCAN_SCANNER_VERSION=%s\n' "$actual_version"
printf 'SECRET_SCAN_SCANNER_SOURCE_SHA=%s\n' "$scanner_source_sha"
printf 'SECRET_SCAN_CANDIDATE_HEAD=%s\n' "$candidate"
printf 'SECRET_SCAN_SCOPE=%s\n' "$CONTRACT"
printf 'SECRET_SCAN_INCLUDE_MERGED_ANCESTRY=true\n'
printf 'SECRET_SCAN_PR_EVENT_RANGE_DERIVATION=false\n'
printf 'SECRET_SCAN_FIRST_PARENT_ONLY=false\n'
printf 'SECRET_SCAN_REACHABLE_COMMITS=%s\n' "$reachable_count"
printf 'SECRET_SCAN_MERGE_COMMITS=%s\n' "$merge_count"
printf 'SECRET_SCAN_FIRST_PARENT_COMMITS=%s\n' "$first_parent_count"
printf 'SECRET_SCAN_REACHABLE_SET_SHA256=%s\n' "$commit_list_sha256"
printf 'SECRET_SCAN_IGNORE_ENTRIES=%s\n' "${#active_ignores[@]}"
printf 'SECRET_SCAN_LOG_OPTS=--full-history %s\n' "$candidate"
printf 'SECRET_SCAN_COMMAND=%q detect --redact --verbose --exit-code=2 --report-format=sarif --report-path=%q --log-level=debug --log-opts=%q\n' \
  "$scanner" "$report" "--full-history $candidate"

# Capture the scanner status only so we can validate the SARIF before returning
# it. No successful fallback exists: a finding returns 2, any scanner/evidence
# error is converted to fail-closed status 70, and only a clean validated scan
# returns 0.
set +e
(
  cd "$repo" || exit 71
  "$scanner" detect \
    --redact \
    --verbose \
    --exit-code=2 \
    --report-format=sarif \
    --report-path="$report" \
    --log-level=debug \
    --log-opts="--full-history $candidate"
)
scanner_status=$?
set -e

printf 'SECRET_SCAN_SCANNER_EXIT_CODE=%s\n' "$scanner_status"
[[ "$scanner_status" -eq 0 || "$scanner_status" -eq 2 ]] || fail_closed "scanner-error-exit-$scanner_status"
[[ -s "$report" ]] || fail_closed 'sarif-missing-or-empty'

sarif_results=$(python3 - "$report" "$scanner_status" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
scanner_status = int(sys.argv[2])
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"SARIF_VALIDATION_ERROR=malformed-json:{exc}", file=sys.stderr)
    raise SystemExit(70)

if payload.get("version") != "2.1.0":
    print("SARIF_VALIDATION_ERROR=unexpected-version", file=sys.stderr)
    raise SystemExit(70)
runs = payload.get("runs")
if not isinstance(runs, list) or len(runs) != 1:
    print("SARIF_VALIDATION_ERROR=expected-one-run", file=sys.stderr)
    raise SystemExit(70)
driver = runs[0].get("tool", {}).get("driver", {})
if str(driver.get("name", "")).lower() != "gitleaks":
    print("SARIF_VALIDATION_ERROR=unexpected-tool", file=sys.stderr)
    raise SystemExit(70)
results = runs[0].get("results")
if not isinstance(results, list):
    print("SARIF_VALIDATION_ERROR=results-not-a-list", file=sys.stderr)
    raise SystemExit(70)
if scanner_status == 0 and results:
    print("SARIF_VALIDATION_ERROR=clean-exit-with-findings", file=sys.stderr)
    raise SystemExit(70)
if scanner_status == 2 and not results:
    print("SARIF_VALIDATION_ERROR=finding-exit-without-findings", file=sys.stderr)
    raise SystemExit(70)
print(len(results))
PY
) || fail_closed 'sarif-validation-failed'

report_bytes=$(wc -c < "$report" | tr -d '[:space:]') || fail_closed 'cannot-measure-sarif'
[[ "$report_bytes" =~ ^[1-9][0-9]*$ ]] || fail_closed 'sarif-byte-count-is-invalid'
printf 'SECRET_SCAN_SARIF_BYTES=%s\n' "$report_bytes"
printf 'SECRET_SCAN_SARIF_RESULTS=%s\n' "$sarif_results"
printf 'SECRET_SCAN_EVIDENCE_VALID=true\n'

if [[ "$scanner_status" -eq 2 ]]; then
  printf 'SECRET_SCAN_RESULT=findings-detected\n' >&2
  exit 2
fi

printf 'SECRET_SCAN_RESULT=clean\n'
exit 0
