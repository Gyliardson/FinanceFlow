-- FinanceFlow multi-user ownership foundation.
--
-- Security posture after this migration:
-- * anonymous Data API access has no permissive policy;
-- * authenticated users may only access rows whose owner_id equals auth.uid();
-- * existing rows with NULL owner_id become inaccessible until explicitly backfilled;
-- * owner_id remains nullable temporarily so an operator can perform an auditable
--   service-role/manual backfill before migration 004 enforces NOT NULL.

ALTER TABLE finance_bills
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE finance_incomes
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE finance_user_settings
    ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS ix_finance_bills_owner_id
    ON finance_bills(owner_id);
CREATE INDEX IF NOT EXISTS ix_finance_incomes_owner_id
    ON finance_incomes(owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_user_settings_owner_id
    ON finance_user_settings(owner_id)
    WHERE owner_id IS NOT NULL;

ALTER TABLE finance_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_incomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_user_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS allow_all_mvp ON finance_bills;
DROP POLICY IF EXISTS allow_all_mvp_incomes ON finance_incomes;
DROP POLICY IF EXISTS allow_all_mvp_settings ON finance_user_settings;
DROP POLICY IF EXISTS finance_bills_owner_select ON finance_bills;
DROP POLICY IF EXISTS finance_bills_owner_insert ON finance_bills;
DROP POLICY IF EXISTS finance_bills_owner_update ON finance_bills;
DROP POLICY IF EXISTS finance_bills_owner_delete ON finance_bills;
DROP POLICY IF EXISTS finance_incomes_owner_select ON finance_incomes;
DROP POLICY IF EXISTS finance_incomes_owner_insert ON finance_incomes;
DROP POLICY IF EXISTS finance_incomes_owner_update ON finance_incomes;
DROP POLICY IF EXISTS finance_incomes_owner_delete ON finance_incomes;
DROP POLICY IF EXISTS finance_settings_owner_select ON finance_user_settings;
DROP POLICY IF EXISTS finance_settings_owner_insert ON finance_user_settings;
DROP POLICY IF EXISTS finance_settings_owner_update ON finance_user_settings;
DROP POLICY IF EXISTS finance_settings_owner_delete ON finance_user_settings;

CREATE POLICY finance_bills_owner_select
ON finance_bills FOR SELECT TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_bills_owner_insert
ON finance_bills FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_bills_owner_update
ON finance_bills FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id)
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_bills_owner_delete
ON finance_bills FOR DELETE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_incomes_owner_select
ON finance_incomes FOR SELECT TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_incomes_owner_insert
ON finance_incomes FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_incomes_owner_update
ON finance_incomes FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id)
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_incomes_owner_delete
ON finance_incomes FOR DELETE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_settings_owner_select
ON finance_user_settings FOR SELECT TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_settings_owner_insert
ON finance_user_settings FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_settings_owner_update
ON finance_user_settings FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id)
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_settings_owner_delete
ON finance_user_settings FOR DELETE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

-- Explicit grants complement RLS. Anonymous users receive no table privileges.
REVOKE ALL ON finance_bills FROM anon;
REVOKE ALL ON finance_incomes FROM anon;
REVOKE ALL ON finance_user_settings FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_bills TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_incomes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_user_settings TO authenticated;
