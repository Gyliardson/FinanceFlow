import os
from collections.abc import Iterable

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from auth_middleware import SupabaseAuthMiddleware
from main import APIKeyMiddleware, PUBLIC_PATHS, app as legacy_app
from secure_routes import get_private_receipt_access, pay_bill_with_private_receipt


DEFAULT_DEVELOPMENT_ORIGINS = (
    "http://localhost:19006",
    "http://127.0.0.1:19006",
    "http://localhost:8081",
    "http://127.0.0.1:8081",
)


def _split_origins(raw: str | None) -> list[str]:
    if raw is None:
        return []
    origins = []
    for item in raw.split(","):
        origin = item.strip().rstrip("/")
        if origin and origin not in origins:
            origins.append(origin)
    return origins


def configured_cors_origins(
    *,
    environment: str | None = None,
    raw_origins: str | None = None,
) -> list[str]:
    """Return explicit browser origins; production never falls back to wildcard."""
    effective_environment = (environment or os.getenv("ENVIRONMENT", "development")).strip().lower()
    if raw_origins is None:
        raw_origins = os.getenv("CORS_ALLOWED_ORIGINS")

    configured = _split_origins(raw_origins)
    if configured:
        if "*" in configured:
            raise ValueError("CORS_ALLOWED_ORIGINS must list explicit origins; wildcard is forbidden.")
        return configured

    if effective_environment in {"development", "dev", "test"}:
        return list(DEFAULT_DEVELOPMENT_ORIGINS)
    return []


def _remove_middleware_classes(app: FastAPI, classes: Iterable[type]) -> None:
    class_set = set(classes)
    app.user_middleware = [
        item for item in app.user_middleware if getattr(item, "cls", None) not in class_set
    ]
    app.middleware_stack = None


def _remove_route(app: FastAPI, *, path: str, method: str) -> None:
    target_method = method.upper()
    app.router.routes = [
        route
        for route in app.router.routes
        if not (
            getattr(route, "path", None) == path
            and target_method in (getattr(route, "methods", None) or set())
        )
    ]


def _install_secure_route_overrides(app: FastAPI) -> None:
    # Remove the legacy route that persists public receipt URLs. Re-adding on an
    # already configured app is safe because both secure paths are removed first.
    _remove_route(app, path="/bills/{bill_id}/pay", method="POST")
    _remove_route(app, path="/bills/{bill_id}/receipt", method="GET")

    app.add_api_route(
        "/bills/{bill_id}/pay",
        pay_bill_with_private_receipt,
        methods=["POST"],
        tags=["Bills", "Payment"],
    )
    app.add_api_route(
        "/bills/{bill_id}/receipt",
        get_private_receipt_access,
        methods=["GET"],
        tags=["Bills", "Payment"],
    )


def configure_runtime(app: FastAPI) -> FastAPI:
    """Install the production security composition over the legacy route module."""
    _remove_middleware_classes(app, (APIKeyMiddleware, CORSMiddleware, SupabaseAuthMiddleware))
    _install_secure_route_overrides(app)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=configured_cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.add_middleware(SupabaseAuthMiddleware, public_paths=PUBLIC_PATHS)
    return app


def create_app() -> FastAPI:
    """Uvicorn factory for the production authorization composition root."""
    return configure_runtime(legacy_app)
