-- ==========================================================
-- FinanceFlow - Initial PostgreSQL / Supabase schema
--
-- Security baseline:
-- * financial rows are owned by auth.users;
-- * authenticated users can only access rows where owner_id = auth.uid();
-- * anonymous access is not granted;
-- * no temporary allow-all MVP policy is created.
--
-- Apply the numbered migrations after this bootstrap schema. Existing databases
-- created from an older permissive baseline must still run migrations 003/004
-- and perform the documented explicit owner backfill before NOT NULL promotion.
-- ==========================================================

CREATE TABLE IF NOT EXISTS finance_bills (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    due_date DATE NOT NULL,
    barcode TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_finance_bills_owner_id ON finance_bills(owner_id);
ALTER TABLE finance_bills ENABLE ROW LEVEL SECURITY;

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

CREATE TABLE IF NOT EXISTS finance_incomes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    date DATE NOT NULL,
    type TEXT DEFAULT 'salary' CHECK (type IN ('salary', 'extra', 'adjustment')),
    is_recurring BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_finance_incomes_owner_id ON finance_incomes(owner_id);
ALTER TABLE finance_incomes ENABLE ROW LEVEL SECURITY;

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

CREATE TABLE IF NOT EXISTS finance_user_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    owner_id UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    initial_balance DECIMAL(10, 2) DEFAULT 0.0,
    initial_balance_date DATE DEFAULT CURRENT_DATE,
    emergency_fund_goal DECIMAL(10, 2) DEFAULT 0.0,
    emergency_fund_balance DECIMAL(10, 2) DEFAULT 0.0,
    latest_insight_text TEXT,
    latest_insight_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_user_settings_owner_id
    ON finance_user_settings(owner_id)
    WHERE owner_id IS NOT NULL;
ALTER TABLE finance_user_settings ENABLE ROW LEVEL SECURITY;

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

REVOKE ALL ON finance_bills FROM anon;
REVOKE ALL ON finance_incomes FROM anon;
REVOKE ALL ON finance_user_settings FROM anon;

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_bills TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_incomes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_user_settings TO authenticated;
