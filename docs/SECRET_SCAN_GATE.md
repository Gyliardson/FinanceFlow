# Secret scan release gate

## Release contract

The required `Secret scan` status proves one precise property:

> Every Git commit reachable from the exact release-candidate HEAD is presented to the pinned Gitleaks scanner, including commits reachable only through merged/second-parent ancestry.

This is intentionally stronger than checking out a repository with `fetch-depth: 0`. History availability is a prerequisite, not evidence that the scanner consumed that history.

The gate does **not** derive its scan endpoint from a pull request's commit-list API, a cached PR range, a first-parent walk, or the synthetic pull-request merge commit. For a pull request it checks out and records `github.event.pull_request.head.sha`; for a push it checks out and records `github.sha`. The shared scanner helper then requires checked-out `HEAD` to equal that exact 40-character SHA.

## Scanner integrity and invocation

The gate builds Gitleaks `8.24.3` from immutable upstream source commit:

`107a41827bb6698dbbff756b2300537774a1d84c`

using Go `1.23.4`. The workflow verifies the source checkout SHA and the built scanner version before any scan.

The production invocation is owned by `.github/scripts/secret_scan_history.sh`. Its Git boundary is:

`--log-opts="--full-history <exact-candidate-head>"`

It deliberately does not add `--first-parent` or `--no-merges` and does not use event-derived base/head pairs.

Before invoking Gitleaks, the helper fails closed unless all of the following hold:

- the candidate is an exact 40-character commit SHA;
- the checked-out HEAD equals that SHA;
- the repository is not shallow;
- the complete reachable object walk succeeds;
- reachable-commit accounting succeeds and is non-empty;
- the scanner is executable and reports exactly the expected version;
- `.gitleaksignore` contains exactly the single approved historical fingerprint.

The raw job log emits the scanner version/source SHA, exact candidate HEAD, declared scope, merged-ancestry flag, reachable commit count, merge count, first-parent count, a SHA-256 digest of the reachable commit list, effective log options, scanner exit code, SARIF size/result count, and final scan result.

## Fail-closed evidence

Gitleaks is run with `--exit-code=2` and SARIF output. The helper treats:

- exit `0` as clean only when a valid non-empty SARIF document contains zero findings;
- exit `2` as a blocking finding only when valid SARIF contains at least one finding;
- any other scanner exit as an error;
- missing, empty, malformed, structurally invalid, or scanner-status-inconsistent SARIF as an error.

There is no successful fallback to a working-tree-only scan and no `continue-on-error` or finding suppression path.

The final `gitleaks-results.sarif` file is uploaded with `if-no-files-found: error`. GitHub Actions artifact metadata binds it to the workflow run and exact candidate SHA. A zero-finding SARIF is evidence of findings only; history coverage must additionally be established from the exact-head/range/count evidence in the raw job log.

## Regression / test-the-test

`.github/scripts/test_secret_scan_history.sh` calls the same production helper used by the real gate. It creates a temporary synthetic Git repository and a non-sensitive, detector-shaped sentinel only at runtime; the complete sentinel never exists in FinanceFlow history.

The synthetic graph proves the regression class from issue #178:

1. a stale endpoint is recorded;
2. a side branch introduces a Gitleaks-detectable sentinel;
3. the sentinel is removed before merge;
4. the side branch is merged with a merge commit;
5. the candidate advances again;
6. scanning the stale endpoint stays clean because the sentinel is unreachable;
7. scanning the exact candidate with the production helper returns the expected finding because the removed sentinel remains reachable through merged ancestry;
8. the finding is bound to the sentinel commit and `github-pat` detector rule;
9. a candidate/checkout mismatch fails closed;
10. a shallow clone fails closed.

The test also verifies that `.gitleaksignore` contains only this existing fingerprint-specific exception:

`68bc951e2c0c4017983bded88fc92186258154bd:mobile/tests/idempotent-mutation-contract.cjs:generic-api-key:213`

No test-only allowlist entry is added.

## Claim-to-evidence requirement

For release certification, the claim:

`All commits in promised secret-scan scope through candidate HEAD are scanned`

must map to:

- gate: `Secret scan` in `FinanceFlow CI`;
- exact run: a workflow run whose head SHA is the candidate SHA being certified;
- raw evidence: exact candidate HEAD, `SECRET_SCAN_SCOPE=all-commits-reachable-from-exact-candidate-head`, `SECRET_SCAN_INCLUDE_MERGED_ANCESTRY=true`, reachable commit count/digest, effective Gitleaks command/log options, validated SARIF metadata, and successful regression proof.

If those artifacts cannot be tied to the same exact candidate SHA, release readiness must not be declared.
