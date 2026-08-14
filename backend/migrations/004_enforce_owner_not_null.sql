-- Apply after 003 and an explicit owner_id backfill for any existing rows.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM finance_bills WHERE owner_id IS NULL)
       OR EXISTS (SELECT 1 FROM finance_incomes WHERE owner_id IS NULL)
       OR EXISTS (SELECT 1 FROM finance_user_settings WHERE owner_id IS NULL) THEN
        RAISE EXCEPTION 'owner_id backfill is required before enforcing non-null ownership';
    END IF;
END $$;

ALTER TABLE finance_bills ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE finance_incomes ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE finance_user_settings ALTER COLUMN owner_id SET NOT NULL;
