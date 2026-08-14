import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api_handlers import (
    get_bill_detail,
    get_bills,
    get_incomes,
    get_insights,
    get_pending_bills,
    get_recurring_bills,
    get_settings,
    health_check,
    healthz_check,
    lifespan,
    refresh_insights,
    root,
    update_settings,
    validate_bill,
)
from api_models import HealthResponse
from auth_middleware import SupabaseAuthMiddleware
from idempotent_routes import (
    add_bill_idempotent,
    add_income_idempotent,
    add_to_reserve_idempotent,
    create_recurring_bill_idempotent,
)
from secure_ocr_routes import upload_receipt_for_ocr
from secure_recurring_routes import generate_recurring_instances_user_scoped
from secure_routes import (
    get_private_receipt_access,
    pay_bill_with_private_receipt,
    pay_bill_without_receipt,
)


PUBLIC_PATHS = {"/", "/health", "/healthz", "/docs", "/openapi.json", "/redoc"}
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


def _install_core_routes(app: FastAPI) -> None:
    app.add_api_route("/", root, methods=["GET"], tags=["Health"])
    app.add_api_route(
        "/healthz", healthz_check, methods=["GET"], tags=["Health"], response_model=HealthResponse
    )
    app.add_api_route(
        "/health", health_check, methods=["GET"], tags=["Health"], response_model=HealthResponse
    )

    app.add_api_route("/bills", get_bills, methods=["GET"], tags=["Bills"])
    app.add_api_route("/bills/pending", get_pending_bills, methods=["GET"], tags=["Bills"])
    app.add_api_route("/add-bill", add_bill_idempotent, methods=["POST"], tags=["Bills"])
    app.add_api_route(
        "/recurring-bills", get_recurring_bills, methods=["GET"], tags=["Recurring Bills"]
    )
    app.add_api_route("/bills/{bill_id}/detail", get_bill_detail, methods=["GET"], tags=["Bills"])
    app.add_api_route(
        "/bills/{bill_id}/pay-no-receipt",
        pay_bill_without_receipt,
        methods=["POST"],
        tags=["Bills", "Payment"],
    )

    app.add_api_route("/incomes", get_incomes, methods=["GET"], tags=["Incomes"])
    app.add_api_route("/incomes", add_income_idempotent, methods=["POST"], tags=["Incomes"])
    app.add_api_route("/settings", get_settings, methods=["GET"], tags=["Settings"])
    app.add_api_route("/settings", update_settings, methods=["POST"], tags=["Settings"])

    app.add_api_route("/insights", get_insights, methods=["GET"], tags=["Insights"])
    app.add_api_route("/insights/refresh", refresh_insights, methods=["POST"], tags=["Insights"])
    app.add_api_route(
        "/insights/reserve", add_to_reserve_idempotent, methods=["POST"], tags=["Insights"]
    )
    app.add_api_route(
        "/validate-bill", validate_bill, methods=["POST"], tags=["Bills", "Validation"]
    )


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
        create_recurring_bill_idempotent,
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
    """Construct the canonical production application with explicit security boundaries."""
    app = FastAPI(
        title="FinanceFlow API",
        description="Backend API para automação e notificação de contas a pagar.",
        version="0.2.0",
        lifespan=lifespan,
    )
    _install_core_routes(app)
    _install_secure_routes(app)
    app.add_exception_handler(HTTPException, _privacy_safe_http_exception_handler)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=configured_cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Idempotency-Key"],
    )
    app.add_middleware(SupabaseAuthMiddleware, public_paths=PUBLIC_PATHS)
    return app
