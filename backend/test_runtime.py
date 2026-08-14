import asyncio
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from auth_middleware import SupabaseAuthMiddleware
from runtime import _privacy_safe_http_exception_handler, configured_cors_origins, create_app
from secure_ocr_routes import upload_receipt_for_ocr
from secure_recurring_routes import (
    create_recurring_bill_user_scoped,
    generate_recurring_instances_user_scoped,
)
from secure_routes import (
    add_to_reserve_atomic,
    get_private_receipt_access,
    pay_bill_with_private_receipt,
    pay_bill_without_receipt,
)


def _middleware_classes(app: FastAPI):
    return [getattr(item, "cls", None) for item in app.user_middleware]


def _matching_routes(app: FastAPI, path: str, method: str):
    return [
        route
        for route in app.router.routes
        if getattr(route, "path", None) == path
        and method.upper() in (getattr(route, "methods", None) or set())
    ]


def _production_app(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    return create_app()


def test_production_cors_defaults_to_no_browser_origins():
    assert configured_cors_origins(environment="production", raw_origins="") == []


def test_explicit_cors_origins_are_normalized_and_deduplicated():
    assert configured_cors_origins(
        environment="production",
        raw_origins="https://app.example.com/, https://app.example.com,https://admin.example.com/",
    ) == ["https://app.example.com", "https://admin.example.com"]


def test_wildcard_cors_is_rejected():
    with pytest.raises(ValueError, match="wildcard is forbidden"):
        configured_cors_origins(environment="production", raw_origins="*")


def test_development_cors_has_only_explicit_local_origins():
    origins = configured_cors_origins(environment="development", raw_origins="")
    assert origins
    assert "*" not in origins
    assert all(origin.startswith(("http://localhost:", "http://127.0.0.1:")) for origin in origins)


def test_factory_installs_one_auth_and_one_cors_middleware(monkeypatch):
    app = _production_app(monkeypatch)
    classes = _middleware_classes(app)
    assert classes.count(SupabaseAuthMiddleware) == 1
    assert classes.count(CORSMiddleware) == 1


def test_runtime_registers_only_secure_sensitive_handlers(monkeypatch):
    app = _production_app(monkeypatch)
    expected = (
        ("/bills/{bill_id}/pay", "POST", pay_bill_with_private_receipt),
        ("/bills/{bill_id}/pay-no-receipt", "POST", pay_bill_without_receipt),
        ("/bills/{bill_id}/receipt", "GET", get_private_receipt_access),
        ("/recurring-bills", "POST", create_recurring_bill_user_scoped),
        ("/recurring-bills/generate", "POST", generate_recurring_instances_user_scoped),
        ("/upload-receipt", "POST", upload_receipt_for_ocr),
        ("/insights/reserve", "POST", add_to_reserve_atomic),
    )
    for path, method, endpoint in expected:
        routes = _matching_routes(app, path, method)
        assert len(routes) == 1
        assert routes[0].endpoint is endpoint


def test_repeated_factories_do_not_accumulate_routes_or_middleware(monkeypatch):
    first = _production_app(monkeypatch)
    second = _production_app(monkeypatch)
    assert first is not second
    assert _middleware_classes(first) == _middleware_classes(second)
    assert [
        (route.path, tuple(sorted(route.methods or ())))
        for route in first.router.routes
    ] == [
        (route.path, tuple(sorted(route.methods or ())))
        for route in second.router.routes
    ]


def test_runtime_rejects_missing_bearer_and_keeps_public_paths_public(monkeypatch):
    app = _production_app(monkeypatch)
    client = TestClient(app)

    public_response = client.get("/health")
    assert public_response.status_code == 200

    protected_response = client.get("/bills")
    assert protected_response.status_code == 401
    assert protected_response.headers["WWW-Authenticate"] == "Bearer"
    assert protected_response.json() == {
        "detail": "Unauthorized – invalid or expired bearer token."
    }


def test_runtime_rejects_malformed_bearer_without_calling_private_handler(monkeypatch):
    app = _production_app(monkeypatch)
    client = TestClient(app)
    response = client.get("/bills", headers={"Authorization": "Token not-a-bearer"})
    assert response.status_code == 401
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_runtime_sanitizes_internal_http_errors_but_preserves_client_errors():
    internal = asyncio.run(
        _privacy_safe_http_exception_handler(
            None,
            HTTPException(status_code=500, detail="database/provider secret detail"),
        )
    )
    assert internal.status_code == 500
    assert json.loads(internal.body) == {"detail": "Internal server error."}

    client_error = asyncio.run(
        _privacy_safe_http_exception_handler(
            None,
            HTTPException(status_code=409, detail="Already completed"),
        )
    )
    assert client_error.status_code == 409
    assert json.loads(client_error.body) == {"detail": "Already completed"}


def test_cors_preflight_allows_only_configured_origin(monkeypatch):
    app = _production_app(monkeypatch)
    client = TestClient(app)

    allowed = client.options(
        "/bills",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://app.example.com"

    denied = client.options(
        "/bills",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers
