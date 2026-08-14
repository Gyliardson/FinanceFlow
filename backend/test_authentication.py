from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest

from authentication import AuthenticationError, authenticate_bearer_header, extract_bearer_token

USER_ID = "11111111-1111-1111-1111-111111111111"


@pytest.mark.parametrize(
    "header",
    [None, "", "Basic abc", "Bearer", "Bearer ", "Bearer token with spaces"],
)
def test_extract_bearer_token_rejects_missing_or_malformed_header(header):
    with pytest.raises(AuthenticationError):
        extract_bearer_token(header)


def test_extract_bearer_token_accepts_case_insensitive_scheme():
    assert extract_bearer_token("bearer synthetic-jwt") == "synthetic-jwt"


@patch("authentication.get_user_supabase_client")
@patch("authentication.get_supabase_auth_client")
def test_authenticate_bearer_header_validates_user_before_building_data_client(
    mock_auth_client,
    mock_user_client,
):
    auth = mock_auth_client.return_value.auth
    auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id=USER_ID))
    data_client = Mock(name="rls_scoped_data_client")
    mock_user_client.return_value = data_client

    session = authenticate_bearer_header("Bearer verified-jwt")

    auth.get_user.assert_called_once_with("verified-jwt")
    mock_user_client.assert_called_once_with("verified-jwt")
    assert session.user_id == USER_ID
    assert session.access_token == "verified-jwt"
    assert session.data_client is data_client


@patch("authentication.get_user_supabase_client")
@patch("authentication.get_supabase_auth_client")
def test_invalid_token_never_builds_data_client(mock_auth_client, mock_user_client):
    mock_auth_client.return_value.auth.get_user.side_effect = RuntimeError("auth rejected token")

    with pytest.raises(AuthenticationError, match="Invalid or expired"):
        authenticate_bearer_header("Bearer rejected-jwt")

    mock_user_client.assert_not_called()


@patch("authentication.get_user_supabase_client")
@patch("authentication.get_supabase_auth_client")
def test_missing_user_in_auth_response_fails_closed(mock_auth_client, mock_user_client):
    mock_auth_client.return_value.auth.get_user.return_value = SimpleNamespace(user=None)

    with pytest.raises(AuthenticationError):
        authenticate_bearer_header("Bearer no-user-jwt")

    mock_user_client.assert_not_called()
