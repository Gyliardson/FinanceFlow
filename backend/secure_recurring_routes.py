import logging
from datetime import date

from fastapi import HTTPException

from api_models import RecurringBillCreateRequest
from database import get_supabase_client
from money import money_to_storage
from recurrence import recurring_due_date
from recurring_service import generate_recurring_instances_for_client

logger = logging.getLogger(__name__)


async def create_recurring_bill_user_scoped(req: RecurringBillCreateRequest):
    """Create a recurring template and best-effort generate children.

    Template creation and child generation are separate persistence steps. Once the
    template insert succeeds, a later generation failure must not be reported as if
    creation failed: doing so invites a client retry that can create a duplicate
    template. The explicit generation endpoint is idempotent at the child/database
    boundary and can safely recover the deferred generation work.
    """
    data_client = get_supabase_client()
    first_due = recurring_due_date(req.recurring_day, date.today())
    data = {
        "description": req.title,
        "amount": money_to_storage(req.amount),
        "due_date": str(first_due),
        "barcode": req.description,
        "status": "pending",
        "is_recurring": True,
        "frequency": req.frequency,
        "recurring_day": req.recurring_day,
    }

    try:
        response = data_client.table("finance_bills").insert(data).execute()
    except Exception as exc:
        logger.error("User-scoped recurring template creation failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail="Não foi possível criar a conta recorrente.",
        ) from exc

    try:
        generation = generate_recurring_instances_for_client(data_client)
    except Exception as exc:
        logger.error("Post-create recurring generation deferred: %s", type(exc).__name__)
        return {
            "status": "partial_success",
            "data": response.data,
            "generation": {
                "status": "deferred",
                "message": (
                    "A conta recorrente foi criada, mas a geração automática das instâncias "
                    "ficou pendente. Tente gerar as instâncias novamente."
                ),
            },
        }

    return {
        "status": "success",
        "data": response.data,
        "generation": generation,
    }


def generate_recurring_instances_user_scoped():
    """Explicit route variant that never depends on background ContextVar lifetime."""
    try:
        return generate_recurring_instances_for_client(get_supabase_client())
    except Exception as exc:
        logger.error("User-scoped recurring generation failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=500,
            detail="Não foi possível gerar as instâncias recorrentes.",
        ) from exc
