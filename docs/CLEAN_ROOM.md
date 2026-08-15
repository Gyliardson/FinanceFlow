# FinanceFlow clean-room validation runbook

This runbook is the operator-oriented path for validating a fresh checkout without relying on developer-machine state. It mirrors repository CI where practical and explicitly separates reproducible local checks from external credentialed deployment checks.

## 1. Fresh clone

```bash
git clone https://github.com/Gyliardson/FinanceFlow.git
cd FinanceFlow
git checkout portfolio/revamp-2026
```

For a final release candidate, replace the branch above with the exact candidate SHA and record that SHA in the release report.

## 2. Backend environment

Recommended CI-equivalent runtime: Python 3.12.

```bash
cd backend
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m pip check
python -m compileall -q .
pytest -q
```

Use `.env.example` to understand required configuration. Do not place real service-role, database or Gemini secrets into committed files or CI fixtures.

## 3. Disposable PostgreSQL verification

Repository CI uses PostgreSQL 16 for database-level guarantees. A local equivalent can use Docker:

```bash
docker run --rm --name financeflow-pg \
  -e POSTGRES_USER=financeflow \
  -e POSTGRES_PASSWORD=financeflow \
  -e POSTGRES_DB=financeflow_test \
  -p 5432:5432 \
  -d postgres:16
```

Wait for readiness:

```bash
docker exec financeflow-pg pg_isready -U financeflow -d financeflow_test
```

FinanceFlow currently stores migrations as explicit SQL files in `backend/migrations/001_...` through `010_...`. Migration `006_financial_idempotency.sql` defines the database-backed financial mutation idempotency primitives used by the protected non-convergent write paths. Migration `007_authenticated_data_plane.sql` starts the least-privilege authenticated write boundary by hardening the existing idempotent RPCs and adding field-scoped settings/insight RPCs. Migration `008_payment_recurring_data_plane.sql` adds database-owned payment-date semantics plus owner-derived payment and recurring-child RPCs. Migration `009_revoke_authenticated_table_dml.sql` is the final least-privilege table-DML step: authenticated table `INSERT`, `UPDATE`, and `DELETE` are removed only after the sanctioned functions exist and canonical application call sites use them. Migration `010_initial_balance_date_boundary.sql` hardens the sanctioned settings RPC so an authenticated direct Data API caller cannot set an initial-balance baseline after the canonical financial today; today and historical dates remain valid. Some migrations intentionally depend on existing Supabase-compatible schema objects or explicit historical reconciliation, so blindly replaying every file against an empty generic PostgreSQL database is **not** equivalent to provisioning a production Supabase project. The disposable CI creates focused fixtures and then applies the migrations needed to prove each invariant.

The authoritative disposable-PostgreSQL procedures live in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml), [`.github/workflows/financial-idempotency.yml`](../.github/workflows/financial-idempotency.yml), and [`.github/workflows/authenticated-data-plane.yml`](../.github/workflows/authenticated-data-plane.yml). Together they prove or are required to prove:

- exact `NUMERIC` money round trips;
- recurring migration fail-closed behavior on historical duplicates;
- uniqueness under concurrent generated-instance insertion;
- retry idempotency and bulk-conflict rollback/recovery;
- database-backed mutation idempotency for financial writes, including duplicate/retry behavior;
- user A / user B RLS isolation;
- forged-owner rejection;
- anonymous financial-table denial;
- fail-closed owner `NOT NULL` promotion until explicit reconciliation;
- direct authenticated financial-table `INSERT`, `UPDATE`, and `DELETE` denial;
- positive sanctioned bill/income/reserve/settings/insight/payment/recurring-child mutation paths;
- payment state/date ownership inside PostgreSQL;
- canonical initial-balance-date enforcement inside PostgreSQL;
- cross-owner and recurring-template payment rejection.

The authenticated data-plane migrations are not considered certified merely because their SQL files exist. The dedicated real-PostgreSQL workflow must pass on the exact candidate head, alongside the existing financial idempotency and ownership/RLS gates.

For release evidence, inspect the exact-candidate PostgreSQL mutation-idempotency, authenticated-data-plane, ownership/RLS, and recurring-idempotency checks rather than treating migration filenames alone as proof. Prefer executing the workflows themselves rather than maintaining an undocumented hand-copied SQL harness that can drift.

### Seed status

There is currently **no canonical repository seed script**. CI uses synthetic, scoped fixtures created inside deterministic tests/workflows. Do not claim a `seed` step exists or use real financial data as substitute seed content. If a future demo seed is added, it must contain only synthetic data and become part of this runbook and clean-room gates.

When finished:

```bash
docker stop financeflow-pg
```

## 4. Backend production-image smoke

From the repository root:

```bash
docker build -f backend/Dockerfile -t financeflow-backend:clean-room backend
```

The GitHub `Backend container` workflow is the canonical automated proof that the production image builds, runs Python 3.12, uses `runtime:create_app --factory` as the application entrypoint, and executes as the unprivileged `financeflow` user.

A real authenticated runtime smoke additionally requires valid Supabase/server environment values. Do not invent production credentials merely to make this step green.

## 5. Mobile clean install and static/build health

Current baseline: Node.js 22.13+.

```bash
cd mobile
npm ci
npx tsc --noEmit
npx expo-doctor
node scripts/test-release-env-contract.mjs
npx expo export --platform web
```

These commands exercise the reproducible local portion of `Mobile Expo health`, including the deterministic release-environment contract. The contract uses synthetic values only; it does not contact EAS, Supabase or the production FinanceFlow API.

The mobile application also has deterministic contract workflows for:

- auth/session/cache behavior;
- owner-scoped offline resilience;
- critical UX/accessibility source contracts;
- release-environment configuration.

Run/inspect the corresponding GitHub Actions on the exact candidate head for release evidence.

## 6. Dependency and secret evidence

Backend dependency consistency:

```bash
cd backend
python -m pip check
python -m pip install pip-audit
python -m pip_audit -r requirements.txt
```

Mobile audit evidence:

```bash
cd mobile
npm ci --ignore-scripts
npm audit
```

The repository policy blocks critical mobile findings and preserves the full npm audit artifact. Residual compatible-path limitations must remain documented; do not use forced incompatible downgrades merely to report zero findings.

Secret scanning is a GitHub gate using Gitleaks over repository history. Clean-room reviewers should inspect the exact-head `Secret scan` result/artifact rather than copying secrets into a local test.

## 7. Application configuration smoke

### Backend

Review:

- `backend/.env.example`;
- `render.yaml`;
- `docs/DEPLOYMENT.md`.

Server-only values include the Supabase service-role credential and Gemini key. Production CORS origins must be explicit.

### Mobile

Review:

- `mobile/.env.example`;
- `mobile/eas.json`;
- `docs/DEPLOYMENT.md`.

The client-visible contract requires:

- `EXPO_PUBLIC_API_URL`;
- `EXPO_PUBLIC_SUPABASE_URL`;
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

All `EXPO_PUBLIC_*` values are public bundle configuration and must never contain server-only credentials. Publishable API/auth endpoints must be absolute HTTPS URLs, free of embedded URL credentials/query/fragment data, and must not target obvious local/loopback addresses. `node scripts/test-release-env-contract.mjs` proves those invariants with synthetic values; before a manual production EAS build, separately run `eas env:exec production 'node scripts/validate-release-env.mjs' --non-interactive` to validate the operator-controlled values without printing them.

## 8. External/manual release checks

These cannot be fully proven by repository-only CI without production access:

- Supabase project provisioning, Auth configuration, database/storage state and real credentials;
- Render service provisioning, server environment values, DNS/networking and live health after deployment;
- EAS project environment values, `EXPO_TOKEN`, signing credentials and store accounts;
- signed Android/iOS remote builds and device/store smoke;
- real third-party experimental adapter compatibility;
- native visual/device accessibility review.

Record each external check as PASS / FAIL / NOT EXECUTED in the final release report. `NOT EXECUTED` is preferable to claiming evidence that does not exist.

## 9. Release-candidate checklist

Before moving the final integration → `main` PR out of draft or presenting it for maintainer merge review, require at minimum:

- exact candidate SHA recorded;
- FinanceFlow CI green;
- Authenticated data plane green;
- Backend container green;
- Mobile auth/cache contract green;
- Mobile UX contract green;
- Mobile Expo health green;
- Python dependency audit clean;
- mobile audit artifact reviewed and no critical findings;
- Gitleaks green;
- documentation links/current limitations reviewed;
- no unresolved program P0/P1/blocker;
- external/manual steps explicitly listed.

Opening the final PR early as a **draft** is allowed so exact-head PR checks and review evidence can accumulate during the independent audit; that draft must remain unmerged until the audit is exhausted and manual review is appropriate.

The final `portfolio/revamp-2026 -> main` merge is manual by policy.
