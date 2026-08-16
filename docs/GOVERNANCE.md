# FinanceFlow Repository Governance

This document records the repository controls enforced in code and the GitHub repository settings verified for the current release-governance baseline.

## Promotion model

Portfolio professionalization work follows this branch flow:

`main` → `portfolio/revamp-2026` → `work/<issue>-<slug>` → PR → `portfolio/revamp-2026`.

The integration branch is never merged automatically into `main`. The final integration-to-main PR requires maintainer review and, for the current red-team remediation, a separate independent audit.

## CI expectations

Changes should be merged into `portfolio/revamp-2026` only after the applicable exact-head checks pass. The current high-value checks include:

- FinanceFlow CI / backend tests;
- PostgreSQL recurring idempotency;
- PostgreSQL ownership and RLS;
- Financial idempotency / PostgreSQL mutation idempotency;
- Authenticated data plane / PostgreSQL authenticated write boundary;
- Mobile auth session, cache and mutation identity;
- Mobile UX state and accessibility contract;
- Mobile Expo health / Expo Doctor and build smoke;
- Backend container / Build production backend image;
- Dependency audit evidence;
- Secret scan;
- Supply-chain policy / Immutable Actions and reproducible tooling.

A green wrapper is not sufficient if a required inner test was skipped or did not execute.

## GitHub branch protection / rulesets

The effective GitHub repository policy was re-read non-destructively on 2026-08-16 during the final exhaustive internal red-team.

The repository contains one active branch ruleset named `Protect main`, targeted at `~DEFAULT_BRANCH` with no bypass actors; the current authenticated user reports `current_user_can_bypass: never`.

The active ruleset enforces:

- deletion restriction;
- non-fast-forward / force-push restriction;
- pull request required before merge;
- required approving review count: `0`;
- required review-thread/conversation resolution;
- required status checks;
- strict required-status-check policy, meaning the protected branch must be up to date before merge.

The remotely observed globally required checks are currently exactly:

- `Backend tests`;
- `PostgreSQL recurring idempotency`;
- `PostgreSQL ownership and RLS`;
- `Mobile typecheck`;
- `Dependency audit evidence`;
- `Secret scan`;
- `PostgreSQL mutation idempotency`;
- `Auth session, cache and mutation identity`;
- `UX state and accessibility contract`;
- `PostgreSQL authenticated write boundary`.

The release-hardening work subsequently made three additional release gates always-on for pull requests to both promotion branches, with no `paths`/`paths-ignore` filters:

- `Expo Doctor and build smoke`;
- `Build production backend image`;
- `Immutable Actions and reproducible tooling`.

Those three contexts are emitted for every promotion PR and are required by the FinanceFlow release process, but the remote `Protect main` ruleset does **not yet** list them as GitHub-required contexts. This is tracked as a governance residual rather than being hidden by exact-SHA release evidence.

**MANUAL GOVERNANCE ACTION:** add the three exact contexts above to `Protect main` required status checks while preserving strict mode, no bypass actors, PR requirement, review-thread resolution, deletion protection and non-fast-forward protection. After the setting change, re-read the ruleset through GitHub's API and reconcile this document with the remote source of truth.

The ruleset permits GitHub merge, squash, and rebase methods, but the project-level promotion rule is stricter: automation must never merge the final `portfolio/revamp-2026 -> main` PR. That final promotion remains a maintainer decision after the required independent audit.

The same controls may be applied to `portfolio/revamp-2026` proportionally. Internal automation can merge an issue PR only after its required evidence is green, but that program convention is not a substitute for GitHub-side protection.

### Required-check drift contract

Repository-side tests cannot mutate or authoritatively query GitHub settings during normal CI, so the remote ruleset remains the source of truth. The repository contract guards the local half of the invariant: the authenticated data-plane gate plus the Expo health, backend container and supply-chain release gates must all emit their exact context names for PRs to `main` and `portfolio/revamp-2026` without path filtering.

If a future always-on security, runtime or financial gate is added or renamed, maintainers must update the GitHub ruleset, this document and the corresponding repository contract together. A passing repository test is not a substitute for re-reading the effective remote ruleset after any settings change.

## GitHub Actions supply-chain policy

Permanent workflows follow these rules:

1. External GitHub Actions are pinned to a full 40-character commit SHA.
2. The pin keeps a human-readable version comment, for example `# v7.0.1`, so upgrades remain reviewable.
3. Mutable Action references such as `@main`, `@master`, `@v7`, or `@latest` are not accepted for permanent external actions.
4. Repository-controlled Dockerfile base images and workflow/container-service images are digest-pinned with `@sha256:`; `scratch` is the intentional exception.
5. `docker://` action images, if introduced, must also be digest-pinned.
6. Release-evidence executions of Expo Doctor and pip-audit use exact package versions rather than dynamic package resolution.
7. The EAS CLI version used by the deploy workflow is an exact semantic version, not `latest`.
8. Workflow permissions default to least privilege. CI/test workflows use `contents: read`; no permanent workflow added by this hardening requires `contents: write`.

`.github/scripts/check_supply_chain.py` enforces these repository-controlled immutable-reference/tooling boundaries. `.github/scripts/test_supply_chain.py` is the deterministic test-the-test: it mutates a workflow image, Dockerfile base, Expo Doctor invocation, pip-audit invocation and Action ref and requires the policy to turn red for each class. GitHub-hosted runner labels remain a platform-managed mutability boundary rather than a repository Docker image that FinanceFlow can digest-pin.

## Current pinned workflow dependencies

At the time of this governance hardening, the permanent workflow baseline uses immutable Action release commits, including the repository's current `actions/checkout`, `actions/setup-node`, `actions/setup-python`, `actions/setup-go` and `actions/upload-artifact` pins. The backend Python base and PostgreSQL CI services are digest-pinned, Expo Doctor is invoked at exact version `1.20.2`, pip-audit at exact version `2.10.1`, and EAS CLI remains an exact configured semantic version.

A future major tool/action upgrade should be handled as an explicit compatibility change, not bundled into supply-chain pinning merely to silence an advisory or produce a newer-looking version.

## Updating a pinned action or executable input

When updating an immutable CI/build dependency:

1. identify the intended upstream release from the official source;
2. resolve the release to an immutable commit SHA or container digest where applicable;
3. update the immutable identity and the human-readable version annotation where the workflow convention uses one;
4. review upstream release notes, especially for runtime/permission/breaking changes;
5. run the affected workflow plus `Supply-chain policy` on the exact PR head;
6. confirm the supply-chain mutation controls still turn red;
7. do not downgrade application/runtime dependencies merely to silence tooling advisories.

An immutable pin reduces mutable-reference risk but does not replace upstream release review, dependency scanning, provenance review, or repository permissions hygiene.

## Deploy workflow

The frontend deploy workflow runs only on `main` mobile changes and requires `EXPO_TOKEN`. It uses:

- immutable action SHAs;
- Node 22.13.0;
- `npm ci` against the committed lockfile;
- an exact EAS CLI version;
- production environment validation before `eas update`.

A work-branch/PR validation must not publish an EAS production update merely to prove the workflow syntax. Expo Doctor, public config validation, TypeScript, release-environment validation and web export provide non-deploying compatibility evidence before the final maintainer-controlled merge.

## Residual/manual governance items

The `Protect main` ruleset is remotely verified as active/strict/no-bypass. Remaining platform-level items that require maintainer/admin handling are tracked explicitly rather than inferred from repository code:

- add the three now-always-on release contexts identified above to `Protect main` required checks;
- enable GitHub Private Vulnerability Reporting while that repository setting remains disabled;
- organization/account-level Actions restrictions and allowed-actions policy;
- secret/environment protection rules in GitHub/Expo;
- future changes to ruleset bypass actors or required checks.

Any future ruleset change should be re-read through the GitHub API and reconciled with this document rather than inferred from UI screenshots or stale documentation.
