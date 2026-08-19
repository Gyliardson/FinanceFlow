# FinanceFlow repository governance

FinanceFlow governance has two distinct layers:

1. **repository-defined contracts** — versioned files, workflows, tests, and documented context names that can be inspected from a candidate tree;
2. **operator-managed GitHub state** — branch rulesets, required-status configuration, bypass actors, repository security settings, secrets, and environment protection that live outside the Git tree.

Documentation must not present an old observation of operator-managed state as a timeless repository fact.

## Development and integration model

The completed hardening program has already been integrated into `main`. New work should branch from the current `main`, use a scoped issue/branch, and return to `main` through a reviewed pull request.

Historical branches such as `portfolio/revamp-2026` are not the recommended lifecycle for new work. Some workflow definitions still include legacy branch triggers for `portfolio/revamp-2026` and/or `work/*`; those source-controlled triggers remain in effect until a separate, deliberate workflow change removes them.

Automation must not infer permission to merge merely from green CI. Merge authority remains an explicit repository/operator decision.

## Repository-defined CI expectations

The current source tree defines these high-value checks and contexts, among others:

- `FinanceFlow CI` / backend, PostgreSQL, mobile, dependency, and secret jobs;
- `Financial idempotency` / `PostgreSQL mutation idempotency`;
- `Authenticated data plane` / `PostgreSQL authenticated write boundary`;
- `Mobile auth contract` / `Auth session, cache and mutation identity`;
- `Mobile UX contract` / `UX state and accessibility contract`;
- `Mobile Expo health` / `Expo Doctor and build smoke`;
- `Backend container` / `Build production backend image`;
- `Supply-chain policy` / `Immutable Actions and reproducible tooling`.

A green wrapper is not sufficient if a required inner test was skipped or did not execute. Release/review evidence must be tied to the exact candidate SHA being evaluated.

Repository contract tests intentionally verify that the authenticated data-plane gate plus the Expo health, backend container, and supply-chain gates continue to emit their expected context names on the branch triggers currently encoded in the workflows and without path filtering where that contract applies.

## GitHub rulesets and remote settings

GitHub rulesets and repository settings are an external control plane. They cannot be reconstructed authoritatively from the Git tree alone.

This document therefore does **not** freeze a dated list of remote required checks, bypass actors, approval counts, Private Vulnerability Reporting state, secret/environment protections, or organization-level Actions restrictions as if those values were source-controlled facts.

When a merge/release decision depends on remote settings, the operator or reviewer must re-read the effective GitHub state at that time and compare it with the repository-defined expectations above.

**MANUAL GOVERNANCE ACTION:** after any ruleset, required-check, bypass, repository-security, or environment-protection change, re-read the effective remote configuration and reconcile durable documentation/tests only where a source-controlled contract genuinely changed.

A passing repository test proves the local half of a governance invariant; it is not a substitute for observing the effective remote policy.

## Required-check drift contract

Repository-side tests guard names and workflow behavior that must remain stable enough to be referenced by remote policy. In particular, the local governance contract protects the exact contexts:

- `PostgreSQL authenticated write boundary`;
- `Expo Doctor and build smoke`;
- `Build production backend image`;
- `Immutable Actions and reproducible tooling`.

If an always-on security, runtime, financial, or supply-chain context is added or renamed, maintainers must treat the workflow change and any corresponding remote required-check update as one governance decision, even though the two changes occur in different control planes.

## GitHub Actions supply-chain policy

Permanent workflows follow these repository-defined rules:

1. External GitHub Actions are pinned to a full 40-character commit SHA.
2. Pins retain human-readable version annotations where the repository convention uses them.
3. Mutable references such as `@main`, `@master`, major-only tags, or `@latest` are not accepted for permanent external actions.
4. Repository-controlled Dockerfile base images and workflow/container-service images are digest-pinned with `@sha256:`; `scratch` is the intentional exception.
5. `docker://` action images, if introduced, must also be digest-pinned.
6. Release-evidence executions of Expo Doctor and pip-audit use exact package versions rather than dynamic resolution.
7. The EAS CLI used by deployment automation is exact-version pinned.
8. Workflow permissions follow least-privilege expectations for their function.

`.github/scripts/check_supply_chain.py` enforces the repository-controlled immutable-reference/tooling boundary. `.github/scripts/test_supply_chain.py` is the deterministic test-the-test for important policy classes.

The independent FinanceFlow Trust Verifier adds a separate check publisher and rereads the candidate tree from GitHub against its own trusted policy. Its existence does not authorize repository-side workflow or bound-blob changes; those require the verifier's independent policy lifecycle.

## Updating immutable workflow/build inputs

When updating a pinned action or executable input:

1. identify the intended upstream release from the official source;
2. resolve it to an immutable commit SHA or container digest where applicable;
3. update the immutable identity and human-readable version annotation where used;
4. review upstream release notes and permission/runtime changes;
5. run the affected workflow plus `Supply-chain policy` on the exact PR head;
6. confirm mutation controls still turn red for the intended failure classes;
7. do not downgrade application/runtime dependencies merely to silence tooling advisories.

An immutable pin reduces mutable-reference risk but does not replace upstream review, dependency scanning, provenance analysis, or permissions hygiene.

## Deployment governance

The frontend deployment workflow is source-defined to publish only from its configured `main` path and requires operator-managed `EXPO_TOKEN` plus EAS environment values. Work-branch/PR validation must not publish a production update merely to prove syntax or build compatibility.

Repository source can validate public configuration shape, TypeScript, Expo health, release-environment contracts, and web export without possessing production signing/deployment authority.

## Operator-managed residuals

The following classes remain outside reproducible source control and should be inspected when relevant rather than copied forward as stale snapshots:

- effective `main` ruleset / branch protection and required contexts;
- bypass actors and review requirements;
- GitHub repository security features;
- organization/account-level Actions restrictions;
- GitHub/Expo secret and environment protection;
- production Supabase/Render/EAS access policy.

The governing rule is simple: source-controlled documentation describes source-controlled contracts; remote platform state is re-observed when a decision depends on it.
