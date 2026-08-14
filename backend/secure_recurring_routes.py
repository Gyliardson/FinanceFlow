import logging
from datetime import date

from fastapi import HTTPException

from database import get_supabase_client
from main import RecurringBillCreateRequest
from money import money_to_storage
from recurrence import recurring_due_date
from recurring_service import generate_recurring_instances_for_client

logger = logging.getLogger(__name__)


async def create_recurring_bill_user_scoped(req: RecurringBillCreateRequest):
    """Create template and generate children synchronously with one authenticated client."""
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
        generation = generate_recurring_instances_for_client(data_client)
    except Exception as exc:
        logger.error("User-scoped recurring bill operation failed: %s", type(exc).__name__)
        raise HTTPException(
            status_code=500,
            detail="Não foi possível criar ou gerar a conta recorrente.",
        ) from exc

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
