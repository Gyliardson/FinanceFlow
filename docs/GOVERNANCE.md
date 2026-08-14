# FinanceFlow Repository Governance

This document records the repository controls that are enforced in code and the controls that still depend on GitHub repository settings.

## Promotion model

Portfolio professionalization work follows this branch flow:

`main` → `portfolio/revamp-2026` → `work/<issue>-<slug>` → PR → `portfolio/revamp-2026`.

The integration branch is never merged automatically into `main`. The final integration-to-main PR requires maintainer review and, while the current red-team remediation is active, a separate independent audit.

## CI expectations

Changes should be merged into `portfolio/revamp-2026` only after the applicable exact-head checks pass. The current high-value checks include:

- FinanceFlow CI / backend tests;
- PostgreSQL recurring idempotency;
- PostgreSQL ownership and RLS;
- Financial idempotency / PostgreSQL mutation idempotency;
- Mobile auth session, cache and mutation identity;
- Mobile UX state and accessibility contract;
- Mobile Expo health / Expo Doctor and build smoke;
- Backend container;
- Dependency audit evidence;
- Secret scan;
- Supply-chain policy.

A green wrapper is not sufficient if a required inner test was skipped or did not execute.

## GitHub branch protection / rulesets

During the 2026-08-14 governance audit, the repository rulesets API returned no configured repository rulesets. The available connector token could not read the `main` branch-protection endpoint, so this repository does **not** claim that branch protection is absent or present based on that failed read.

The maintainer should verify the repository settings manually and, where supported by the GitHub plan/settings, configure `main` with controls equivalent to:

- require a pull request before merge;
- require the project’s applicable status checks;
- require the branch to be up to date when appropriate for the chosen merge policy;
- block force pushes;
- block branch deletion;
- keep administrator/bypass permissions intentionally narrow;
- do not permit a workflow or bot to merge the final portfolio integration PR automatically.

The same controls may be applied to `portfolio/revamp-2026` proportionally. Internal automation can merge an issue PR only after its required evidence is green, but that is a program convention rather than a substitute for GitHub-side protection.

Repository-setting controls must be described as **manual/unverified** until GitHub returns evidence that they are active.

## GitHub Actions supply-chain policy

Permanent workflows follow these rules:

1. External actions are pinned to a full 40-character commit SHA.
2. The pin keeps a human-readable version comment, for example `# v7.0.1`, so upgrades remain reviewable.
3. Mutable references such as `@main`, `@master`, `@v7`, or `@latest` are not accepted for permanent external actions.
4. Local actions (`./...`) and `docker://...` references are exempt from the external-action SHA rule because their identity is governed differently.
5. The EAS CLI version used by the deploy workflow is an exact semantic version, not `latest`.
6. Workflow permissions default to least privilege. CI/test workflows use `contents: read`; no permanent workflow added by this hardening requires `contents: write`.

`.github/scripts/check_supply_chain.py` and the `Supply-chain policy` workflow enforce the immutable-reference and exact-EAS-version portions of this policy.

## Current pinned workflow dependencies

At the time of this governance hardening, the permanent workflow baseline uses:

- `actions/checkout` v7.0.1 pinned to its release commit;
- `actions/setup-node` v7.0.0 pinned to its release commit;
- `actions/setup-python` v7.0.0 pinned to its release commit;
- `actions/upload-artifact` v7.0.1 pinned to its release commit;
- `gitleaks/gitleaks-action` v3.0.0 pinned to its release commit;
- `expo/expo-github-action` 9.0.0 pinned to its release commit;
- EAS CLI 21.8.0 as an exact version.

EAS CLI 22.0.0 was not adopted as part of this governance-only issue because it was a newly published breaking-major release. A future upgrade should be handled as an explicit compatibility change, not bundled into supply-chain pinning.

## Updating a pinned action

When updating an action:

1. identify the intended upstream release/tag from the action’s official repository;
2. resolve that tag to the exact commit SHA;
3. update both the SHA and version comment in the workflow;
4. review the upstream release notes, especially for runtime/permission/breaking changes;
5. run the affected workflow plus `Supply-chain policy` on the exact PR head;
6. do not downgrade application/runtime dependencies merely to silence tooling advisories.

A SHA pin reduces mutable-reference risk but does not replace upstream release review, dependency scanning, or repository permissions hygiene.

## Deploy workflow

The frontend deploy workflow runs only on `main` mobile changes and requires `EXPO_TOKEN`. It uses:

- immutable action SHAs;
- Node 22.13.0;
- `npm ci` against the committed lockfile;
- EAS CLI 21.8.0;
- production environment validation before `eas update`.

A work-branch/PR validation must not publish an EAS production update merely to prove the workflow syntax. Expo Doctor, public config validation, TypeScript, and web export provide non-deploying compatibility evidence before the final maintainer-controlled merge.

## Residual/manual governance items

The following are intentionally not presented as automated facts:

- effective `main` branch protection settings;
- organization/account-level Actions restrictions;
- allowed-actions policy at the account/organization level;
- required-review count and bypass actors;
- secret/environment protection rules in GitHub/Expo.

These require maintainer or platform-level verification when the current connector cannot read them.
