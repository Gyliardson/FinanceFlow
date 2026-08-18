import logging

from fastapi import HTTPException

from database import get_supabase_client
from recurring_service import generate_recurring_instances_for_client

logger = logging.getLogger(__name__)


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
