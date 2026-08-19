# FinanceFlow clean-room validation runbook

This runbook is the operator-oriented path for validating a fresh checkout without relying on developer-machine state. It mirrors repository CI where practical and explicitly separates reproducible local checks from external credentialed deployment checks.

## 1. Fresh clone and exact candidate

```bash
git clone https://github.com/Gyliardson/FinanceFlow.git
cd FinanceFlow
git checkout <exact-candidate-sha>
```

Use the exact PR/head SHA being evaluated. For general development, start from current `main`; do not use historical hardening branches as the lifecycle template for new work.

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

Use `.env.example` to understand required configuration. Do not place real service-role, database, or provider secrets into committed files or CI fixtures.

## 3. Disposable PostgreSQL verification

Repository CI uses PostgreSQL 16 for database-level guarantees. A local equivalent can use Docker:

```bash
docker run --rm --name financeflow-pg \
  -e POSTGRES_USER=financeflow \
  -e POSTGRES_PASSWORD=financeflow \
  -e POSTGRES_DB=financeflow_test \
  -p 5432:5432 \
  -d postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5
```

Wait for readiness:

```bash
docker exec financeflow-pg pg_isready -U financeflow -d financeflow_test
```

FinanceFlow stores repository-owned schema evolution as `backend/supabase_schema.sql` followed by the exact numbered migration chain `backend/migrations/001_...` through `010_...`. Migration `006_financial_idempotency.sql` defines the database-backed financial mutation idempotency primitives. Migration `007_authenticated_data_plane.sql` hardens the existing idempotent RPCs and adds field-scoped settings/insight RPCs. Migration `008_payment_recurring_data_plane.sql` adds database-owned payment-date semantics plus owner-derived payment and recurring-child RPCs. Migration `009_revoke_authenticated_table_dml.sql` removes authenticated table `INSERT`, `UPDATE`, and `DELETE` after the sanctioned functions and canonical call sites exist. Migration `010_initial_balance_date_boundary.sql` constrains the sanctioned settings RPC so an authenticated direct Data API caller cannot set an initial-balance baseline after the canonical financial today.

The required `PostgreSQL authenticated write boundary` job includes `backend/full_migration_chain_probe.sh`. That probe creates a clean disposable database, provisions only the minimal Supabase-compatible primitives that repository SQL legitimately depends on, applies `backend/supabase_schema.sql`, then applies **every expected numbered migration in exact order with `ON_ERROR_STOP=1`**. It fails closed on a missing/extra/reordered numbered migration and asserts representative final ownership/RLS, authenticated-DML revocation, idempotency RPC/table, recurring uniqueness, private receipt bucket/path, and initial-balance boundary state.

This is a repository migration-chain convergence proof under explicit Supabase-compatible platform shims. It is **not** equivalent to provisioning a production Supabase project, nor does it replace external validation of the managed Auth/Storage/Data API platform. Focused PostgreSQL fixtures remain alongside the chain probe because they exercise adversarial RLS, concurrency, and negative behavior more precisely than a bootstrap smoke alone.

The authoritative disposable-PostgreSQL procedures live in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`.github/workflows/financial-idempotency.yml`](../../.github/workflows/financial-idempotency.yml), and [`.github/workflows/authenticated-data-plane.yml`](../../.github/workflows/authenticated-data-plane.yml). Together they prove or are required to prove:

- exact `NUMERIC` money round trips;
- full bootstrap + exact `001..010` repository migration-chain execution on a clean disposable database;
- fail-closed migration inventory test-the-test for an omitted numbered migration;
- recurring migration fail-closed behavior on historical duplicates;
- uniqueness under concurrent generated-instance insertion;
- retry idempotency and bulk-conflict rollback/recovery;
- database-backed mutation idempotency for scoped financial writes;
- user A / user B RLS isolation and forged-owner rejection;
- anonymous financial-table denial;
- fail-closed owner `NOT NULL` promotion until explicit reconciliation;
- direct authenticated financial-table `INSERT`, `UPDATE`, and `DELETE` denial;
- positive sanctioned bill/income/reserve/settings/insight/payment/recurring-child paths;
- payment state/date ownership inside PostgreSQL;
- canonical initial-balance-date enforcement inside PostgreSQL;
- cross-owner and recurring-template payment rejection.

The authenticated data-plane migrations are not considered certified merely because their SQL files exist. The dedicated real-PostgreSQL workflow must pass on the exact candidate head, including its clean full-chain replay, alongside the financial idempotency and ownership/RLS gates.

### Seed status

There is currently **no canonical repository seed script**. CI uses synthetic, scoped fixtures created inside deterministic tests/workflows. Do not claim a `seed` step exists or use real financial data as substitute seed content.

When finished:

```bash
docker stop financeflow-pg
```

## 4. Backend production-image smoke

From the repository root:

```bash
docker build -f backend/Dockerfile -t financeflow-backend:clean-room backend
```

The `Backend container` workflow is the canonical automated proof that the declared production image builds, runs the expected Python baseline, uses `runtime:create_app --factory`, and executes as the configured unprivileged user.

A real authenticated runtime smoke additionally requires valid Supabase/server environment values. Do not invent production credentials merely to make this step green.

## 5. Mobile clean install and static/build health

Current baseline: Node.js 22.13+.

```bash
cd mobile
npm ci
npx tsc --noEmit
npx --yes expo-doctor@1.20.2
node scripts/test-release-env-contract.mjs
npx expo export --platform web
```

These commands exercise the reproducible local portion of `Mobile Expo health`, including the deterministic release-environment contract. They do not prove a signed physical-device build. For the canonical local Android Development Build + Metro path, use [MOBILE_LOCAL_ANDROID.md](./MOBILE_LOCAL_ANDROID.md).

## 6. Dependency and secret evidence

Backend dependency consistency:

```bash
cd backend
python -m pip check
python -m pip install 'pip-audit==2.10.1'
python -m pip_audit -r requirements.txt
```

Mobile audit evidence:

```bash
cd mobile
npm ci --ignore-scripts
npm audit
```

The repository policy blocks critical mobile findings and preserves the full npm audit artifact. Residual compatible-path limitations must remain documented; do not use forced incompatible downgrades merely to report zero findings.

Secret scanning is a GitHub gate using Gitleaks over repository history. Review the exact-head `Secret scan` result and its evidence rather than copying secrets into a local test. See [Secret scan gate](../assurance/SECRET_SCAN_GATE.md).

## 7. Application configuration smoke

### Backend

Review:

- `backend/.env.example`;
- `render.yaml`;
- [DEPLOYMENT.md](./DEPLOYMENT.md).

Server-only values include the Supabase service-role credential and external provider keys. Production CORS origins must be explicit.

### Mobile

Review:

- `mobile/.env.example`;
- `mobile/eas.json`;
- [DEPLOYMENT.md](./DEPLOYMENT.md).

The client-visible contract requires:

- `EXPO_PUBLIC_API_URL`;
- `EXPO_PUBLIC_SUPABASE_URL`;
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

All `EXPO_PUBLIC_*` values are public bundle configuration and must never contain server-only credentials. Before a manual production EAS build, separately run `eas env:exec production 'node scripts/validate-release-env.mjs' --non-interactive` to validate operator-controlled values without printing them.

## 8. External/manual checks

Repository-only CI cannot fully prove:

- Supabase project provisioning, Auth configuration, database/storage state, and real credentials;
- Render service provisioning, server environment values, DNS/networking, and live health;
- EAS project environment values, `EXPO_TOKEN`, signing credentials, and store accounts;
- signed Android/iOS remote builds and device/store smoke;
- real third-party experimental adapter compatibility;
- native visual/device accessibility behavior.

Record external checks as PASS / FAIL / NOT EXECUTED when they are part of a release decision. `NOT EXECUTED` is preferable to claiming evidence that does not exist.

## 9. Candidate checklist

Before presenting a candidate for merge review, require the applicable evidence on its **exact head SHA**:

- candidate SHA recorded;
- FinanceFlow CI green;
- Authenticated data plane green, including clean bootstrap + `001..010` replay;
- Backend container green;
- Financial idempotency green;
- Mobile auth contract green;
- Mobile UX contract green;
- Mobile Expo health green;
- Supply-chain policy green;
- dependency and secret evidence reviewed;
- documentation links/current limitations reviewed;
- no unresolved P0/P1 blocker in the candidate scope;
- external/manual steps identified where applicable.

The hardening integration branch used earlier in the project lifecycle is historical. Current changes should be based on `main` and reviewed through their own PR; workflow triggers that still name historical branches remain repository-defined compatibility until deliberately changed in a separate scope.
