from unittest.mock import Mock, patch

import pytest

import database
from request_context import bind_request_client, reset_request_client


def test_storage_client_requires_service_role(monkeypatch):
    monkeypatch.setattr(database, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(database, "SUPABASE_SERVICE_ROLE_KEY", None)

    with pytest.raises(ValueError, match="service-role|SERVICE_ROLE|service role|SUPABASE_SERVICE_ROLE_KEY"):
        database.get_supabase_storage_client()


def test_user_scoped_client_requires_access_token():
    with pytest.raises(ValueError, match="access token"):
        database.get_user_supabase_client("")


@patch("database.create_client")
def test_user_scoped_client_sets_postgrest_bearer_token(mock_create_client, monkeypatch):
    monkeypatch.setattr(database, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(database, "SUPABASE_KEY", "publishable-test-key")
    client = mock_create_client.return_value

    result = database.get_user_supabase_client("verified-user-jwt")

    mock_create_client.assert_called_once_with("https://example.supabase.co", "publishable-test-key")
    client.postgrest.auth.assert_called_once_with("verified-user-jwt")
    assert result is client


@patch("database.create_client")
def test_bound_request_client_takes_precedence_over_anonymous_client(mock_create_client):
    request_client = Mock(name="request_scoped_data_client")
    token = bind_request_client(request_client)
    try:
        assert database.get_supabase_client() is request_client
    finally:
        reset_request_client(token)

    mock_create_client.assert_not_called()


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
