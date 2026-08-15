from pathlib import Path

import apply_migration


EXPECTED_MIGRATIONS = [
    "001_recurring_bills.sql",
    "002_recurring_instance_uniqueness.sql",
    "003_user_ownership_rls.sql",
    "004_enforce_owner_not_null.sql",
    "005_private_receipt_paths.sql",
    "006_financial_idempotency.sql",
    "007_authenticated_data_plane.sql",
    "008_payment_recurring_data_plane.sql",
]


def test_migration_inventory_is_ordered_and_complete():
    assert [path.name for path in apply_migration.migration_files()] == EXPECTED_MIGRATIONS


def test_migration_helper_contains_no_network_or_legacy_schema_mutation():
    source = Path(apply_migration.__file__).read_text(encoding="utf-8")

    assert "create_client" not in source
    assert "SUPABASE_KEY" not in source
    assert "receipt_url TEXT" not in source
    assert "ALTER TABLE" not in source
    assert "INSERT INTO storage.buckets" not in source


def test_migration_helper_is_successful_inventory_only(capsys):
    assert apply_migration.main() == 0
    output = capsys.readouterr().out
    assert "non-mutating" in output
    assert "does NOT apply migrations automatically" in output
    for filename in EXPECTED_MIGRATIONS:
        assert filename in output


def test_clean_room_documents_current_financial_migration_boundary():
    clean_room = (Path(__file__).resolve().parents[1] / "docs" / "CLEAN_ROOM.md").read_text(
        encoding="utf-8"
    )

    latest = EXPECTED_MIGRATIONS[-1]
    assert "backend/migrations/001_...` through `008_..." in clean_room
    assert latest in clean_room
    assert ".github/workflows/financial-idempotency.yml" in clean_room
    assert "not** equivalent to provisioning a production Supabase project" in clean_room
