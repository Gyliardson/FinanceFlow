from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from auth_middleware import SupabaseAuthMiddleware
from request_context import get_request_client, get_request_user_id

USER_ID = "11111111-1111-1111-1111-111111111111"


def _build_app():
    app = FastAPI()
    app.add_middleware(SupabaseAuthMiddleware, public_paths={"/health"})

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/protected")
    async def protected():
        return {
            "user_id": get_request_user_id(),
            "has_client": get_request_client() is not None,
        }

    return app


def test_public_path_does_not_require_bearer_token():
    client = TestClient(_build_app())
    assert client.get("/health").status_code == 200


def test_missing_bearer_token_is_rejected_with_auth_challenge():
    client = TestClient(_build_app())

    response = client.get("/protected")

    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized – invalid or expired bearer token."}
    assert response.headers["www-authenticate"] == "Bearer"


@patch("auth_middleware.authenticate_bearer_header")
def test_verified_session_is_bound_only_for_request_lifetime(mock_authenticate):
    scoped_client = Mock(name="rls_scoped_client")
    mock_authenticate.return_value = SimpleNamespace(
        user_id=USER_ID,
        access_token="verified-jwt",
        data_client=scoped_client,
    )
    client = TestClient(_build_app())

    response = client.get("/protected", headers={"Authorization": "Bearer verified-jwt"})

    assert response.status_code == 200
    assert response.json() == {"user_id": USER_ID, "has_client": True}
    mock_authenticate.assert_called_once_with("Bearer verified-jwt")
    assert get_request_client() is None
    assert get_request_user_id() is None
