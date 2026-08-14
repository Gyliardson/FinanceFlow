import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from auth_middleware import SupabaseAuthMiddleware
from database import ensure_receipts_bucket
from main import app as route_source_app
from secure_ocr_routes import upload_receipt_for_ocr
from secure_recurring_routes import (
    create_recurring_bill_user_scoped,
    generate_recurring_instances_user_scoped,
)
from secure_routes import get_private_receipt_access, pay_bill_with_private_receipt


PUBLIC_PATHS = {"/", "/health", "/healthz", "/docs", "/openapi.json", "/redoc"}
SECURE_ROUTE_KEYS = {
    ("/bills/{bill_id}/pay", "POST"),
    ("/bills/{bill_id}/receipt", "GET"),
    ("/recurring-bills", "POST"),
    ("/recurring-bills/generate", "POST"),
    ("/upload-receipt", "POST"),
}
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


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_receipts_bucket()
    # External scrapers/scheduler remain intentionally inactive. They are not
    # registered as routes in the portfolio runtime.
    yield


def _is_security_sensitive_route(route) -> bool:
    path = getattr(route, "path", None)
    methods = getattr(route, "methods", None) or set()
    return any((path, method) in SECURE_ROUTE_KEYS for method in methods)


def _install_existing_route_contract(app: FastAPI) -> None:
    """Copy the current non-sensitive route contract onto a fresh application.

    This is an intermediate extraction boundary: production no longer mutates a
    module-global FastAPI instance, while route handlers are moved out of the
    legacy module incrementally behind composition regression tests.
    """
    for route in route_source_app.router.routes:
        if _is_security_sensitive_route(route):
            continue
        app.router.routes.append(route)


def _install_secure_routes(app: FastAPI) -> None:
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
    app.add_api_route(
        "/recurring-bills",
        create_recurring_bill_user_scoped,
        methods=["POST"],
        tags=["Recurring Bills"],
    )
    app.add_api_route(
        "/recurring-bills/generate",
        generate_recurring_instances_user_scoped,
        methods=["POST"],
        tags=["Recurring Bills"],
    )
    app.add_api_route(
        "/upload-receipt",
        upload_receipt_for_ocr,
        methods=["POST"],
        tags=["Bills", "OCR"],
    )


async def _privacy_safe_http_exception_handler(
    _request: Request,
    exc: HTTPException,
) -> JSONResponse:
    detail = exc.detail if exc.status_code < 500 else "Internal server error."
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": detail},
        headers=exc.headers,
    )


def create_app() -> FastAPI:
    """Construct a fresh production application with explicit security boundaries."""
    app = FastAPI(
        title="FinanceFlow API",
        description="Backend API para automação e notificação de contas a pagar.",
        version="0.2.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    _install_existing_route_contract(app)
    _install_secure_routes(app)
    app.add_exception_handler(HTTPException, _privacy_safe_http_exception_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=configured_cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    app.add_middleware(SupabaseAuthMiddleware, public_paths=PUBLIC_PATHS)
    return app
