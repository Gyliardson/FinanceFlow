"""Privacy-minimized Insights routes for the canonical FinanceFlow runtime.

Passive reads calculate owner-scoped financial aggregates locally and return only
an already-persisted insight. External AI generation is reserved for the explicit
refresh mutation.
"""

import asyncio

from fastapi import HTTPException

from ai_service import generate_financial_insights
from api_handlers import _calculate_financials
from database import get_supabase_client
from financial_clock import financial_today


def _load_settings(supabase):
    response = supabase.table("finance_user_settings").select("*").limit(1).execute()
    if not response.data:
        raise HTTPException(
            status_code=400,
            detail="Configurações (Saldo Inicial) não encontradas. Configure o saldo inicial primeiro.",
        )
    return response.data[0]


def _rpc_payload(response):
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    return None


async def get_insights():
    """Return local aggregates plus the latest stored insight without calling AI."""
    try:
        supabase = get_supabase_client()
        settings = _load_settings(supabase)
        fin_data = _calculate_financials(supabase, settings)
        return {
            "status": "success",
            "data": {**fin_data, "insight": settings.get("latest_insight_text")},
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Unable to load insights.") from exc


async def refresh_insights():
    """Generate a new insight only after the user's explicit refresh request."""
    try:
        supabase = get_supabase_client()
        settings = _load_settings(supabase)
        fin_data = _calculate_financials(supabase, settings)

        try:
            # Gemini generation is synchronous at this adapter boundary. Keep the
            # bounded provider request off the event-loop thread so explicit AI
            # refresh cannot stall unrelated async API work in this Uvicorn process.
            insight_result = await asyncio.to_thread(
                generate_financial_insights,
                fin_data,
                explicit_user_action=True,
            )
        except Exception as exc:
            raise HTTPException(status_code=502, detail="AI provider unavailable.") from exc

        if insight_result.get("status") == "error":
            raise HTTPException(status_code=502, detail="AI provider unavailable.")

        new_text = insight_result.get("insight")
        if not isinstance(new_text, str) or not new_text.strip():
            raise HTTPException(status_code=502, detail="AI provider returned an invalid insight.")

        today = financial_today()
        try:
            persistence = supabase.rpc(
                "finance_store_insight",
                {"p_insight_text": new_text, "p_insight_date": today.isoformat()},
            ).execute()
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Unable to confirm insight persistence.") from exc

        payload = _rpc_payload(persistence)
        if not payload or payload.get("status") != "success":
            raise HTTPException(status_code=503, detail="Unable to confirm insight persistence.")
        return {"status": "success", "data": {**fin_data, "insight": new_text}}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail="Unable to refresh insights.") from exc
