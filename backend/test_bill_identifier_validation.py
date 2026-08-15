from fastapi.testclient import TestClient

from authentication import AuthenticatedSession
from runtime import create_app


class _ProviderMustNotBeUsed:
    def __getattr__(self, name):
        raise AssertionError(f"malformed bill identifier reached provider attribute {name}")


def _authenticated_client(monkeypatch) -> TestClient:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    monkeypatch.setattr("api_handlers.ensure_receipts_bucket", lambda: None)
    monkeypatch.setattr(
        "auth_middleware.authenticate_bearer_header",
        lambda _header: AuthenticatedSession(
            user_id="11111111-1111-1111-1111-111111111111",
            access_token="synthetic-test-token",
            data_client=_ProviderMustNotBeUsed(),
        ),
    )
    return TestClient(create_app())


def _assert_bill_id_validation(response):
    assert response.status_code == 422
    errors = response.json().get("detail", [])
    assert any(error.get("loc", [])[-1:] == ["bill_id"] for error in errors)


def test_malformed_path_bill_ids_fail_before_data_api(monkeypatch):
    client = _authenticated_client(monkeypatch)
    headers = {"Authorization": "Bearer synthetic-test-token"}

    requests = (
        client.get("/bills/not-a-uuid/detail", headers=headers),
        client.post("/bills/not-a-uuid/pay-no-receipt", headers=headers),
        client.get("/bills/not-a-uuid/receipt", headers=headers),
        client.post(
            "/bills/not-a-uuid/pay",
            headers=headers,
            files={"file": ("receipt.jpg", b"synthetic", "image/jpeg")},
        ),
    )

    for response in requests:
        _assert_bill_id_validation(response)


def test_validate_bill_body_rejects_malformed_uuid_before_data_api(monkeypatch):
    client = _authenticated_client(monkeypatch)
    response = client.post(
        "/validate-bill",
        headers={"Authorization": "Bearer synthetic-test-token"},
        json={"bill_id": "not-a-uuid"},
    )

    _assert_bill_id_validation(response)
