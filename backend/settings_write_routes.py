"""Least-privilege authenticated settings replacement boundary."""

import logging

from fastapi import HTTPException

from api_models import SettingsUpdateRequest
from database import get_supabase_client
from money import money_to_storage
from request_context import get_request_user_id

logger = logging.getLogger(__name__)


def _require_authenticated_context() -> None:
    if not get_request_user_id():
        raise HTTPException(status_code=401, detail="Authenticated user context is required.")


def _rpc_payload(response):
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    return None


async def update_settings(req: SettingsUpdateRequest):
    """Replace only the three public settings fields through PostgreSQL policy."""
    _require_authenticated_context()
    try:
        response = get_supabase_client().rpc(
            "finance_replace_settings",
            {
                "p_initial_balance": money_to_storage(req.initial_balance),
                "p_initial_balance_date": req.initial_balance_date,
                "p_emergency_fund_goal": money_to_storage(req.emergency_fund_goal),
            },
        ).execute()
    except Exception as exc:
        logger.error("Settings RPC persistence failed")
        raise HTTPException(
            status_code=503,
            detail="Não foi possível confirmar a atualização das configurações.",
        ) from exc

    payload = _rpc_payload(response)
    if not payload or payload.get("status") != "success" or not isinstance(payload.get("data"), dict):
        raise HTTPException(
            status_code=503,
            detail="Não foi possível confirmar a atualização das configurações.",
        )
    return payload
