#!/usr/bin/env bash
set -euo pipefail

OWNER_A='11111111-1111-1111-1111-111111111111'
OWNER_B='22222222-2222-2222-2222-222222222222'

scalar() {
  psql -Atqc "$1"
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "ASSERTION FAILED [$label]: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

run_as_owner() {
  local owner="$1"
  local statement="$2"
  psql -qv ON_ERROR_STOP=1 >/dev/null <<SQL
SELECT set_config('request.jwt.claim.sub', '$owner', false);
SET ROLE rls_probe;
$statement
RESET ROLE;
SQL
}

run_concurrent_same_call() {
  local label="$1"
  local owner="$2"
  local statement="$3"
  local first_sql="${RUNNER_TEMP:-/tmp}/${label}-first.sql"
  local second_sql="${RUNNER_TEMP:-/tmp}/${label}-second.sql"

  cat > "$first_sql" <<SQL
BEGIN;
SELECT set_config('request.jwt.claim.sub', '$owner', false);
SET ROLE rls_probe;
$statement
SELECT pg_sleep(1);
COMMIT;
SQL

  cat > "$second_sql" <<SQL
SELECT set_config('request.jwt.claim.sub', '$owner', false);
SET ROLE rls_probe;
$statement
SQL

  psql -qv ON_ERROR_STOP=1 -f "$first_sql" > "${label}-a.log" 2>&1 &
  local pid_a=$!
  sleep 0.2
  psql -qv ON_ERROR_STOP=1 -f "$second_sql" > "${label}-b.log" 2>&1 &
  local pid_b=$!
  wait "$pid_a"
  wait "$pid_b"
}

psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE rls_probe NOLOGIN;
GRANT authenticated TO rls_probe;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE finance_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  description text NOT NULL,
  amount numeric(12,2) NOT NULL,
  due_date date NOT NULL,
  barcode text,
  status text NOT NULL DEFAULT 'pending',
  is_recurring boolean NOT NULL DEFAULT false,
  frequency text,
  recurring_day integer,
  parent_bill_id uuid,
  receipt_path text,
  payment_date date
);
CREATE TABLE finance_incomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  amount numeric(12,2) NOT NULL,
  date date NOT NULL,
  description text,
  type text NOT NULL,
  is_recurring boolean NOT NULL DEFAULT false
);
CREATE TABLE finance_user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  emergency_fund_balance numeric(12,2) NOT NULL DEFAULT 0
);
SQL

psql -v ON_ERROR_STOP=1 -f backend/migrations/003_user_ownership_rls.sql
psql -v ON_ERROR_STOP=1 -f backend/migrations/004_enforce_owner_not_null.sql
psql -v ON_ERROR_STOP=1 -f backend/migrations/006_financial_idempotency.sql

psql -v ON_ERROR_STOP=1 <<SQL
INSERT INTO auth.users(id) VALUES ('$OWNER_A'), ('$OWNER_B');
INSERT INTO finance_user_settings(owner_id, emergency_fund_balance) VALUES
  ('$OWNER_A', 100.00),
  ('$OWNER_B', 500.00);
SQL

# Commit + response-loss simulation: first durable calls complete and their return
# payload is deliberately discarded. Retrying the same owner/operation/key/params
# must return the durable result without another financial effect.
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_reserve('reserve-retry-0001','10.00');"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_bill('bill-retry-000001','Internet','123.45',DATE '2026-09-10',NULL);"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_income('income-retry-0001','Salary','1000.00',DATE '2026-08-14',NULL,'salary',false);"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_create_recurring_template('recurring-retry1','Rent','900.00',DATE '2026-09-05',NULL,'monthly',5);"

run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_reserve('reserve-retry-0001','10.0');"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_bill('bill-retry-000001','Internet','123.450',DATE '2026-09-10',NULL);"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_income('income-retry-0001','Salary','1000',DATE '2026-08-14',NULL,'salary',false);"
# Different derived due date proves this field is intentionally excluded from the
# recurring-template logical identity.
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_create_recurring_template('recurring-retry1','Rent','900.0',DATE '2026-10-05',NULL,'monthly',5);"

assert_eq "$(scalar "SELECT emergency_fund_balance FROM finance_user_settings WHERE owner_id='$OWNER_A';")" '110.00' 'reserve retry once'
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_A' AND description='Internet';")" '1' 'bill retry once'
assert_eq "$(scalar "SELECT count(*) FROM finance_incomes WHERE owner_id='$OWNER_A' AND title='Salary';")" '1' 'income retry once'
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_A' AND description='Rent' AND is_recurring=true;")" '1' 'recurring template retry once'
assert_eq "$(scalar "SELECT count(*) FROM financeflow_private.idempotency_operations WHERE owner_id='$OWNER_A' AND completed_at IS NOT NULL;")" '4' 'four replay records'

# Same key + different logical payload must reject based on the fingerprint the
# database computed itself. No caller-supplied fingerprint exists in the RPC API.
if run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_reserve('reserve-retry-0001','99.00');"; then
  echo 'same key + different payload unexpectedly succeeded' >&2
  exit 1
fi
assert_eq "$(scalar "SELECT emergency_fund_balance FROM finance_user_settings WHERE owner_id='$OWNER_A';")" '110.00' 'payload mismatch no effect'

# Same opaque key is independent across owners.
run_as_owner "$OWNER_B" "SELECT public.finance_idempotent_add_reserve('reserve-retry-0001','10.00');"
run_as_owner "$OWNER_B" "SELECT public.finance_idempotent_add_bill('bill-retry-000001','Internet B','50.00',DATE '2026-09-11',NULL);"
assert_eq "$(scalar "SELECT emergency_fund_balance FROM finance_user_settings WHERE owner_id='$OWNER_B';")" '510.00' 'owner B reserve isolation'
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_B' AND description='Internet B';")" '1' 'owner B bill isolation'
assert_eq "$(scalar "SELECT count(*) FROM financeflow_private.idempotency_operations WHERE owner_id='$OWNER_B';")" '2' 'owner B replay rows'

# A new key deliberately represents a new intent, even with identical values.
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_reserve('reserve-new-0000001','10.00');"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_bill('bill-new-000000001','Internet','123.45',DATE '2026-09-10',NULL);"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_add_income('income-new-000001','Salary','1000.00',DATE '2026-08-14',NULL,'salary',false);"
run_as_owner "$OWNER_A" "SELECT public.finance_idempotent_create_recurring_template('recurring-new-001','Rent','900.00',DATE '2026-09-05',NULL,'monthly',5);"
assert_eq "$(scalar "SELECT emergency_fund_balance FROM finance_user_settings WHERE owner_id='$OWNER_A';")" '120.00' 'new reserve intent'
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_A' AND description='Internet';")" '2' 'new bill intent'
assert_eq "$(scalar "SELECT count(*) FROM finance_incomes WHERE owner_id='$OWNER_A' AND title='Salary';")" '2' 'new income intent'
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_A' AND description='Rent' AND is_recurring=true;")" '2' 'new recurring intent'

# Same-key concurrency: all transports target one logical operation.
run_concurrent_same_call reserve "$OWNER_A" "SELECT public.finance_idempotent_add_reserve('reserve-concurrent1','10.00');"
assert_eq "$(scalar "SELECT emergency_fund_balance FROM finance_user_settings WHERE owner_id='$OWNER_A';")" '130.00' 'concurrent reserve once'
assert_eq "$(scalar "SELECT count(*) FROM financeflow_private.idempotency_operations WHERE owner_id='$OWNER_A' AND operation_type='reserve_add' AND idempotency_key='reserve-concurrent1';")" '1' 'concurrent reserve ledger once'

run_concurrent_same_call bill "$OWNER_A" "SELECT public.finance_idempotent_add_bill('bill-concurrent01','Concurrent bill','42.00',DATE '2026-10-01',NULL);"
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_A' AND description='Concurrent bill';")" '1' 'concurrent bill once'
assert_eq "$(scalar "SELECT count(*) FROM financeflow_private.idempotency_operations WHERE owner_id='$OWNER_A' AND operation_type='bill_create' AND idempotency_key='bill-concurrent01';")" '1' 'concurrent bill ledger once'

run_concurrent_same_call income "$OWNER_A" "SELECT public.finance_idempotent_add_income('income-concurrent1','Concurrent income','42.00',DATE '2026-08-14',NULL,'extra',false);"
assert_eq "$(scalar "SELECT count(*) FROM finance_incomes WHERE owner_id='$OWNER_A' AND title='Concurrent income';")" '1' 'concurrent income once'
assert_eq "$(scalar "SELECT count(*) FROM financeflow_private.idempotency_operations WHERE owner_id='$OWNER_A' AND operation_type='income_create' AND idempotency_key='income-concurrent1';")" '1' 'concurrent income ledger once'

run_concurrent_same_call recurring "$OWNER_A" "SELECT public.finance_idempotent_create_recurring_template('recurring-conc01','Concurrent recurring','42.00',DATE '2026-10-02',NULL,'monthly',2);"
assert_eq "$(scalar "SELECT count(*) FROM finance_bills WHERE owner_id='$OWNER_A' AND description='Concurrent recurring' AND is_recurring=true;")" '1' 'concurrent recurring template once'
assert_eq "$(scalar "SELECT count(*) FROM financeflow_private.idempotency_operations WHERE owner_id='$OWNER_A' AND operation_type='recurring_template_create' AND idempotency_key='recurring-conc01';")" '1' 'concurrent recurring ledger once'

echo 'FINANCIAL_IDEMPOTENCY_POSTGRES=pass'
