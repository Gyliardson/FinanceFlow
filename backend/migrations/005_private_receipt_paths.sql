-- Private receipt objects must be persisted by storage path, never by public URL.
-- Existing receipt_url values are intentionally preserved for explicit/manual
-- reconciliation; this migration does not delete or rewrite financial evidence.

ALTER TABLE finance_bills
    ADD COLUMN IF NOT EXISTS receipt_path TEXT;

CREATE INDEX IF NOT EXISTS ix_finance_bills_owner_receipt_path
    ON finance_bills(owner_id, receipt_path)
    WHERE receipt_path IS NOT NULL;
