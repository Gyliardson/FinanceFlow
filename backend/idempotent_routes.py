"""Canonical HTTP boundaries for non-convergent financial mutations."""

import logging
from typing import Annotated

from fastapi import Header, HTTPException

from api_models import BillCreateRequest, IncomeCreateRequest, RecurringBillCreateRequest, ReserveAddRequest
from database import get_supabase_client
from financial_clock import financial_today
from idempotency import (
    IdempotencyPayloadConflictError,
    IdempotencyPersistenceError,
    InvalidIdempotencyKeyError,
    execute_idempotent_rpc,
)
from money import money_to_storage
from recurrence import recurring_due_date
from recurring_service import generate_recurring_instances_for_client
from request_context import get_request_user_id

logger = logging.getLogger(__name__)
IdempotencyHeader = Annotated[str, Header(alias="Idempotency-Key")]


def _require_authenticated_context() -> None:
    if not get_request_user_id():
        raise HTTPException(status_code=401, detail="Authenticated user context is required.")


def _translate_idempotency_error(exc: Exception) -> HTTPException:
    if isinstance(exc, InvalidIdempotencyKeyError):
        return HTTPException(status_code=400, detail=str(exc))
    if isinstance(exc, IdempotencyPayloadConflictError):
        return HTTPException(
            status_code=409,
            detail="Idempotency-Key was already used for a different financial operation payload.",
        )
    if isinstance(exc, IdempotencyPersistenceError):
        return HTTPException(
            status_code=503,
            detail=(
                "O resultado da operação financeira não pôde ser confirmado. "
                "Repita a mesma intenção com a mesma Idempotency-Key."
            ),
        )
    return HTTPException(status_code=500, detail="Internal server error.")


def _execute_or_http(**kwargs):
    try:
        return execute_idempotent_rpc(**kwargs)
    except (InvalidIdempotencyKeyError, IdempotencyPayloadConflictError, IdempotencyPersistenceError) as exc:
        raise _translate_idempotency_error(exc) from exc


async def add_bill_idempotent(req: BillCreateRequest, idempotency_key: IdempotencyHeader):
    _require_authenticated_context()
    payload = {
        "description": req.description,
        "amount": req.amount,
        "due_date": req.due_date,
        "barcode": req.barcode,
        "status": req.status,
    }
    return _execute_or_http(
        data_client=get_supabase_client(),
        rpc_name="finance_idempotent_add_bill",
        operation_type="bill_create",
        idempotency_key=idempotency_key,
        fingerprint_payload=payload,
        rpc_parameters={
            "p_description": req.description,
            "p_amount": money_to_storage(req.amount),
            "p_due_date": req.due_date,
            "p_barcode": req.barcode,
        },
    )


async def add_income_idempotent(req: IncomeCreateRequest, idempotency_key: IdempotencyHeader):
    _require_authenticated_context()
    payload = req.model_dump()
    return _execute_or_http(
        data_client=get_supabase_client(),
        rpc_name="finance_idempotent_add_income",
        operation_type="income_create",
        idempotency_key=idempotency_key,
        fingerprint_payload=payload,
        rpc_parameters={
            "p_title": req.title,
            "p_amount": money_to_storage(req.amount),
            "p_date": req.date,
            "p_description": req.description,
            "p_type": req.type,
            "p_is_recurring": req.is_recurring,
        },
    )


async def add_to_reserve_idempotent(req: ReserveAddRequest, idempotency_key: IdempotencyHeader):
    _require_authenticated_context()
    return _execute_or_http(
        data_client=get_supabase_client(),
        rpc_name="finance_idempotent_add_reserve",
        operation_type="reserve_add",
        idempotency_key=idempotency_key,
        fingerprint_payload={"amount": req.amount},
        rpc_parameters={"p_amount": money_to_storage(req.amount)},
    )


async def create_recurring_bill_idempotent(
    req: RecurringBillCreateRequest,
    idempotency_key: IdempotencyHeader,
):
    """Create exactly one logical template; child generation remains recoverable.

    The fingerprint deliberately excludes the derived first due date. A retry of the
    same unresolved intent across midnight/month rollover must still resolve to the
    template committed by the original intent rather than becoming a payload mismatch.
    """
    _require_authenticated_context()
    data_client = get_supabase_client()
    payload = req.model_dump()
    first_due = recurring_due_date(req.recurring_day, financial_today())

    result = _execute_or_http(
        data_client=data_client,
        rpc_name="finance_idempotent_create_recurring_template",
        operation_type="recurring_template_create",
        idempotency_key=idempotency_key,
        fingerprint_payload=payload,
        rpc_parameters={
            "p_title": req.title,
            "p_amount": money_to_storage(req.amount),
            "p_due_date": str(first_due),
            "p_description": req.description,
            "p_frequency": req.frequency,
            "p_recurring_day": req.recurring_day,
        },
    )

    try:
        generation = generate_recurring_instances_for_client(data_client)
    except Exception as exc:
        logger.error("Post-create recurring generation deferred: %s", type(exc).__name__)
        return {
            **result,
            "status": "partial_success",
            "generation": {
                "status": "deferred",
                "message": (
                    "A conta recorrente foi criada exatamente uma vez, mas a geração "
                    "automática das instâncias ficou pendente."
                ),
            },
        }

    return {**result, "generation": generation}
