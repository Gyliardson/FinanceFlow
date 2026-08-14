from unittest.mock import Mock, patch

import pytest

import database
from request_context import bind_request_client, reset_request_client

OWNER_ID = "11111111-1111-1111-1111-111111111111"
OTHER_OWNER_ID = "22222222-2222-2222-2222-222222222222"
BILL_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
OTHER_BILL_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"


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


def test_receipt_object_key_is_owner_and_bill_scoped():
    key = database.build_receipt_object_key(OWNER_ID, BILL_ID, ".PDF")

    owner, bill, filename = key.split("/")
    assert owner == OWNER_ID
    assert bill == BILL_ID
    assert filename.endswith(".pdf")
    assert len(filename.removesuffix(".pdf")) == 32


def test_receipt_object_key_rejects_invalid_identifiers():
    with pytest.raises(ValueError):
        database.build_receipt_object_key("not-a-uuid", BILL_ID, "pdf")
    with pytest.raises(ValueError):
        database.build_receipt_object_key(OWNER_ID, "not-a-uuid", "pdf")


def test_receipt_object_key_rejects_invalid_extension():
    with pytest.raises(ValueError, match="extension"):
        database.build_receipt_object_key(OWNER_ID, BILL_ID, "pdf!")


def test_receipt_path_validation_rejects_cross_owner_or_cross_bill_access():
    path = f"{OWNER_ID}/{BILL_ID}/synthetic.pdf"
    assert database.validate_receipt_object_key(OWNER_ID, BILL_ID, path) == path

    with pytest.raises(ValueError, match="authenticated bill owner"):
        database.validate_receipt_object_key(OTHER_OWNER_ID, BILL_ID, path)
    with pytest.raises(ValueError, match="authenticated bill owner"):
        database.validate_receipt_object_key(OWNER_ID, OTHER_BILL_ID, path)


def test_receipt_path_validation_rejects_nested_or_empty_filename():
    with pytest.raises(ValueError, match="Invalid receipt object path"):
        database.validate_receipt_object_key(OWNER_ID, BILL_ID, f"{OWNER_ID}/{BILL_ID}/nested/file.pdf")
    with pytest.raises(ValueError, match="Invalid receipt object path"):
        database.validate_receipt_object_key(OWNER_ID, BILL_ID, f"{OWNER_ID}/{BILL_ID}/")


@patch("database.get_supabase_storage_client")
def test_signed_receipt_url_is_short_lived_and_owner_scoped(mock_get_storage):
    path = f"{OWNER_ID}/{BILL_ID}/synthetic.pdf"
    bucket = mock_get_storage.return_value.storage.from_.return_value
    bucket.create_signed_url.return_value = {"signedURL": "https://example.invalid/signed"}

    result = database.create_receipt_signed_url(OWNER_ID, BILL_ID, path)

    mock_get_storage.return_value.storage.from_.assert_called_once_with("receipts")
    bucket.create_signed_url.assert_called_once_with(
        path,
        database.DEFAULT_RECEIPT_SIGNED_URL_TTL_SECONDS,
    )
    assert result == {"signedURL": "https://example.invalid/signed"}


@patch("database.get_supabase_storage_client")
def test_signed_receipt_url_rejects_excessive_or_nonpositive_expiry(mock_get_storage):
    path = f"{OWNER_ID}/{BILL_ID}/synthetic.pdf"

    for expiry in (0, -1, database.MAX_RECEIPT_SIGNED_URL_TTL_SECONDS + 1):
        with pytest.raises(ValueError, match="expiry"):
            database.create_receipt_signed_url(OWNER_ID, BILL_ID, path, expires_in=expiry)

    mock_get_storage.assert_not_called()


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
