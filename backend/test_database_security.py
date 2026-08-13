from unittest.mock import Mock, patch

import pytest

import database


def test_storage_client_requires_service_role(monkeypatch):
    monkeypatch.setattr(database, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(database, "SUPABASE_SERVICE_ROLE_KEY", None)

    with pytest.raises(ValueError, match="service-role|SERVICE_ROLE|service role|SUPABASE_SERVICE_ROLE_KEY"):
        database.get_supabase_storage_client()


@patch("database.get_supabase_storage_client")
def test_new_receipt_bucket_is_created_private(mock_get_storage):
    client = mock_get_storage.return_value

    database.ensure_receipts_bucket()

    client.storage.create_bucket.assert_called_once_with("receipts", options={"public": False})
    client.storage.update_bucket.assert_not_called()


@patch("database.get_supabase_storage_client")
def test_existing_receipt_bucket_is_forced_private(mock_get_storage):
    client = mock_get_storage.return_value
    client.storage.create_bucket.side_effect = Exception("409 already exists")

    database.ensure_receipts_bucket()

    client.storage.update_bucket.assert_called_once_with("receipts", options={"public": False})


@patch("database.get_supabase_storage_client")
def test_unexpected_bucket_error_fails_closed(mock_get_storage):
    client = mock_get_storage.return_value
    client.storage.create_bucket.side_effect = RuntimeError("network unavailable")

    with pytest.raises(RuntimeError, match="network unavailable"):
        database.ensure_receipts_bucket()

    client.storage.update_bucket.assert_not_called()
