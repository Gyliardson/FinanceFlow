#!/usr/bin/env bash
set -euo pipefail

shared_scan=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/secret_scan_history.sh
[[ -f "$shared_scan" ]] || { echo 'shared production scanner helper is missing' >&2; exit 1; }
[[ -n "${GITLEAKS_BIN:-}" && -x "${GITLEAKS_BIN}" ]] || { echo 'GITLEAKS_BIN is unavailable' >&2; exit 1; }

source_root=$(git rev-parse --show-toplevel)
readonly expected_ignore='68bc951e2c0c4017983bded88fc92186258154bd:mobile/tests/idempotent-mutation-contract.cjs:generic-api-key:213'
# Construct the GitHub-PAT-shaped synthetic marker only at runtime. Keeping the
# complete detector-shaped string out of FinanceFlow commits prevents the probe
# itself from becoming a permanent full-history finding.
readonly sentinel_prefix='ghp'
readonly sentinel_body='A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
readonly sentinel="${sentinel_prefix}_${sentinel_body}"

mapfile -t source_ignores < <(awk '{ sub(/[[:space:]]+$/, ""); if ($0 !~ /^[[:space:]]*(#|$)/) print }' "$source_root/.gitleaksignore")
[[ ${#source_ignores[@]} -eq 1 ]] || { echo 'production .gitleaksignore has unexpected active entries' >&2; exit 1; }
[[ "${source_ignores[0]}" == "$expected_ignore" ]] || { echo 'production .gitleaksignore is broader/different than the approved fingerprint' >&2; exit 1; }
[[ "$expected_ignore" != *"$sentinel"* ]] || { echo 'test sentinel unexpectedly appears in approved ignore' >&2; exit 1; }

probe=$(mktemp -d)
shallow=''
cleanup() {
  rm -rf "$probe"
  [[ -z "$shallow" ]] || rm -rf "$shallow"
}
trap cleanup EXIT

git -C "$probe" init -q -b main
git -C "$probe" config user.name 'FinanceFlow Secret Scan Probe'
git -C "$probe" config user.email 'secret-scan-probe@example.invalid'
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'
export GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'

cp "$source_root/.gitleaksignore" "$probe/.gitleaksignore"
printf 'baseline\n' > "$probe/baseline.txt"
git -C "$probe" add .gitleaksignore baseline.txt
git -C "$probe" commit -q -m 'probe: baseline before stale endpoint'
stale_head=$(git -C "$probe" rev-parse HEAD)

git -C "$probe" switch -q -c historical-feature
printf 'TEST_ONLY_GITLEAKS_SENTINEL=%s\n' "$sentinel" > "$probe/sentinel.env"
git -C "$probe" add sentinel.env
git -C "$probe" commit -q -m 'probe: introduce synthetic gitleaks marker'
sentinel_commit=$(git -C "$probe" rev-parse HEAD)
rm "$probe/sentinel.env"
git -C "$probe" add -u
git -C "$probe" commit -q -m 'probe: remove synthetic marker before merge'

git -C "$probe" switch -q main
printf 'candidate advances after stale endpoint\n' >> "$probe/baseline.txt"
git -C "$probe" add baseline.txt
git -C "$probe" commit -q -m 'probe: advance candidate after stale endpoint'
git -C "$probe" merge -q --no-ff historical-feature -m 'probe: merge historical ancestry'
printf 'candidate head\n' > "$probe/head.txt"
git -C "$probe" add head.txt
git -C "$probe" commit -q -m 'probe: final candidate head'
candidate=$(git -C "$probe" rev-parse HEAD)

[[ "$candidate" != "$stale_head" ]] || { echo 'probe failed to advance candidate' >&2; exit 1; }
git -C "$probe" merge-base --is-ancestor "$sentinel_commit" "$candidate"
if git -C "$probe" rev-list --first-parent "$candidate" | grep -qx "$sentinel_commit"; then
  echo 'sentinel commit unexpectedly appears on first-parent history' >&2
  exit 1
fi
if git -C "$probe" cat-file -e "$candidate:sentinel.env" 2>/dev/null; then
  echo 'synthetic sentinel unexpectedly remains in candidate working tree' >&2
  exit 1
fi

run_scan_capture() {
  local expected_status=$1
  local head_sha=$2
  local report_path=$3
  local log_path=$4

  git -C "$probe" switch -q --detach "$head_sha"
  set +e
  bash "$shared_scan" "$probe" "$head_sha" "$report_path" >"$log_path" 2>&1
  local status=$?
  set -e
  cat "$log_path"
  if [[ "$status" -ne "$expected_status" ]]; then
    echo "unexpected shared scanner status: got=$status expected=$expected_status head=$head_sha" >&2
    exit 1
  fi
}

# Deliberately stale mutation equivalent to #178: the scanner is pointed at an
# earlier PR endpoint instead of the current candidate. The marker is outside
# that reachable set, so this control stays green and demonstrates the gap.
stale_report="$probe/stale.sarif"
stale_log="$probe/stale.log"
run_scan_capture 0 "$stale_head" "$stale_report" "$stale_log"
python3 - "$stale_report" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
if payload["runs"][0]["results"]:
    raise SystemExit("stale mutation unexpectedly detected a finding")
PY
printf 'REGRESSION_STALE_ENDPOINT=%s\n' "$stale_head"
printf 'REGRESSION_STALE_SCOPE=missed-sentinel-as-expected\n'

# Correct contract: exact candidate HEAD with all reachable ancestry. The marker
# is absent at HEAD and outside first-parent history, but remains recoverable and
# therefore must produce the expected non-zero Gitleaks finding status.
correct_report="$probe/correct.sarif"
correct_log="$probe/correct.log"
run_scan_capture 2 "$candidate" "$correct_report" "$correct_log"
python3 - "$correct_report" "$sentinel_commit" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding="utf-8"))
sentinel_commit = sys.argv[2]
results = payload["runs"][0]["results"]
if not results:
    raise SystemExit("correct scope produced no findings")
matching = [
    item for item in results
    if item.get("partialFingerprints", {}).get("commitSha") == sentinel_commit
]
if not matching:
    raise SystemExit("finding is not bound to the synthetic sentinel commit")
if not any(item.get("ruleId") == "github-pat" for item in matching):
    raise SystemExit("synthetic marker was not detected by the expected github-pat rule")
PY
printf 'REGRESSION_CANDIDATE_HEAD=%s\n' "$candidate"
printf 'REGRESSION_SENTINEL_COMMIT=%s\n' "$sentinel_commit"
printf 'REGRESSION_CORRECT_SCOPE=detected-sentinel\n'
printf 'REGRESSION_MERGED_ANCESTRY=covered\n'
printf 'REGRESSION_REMOVED_HISTORICAL_MARKER=covered\n'
printf 'REGRESSION_ALLOWLIST_SCOPE=single-fingerprint-only\n'

# Missing/mismatched candidate HEAD must fail closed rather than silently scan
# whichever commit happens to be checked out.
git -C "$probe" switch -q --detach "$stale_head"
set +e
bash "$shared_scan" "$probe" "$candidate" "$probe/head-mismatch.sarif" >"$probe/head-mismatch.log" 2>&1
head_mismatch_status=$?
set -e
cat "$probe/head-mismatch.log"
[[ "$head_mismatch_status" -eq 70 ]] || { echo "head mismatch did not fail closed: $head_mismatch_status" >&2; exit 1; }
printf 'REGRESSION_MISSING_CANDIDATE_HEAD=fail-closed\n'

# A shallow checkout cannot satisfy an all-reachable-history contract.
git -C "$probe" switch -q main
shallow=$(mktemp -d)
rm -rf "$shallow"
git clone -q --depth=1 --branch main "file://$probe" "$shallow"
shallow_head=$(git -C "$shallow" rev-parse HEAD)
set +e
bash "$shared_scan" "$shallow" "$shallow_head" "$shallow/shallow.sarif" >"$probe/shallow.log" 2>&1
shallow_status=$?
set -e
cat "$probe/shallow.log"
[[ "$shallow_status" -eq 70 ]] || { echo "shallow history did not fail closed: $shallow_status" >&2; exit 1; }
printf 'REGRESSION_SHALLOW_HISTORY=fail-closed\n'

printf 'SECRET_SCAN_REGRESSION_PROOF=pass\n'
