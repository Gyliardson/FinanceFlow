from pathlib import Path

BACKEND_DIR = Path(__file__).parent


def test_bootstrap_schema_does_not_restore_permissive_rls():
    schema = (BACKEND_DIR / "supabase_schema.sql").read_text(encoding="utf-8").lower()

    assert "allow_all_mvp" not in schema
    assert "using (true)" not in schema
    assert "with check (true)" not in schema
    assert schema.count("owner_id uuid default auth.uid()") == 3


def test_receipt_path_migration_enforces_owner_namespace():
    migration = (BACKEND_DIR / "migrations/005_private_receipt_paths.sql").read_text(encoding="utf-8").lower()

    assert "receipt_path text" in migration
    assert "finance_bills_receipt_path_owner_scope" in migration
    assert "receipt_path like owner_id::text || '/%'" in migration
