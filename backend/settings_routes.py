"""Narrow authenticated mutations for independent financial settings fields."""

import logging

from fastapi import HTTPException

from api_models import EmergencyFundGoalUpdateRequest
from database import get_supabase_client
from money import money_to_storage
from request_context import get_request_user_id

logger = logging.getLogger(__name__)


def _require_authenticated_context() -> None:
    if not get_request_user_id():
        raise HTTPException(status_code=401, detail="Authenticated user context is required.")


async def update_emergency_fund_goal(req: EmergencyFundGoalUpdateRequest):
    """Replace only the authenticated owner's emergency-fund goal.

    The goal editor must not perform a client-side read/modify/write of the entire
    settings row. RLS scopes the query to the authenticated owner; this mutation
    intentionally leaves initial balance/date and reserve balance untouched.
    """
    _require_authenticated_context()
    data_client = get_supabase_client()
    goal = money_to_storage(req.emergency_fund_goal)

    try:
        settings_response = (
            data_client.table("finance_user_settings")
            .select("id")
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.error("Emergency-fund goal lookup failed")
        raise HTTPException(status_code=503, detail="Não foi possível consultar as configurações.") from exc

    rows = getattr(settings_response, "data", None) or []
    if not rows:
        raise HTTPException(
            status_code=400,
            detail="Configurações (Saldo Inicial) não encontradas.",
        )

    settings_id = rows[0]["id"]
    try:
        update_response = (
            data_client.table("finance_user_settings")
            .update({"emergency_fund_goal": goal})
            .eq("id", settings_id)
            .execute()
        )
    except Exception as exc:
        logger.error("Emergency-fund goal persistence failed")
        raise HTTPException(
            status_code=503,
            detail="Não foi possível confirmar a atualização da meta.",
        ) from exc

    updated_rows = getattr(update_response, "data", None) or []
    if not updated_rows:
        # RLS visibility can change between lookup and update. Do not claim that
        # a write rolled back merely because the response contains no row.
        raise HTTPException(
            status_code=503,
            detail="Não foi possível confirmar a atualização da meta.",
        )

    return {"status": "success", "data": updated_rows[0]}
