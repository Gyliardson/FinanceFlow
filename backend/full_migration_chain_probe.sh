#!/usr/bin/env bash
set -euo pipefail

MIGRATION_DIR="${MIGRATION_DIR:-backend/migrations}"
BOOTSTRAP_SCHEMA="${BOOTSTRAP_SCHEMA:-backend/supabase_schema.sql}"
PROBE_DATABASE="${PROBE_DATABASE:-financeflow_full_migration_test}"

EXPECTED_MIGRATIONS=(
  001_recurring_bills.sql
  002_recurring_instance_uniqueness.sql
  003_user_ownership_rls.sql
  004_enforce_owner_not_null.sql
  005_private_receipt_paths.sql
  006_financial_idempotency.sql
  007_authenticated_data_plane.sql
  008_payment_recurring_data_plane.sql
  009_revoke_authenticated_table_dml.sql
  010_initial_balance_date_boundary.sql
)

mapfile -t actual_migrations < <(
  find "$MIGRATION_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9]_*.sql' -printf '%f\n' | sort
)

if [[ "${actual_migrations[*]}" != "${EXPECTED_MIGRATIONS[*]}" ]]; then
  printf 'Expected migration chain:\n%s\n' "${EXPECTED_MIGRATIONS[*]}" >&2
  printf 'Actual migration chain:\n%s\n' "${actual_migrations[*]}" >&2
  exit 1
fi

if [[ "${INVENTORY_ONLY:-0}" == "1" ]]; then
  echo 'FULL_MIGRATION_INVENTORY=pass'
  exit 0
fi

cleanup() {
  PGDATABASE="${POSTGRES_DB:-postgres}" dropdb --if-exists "$PROBE_DATABASE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

PGDATABASE="${POSTGRES_DB:-postgres}" dropdb --if-exists "$PROBE_DATABASE" >/dev/null 2>&1 || true
PGDATABASE="${POSTGRES_DB:-postgres}" createdb "$PROBE_DATABASE"
export PGDATABASE="$PROBE_DATABASE"

# Minimal Supabase platform shims only. These are platform prerequisites, not
# repository migrations, and intentionally do not model the full Supabase stack.
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END
$$;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false
);
SQL

psql -v ON_ERROR_STOP=1 -f "$BOOTSTRAP_SCHEMA"
for migration in "${EXPECTED_MIGRATIONS[@]}"; do
  echo "FULL_MIGRATION_APPLY=$migration"
  psql -v ON_ERROR_STOP=1 -f "$MIGRATION_DIR/$migration"
done

psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  v_nullable_count integer;
  v_rls_count integer;
BEGIN
  SELECT count(*) INTO v_nullable_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name IN ('finance_bills','finance_incomes','finance_user_settings')
    AND column_name = 'owner_id'
    AND is_nullable <> 'NO';
  IF v_nullable_count <> 0 THEN
    RAISE EXCEPTION 'final owner_id columns are not all NOT NULL';
  END IF;

  SELECT count(*) INTO v_rls_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('finance_bills','finance_incomes','finance_user_settings')
    AND c.relrowsecurity;
  IF v_rls_count <> 3 THEN
    RAISE EXCEPTION 'final financial tables do not all have RLS enabled';
  END IF;

  IF has_table_privilege('authenticated','public.finance_bills','INSERT')
     OR has_table_privilege('authenticated','public.finance_bills','UPDATE')
     OR has_table_privilege('authenticated','public.finance_bills','DELETE')
     OR has_table_privilege('authenticated','public.finance_incomes','INSERT')
     OR has_table_privilege('authenticated','public.finance_user_settings','UPDATE') THEN
    RAISE EXCEPTION 'authenticated direct financial DML remains granted';
  END IF;

  IF NOT has_table_privilege('authenticated','public.finance_bills','SELECT') THEN
    RAISE EXCEPTION 'authenticated owner-scoped SELECT grant missing';
  END IF;

  IF to_regclass('financeflow_private.idempotency_operations') IS NULL THEN
    RAISE EXCEPTION 'idempotency operations table missing';
  END IF;

  IF to_regproc('public.finance_idempotent_add_bill') IS NULL
     OR to_regproc('public.finance_idempotent_add_income') IS NULL
     OR to_regproc('public.finance_mark_bill_paid') IS NULL
     OR to_regproc('public.finance_generate_recurring_child') IS NULL THEN
    RAISE EXCEPTION 'sanctioned financial RPC set incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='ux_finance_bills_generated_parent_due'
      AND indexdef ILIKE '%UNIQUE%'
  ) THEN
    RAISE EXCEPTION 'recurring generated-instance uniqueness index missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id='receipts' AND public=false
  ) THEN
    RAISE EXCEPTION 'private receipts bucket bootstrap missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='finance_bills' AND column_name='receipt_path'
  ) THEN
    RAISE EXCEPTION 'private receipt path column missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='finance_bills_receipt_path_owner_scope'
  ) THEN
    RAISE EXCEPTION 'receipt owner-scope constraint missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='finance_user_settings'
      AND column_name='initial_balance_date'
      AND is_nullable='NO'
  ) THEN
    RAISE EXCEPTION 'initial_balance_date final boundary is not NOT NULL';
  END IF;
END
$$;
SQL

echo "FULL_MIGRATION_CHAIN=pass"
echo "FULL_MIGRATION_DATABASE=$PROBE_DATABASE"
echo "FULL_MIGRATION_COUNT=${#EXPECTED_MIGRATIONS[@]}"