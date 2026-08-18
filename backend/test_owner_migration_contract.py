from pathlib import Path


def test_owner_not_null_promotion_requires_explicit_backfill():
    sql = (Path(__file__).parent / "migrations/004_enforce_owner_not_null.sql").read_text(encoding="utf-8").lower()

    assert "owner_id is null" in sql
    assert "raise exception" in sql
    assert "set not null" in sql
    assert "delete from" not in sql
