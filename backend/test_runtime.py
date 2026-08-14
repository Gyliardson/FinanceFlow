import asyncio
import json

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from auth_middleware import SupabaseAuthMiddleware
from main import APIKeyMiddleware
from runtime import (
    _privacy_safe_http_exception_handler,
    configure_runtime,
    configured_cors_origins,
)
from secure_recurring_routes import (
    create_recurring_bill_user_scoped,
    generate_recurring_instances_user_scoped,
)
from secure_routes import get_private_receipt_access, pay_bill_with_private_receipt


def _middleware_classes(app: FastAPI):
    return [getattr(item, "cls", None) for item in app.user_middleware]


def _matching_routes(app: FastAPI, path: str, method: str):
    return [
        route
        for route in app.router.routes
        if getattr(route, "path", None) == path
        and method.upper() in (getattr(route, "methods", None) or set())
    ]


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


def test_configure_runtime_removes_legacy_shared_secret_middleware(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")

    app = FastAPI()
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(APIKeyMiddleware)

    configure_runtime(app)

    classes = _middleware_classes(app)
    assert APIKeyMiddleware not in classes
    assert classes.count(SupabaseAuthMiddleware) == 1
    assert classes.count(CORSMiddleware) == 1


def test_runtime_replaces_legacy_security_sensitive_routes(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    app = FastAPI()

    async def legacy_pay(bill_id: str):
        return {"legacy": bill_id}

    async def legacy_recurring():
        return {"legacy": True}

    app.add_api_route("/bills/{bill_id}/pay", legacy_pay, methods=["POST"])
    app.add_api_route("/recurring-bills", legacy_recurring, methods=["POST"])
    app.add_api_route("/recurring-bills/generate", legacy_recurring, methods=["POST"])
    configure_runtime(app)

    expected = (
        ("/bills/{bill_id}/pay", "POST", pay_bill_with_private_receipt),
        ("/bills/{bill_id}/receipt", "GET", get_private_receipt_access),
        ("/recurring-bills", "POST", create_recurring_bill_user_scoped),
        ("/recurring-bills/generate", "POST", generate_recurring_instances_user_scoped),
    )
    for path, method, endpoint in expected:
        routes = _matching_routes(app, path, method)
        assert len(routes) == 1
        assert routes[0].endpoint is endpoint


def test_configure_runtime_is_idempotent(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    app = FastAPI()

    configure_runtime(app)
    configure_runtime(app)

    classes = _middleware_classes(app)
    assert classes.count(SupabaseAuthMiddleware) == 1
    assert classes.count(CORSMiddleware) == 1
    assert len(_matching_routes(app, "/bills/{bill_id}/pay", "POST")) == 1
    assert len(_matching_routes(app, "/bills/{bill_id}/receipt", "GET")) == 1
    assert len(_matching_routes(app, "/recurring-bills", "POST")) == 1
    assert len(_matching_routes(app, "/recurring-bills/generate", "POST")) == 1


def test_runtime_rejects_missing_bearer_and_keeps_public_paths_public(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    app = FastAPI()

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/private")
    async def private():
        return {"secret": False}

    configure_runtime(app)
    client = TestClient(app)

    public_response = client.get("/health")
    assert public_response.status_code == 200

    protected_response = client.get("/private")
    assert protected_response.status_code == 401
    assert protected_response.headers["WWW-Authenticate"] == "Bearer"
    assert protected_response.json() == {
        "detail": "Unauthorized – invalid or expired bearer token."
    }


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
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://app.example.com")
    app = FastAPI()

    @app.get("/private")
    async def private():
        return {"ok": True}

    configure_runtime(app)
    client = TestClient(app)

    allowed = client.options(
        "/private",
        headers={
            "Origin": "https://app.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == "https://app.example.com"

    denied = client.options(
        "/private",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Authorization",
        },
    )
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers
