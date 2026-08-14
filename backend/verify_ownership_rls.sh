#!/usr/bin/env bash
set -euo pipefail

user_a='11111111-1111-1111-1111-111111111111'
user_b='22222222-2222-2222-2222-222222222222'

psql -v ON_ERROR_STOP=1 <<SQL
INSERT INTO auth.users(id) VALUES ('$user_a'), ('$user_b');
INSERT INTO finance_bills(id, owner_id) VALUES ('bill-a', '$user_a'), ('bill-b', '$user_b');
INSERT INTO finance_incomes(id, owner_id) VALUES ('income-a', '$user_a'), ('income-b', '$user_b');
INSERT INTO finance_user_settings(id, owner_id) VALUES ('settings-a', '$user_a'), ('settings-b', '$user_b');
SQL

visible=$(psql -qAtv ON_ERROR_STOP=1 <<SQL
SELECT set_config('request.jwt.claim.sub', '$user_a', false);
SET ROLE authenticated;
SELECT string_agg(id, ',' ORDER BY id) FROM finance_bills;
RESET ROLE;
SQL
)
test "$(printf '%s\n' "$visible" | tail -n1)" = 'bill-a'

default_owner=$(psql -qAtv ON_ERROR_STOP=1 <<SQL
SELECT set_config('request.jwt.claim.sub', '$user_a', false);
SET ROLE authenticated;
INSERT INTO finance_bills(id) VALUES ('bill-default-owner') RETURNING owner_id;
RESET ROLE;
SQL
)
test "$(printf '%s\n' "$default_owner" | tail -n1)" = "$user_a"

if psql -v ON_ERROR_STOP=1 <<SQL
SELECT set_config('request.jwt.claim.sub', '$user_a', false);
SET ROLE authenticated;
INSERT INTO finance_bills(id, owner_id) VALUES ('forged-bill', '$user_b');
SQL
then
  echo 'Authenticated user unexpectedly inserted a row owned by another user.' >&2
  exit 1
fi

changed=$(psql -qAtv ON_ERROR_STOP=1 <<SQL
SELECT set_config('request.jwt.claim.sub', '$user_a', false);
SET ROLE authenticated;
UPDATE finance_bills SET id = 'tampered-bill-b' WHERE id = 'bill-b';
SELECT count(*) FROM finance_bills WHERE id = 'tampered-bill-b';
RESET ROLE;
SQL
)
test "$(printf '%s\n' "$changed" | tail -n1)" = '0'

if psql -v ON_ERROR_STOP=1 <<'SQL'
SET ROLE anon;
SELECT * FROM finance_bills;
SQL
then
  echo 'Anonymous role unexpectedly read finance_bills.' >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -c "INSERT INTO finance_bills(id, owner_id) VALUES ('legacy-null', NULL);"
if psql -v ON_ERROR_STOP=1 -f backend/migrations/004_enforce_owner_not_null.sql; then
  echo 'Migration 004 unexpectedly accepted an unowned historical row.' >&2
  exit 1
fi

test "$(psql -Atc "SELECT count(*) FROM finance_bills WHERE id='legacy-null' AND owner_id IS NULL;")" = '1'
psql -v ON_ERROR_STOP=1 -c "UPDATE finance_bills SET owner_id='$user_a' WHERE id='legacy-null';"
psql -v ON_ERROR_STOP=1 -f backend/migrations/004_enforce_owner_not_null.sql
psql -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_name='finance_bills' AND column_name='owner_id';" | grep -qx 'NO'
psql -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_name='finance_incomes' AND column_name='owner_id';" | grep -qx 'NO'
psql -Atc "SELECT is_nullable FROM information_schema.columns WHERE table_name='finance_user_settings' AND column_name='owner_id';" | grep -qx 'NO'
