from pathlib import Path


def test_bootstrap_schema_does_not_restore_permissive_rls():
    schema = (Path(__file__).parent / "supabase_schema.sql").read_text(encoding="utf-8").lower()

    assert "allow_all_mvp" not in schema
    assert "using (true)" not in schema
    assert "with check (true)" not in schema
    assert schema.count("owner_id uuid default auth.uid()") == 3
