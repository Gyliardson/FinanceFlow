import logging
import os

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


def _require_public_config() -> tuple[str, str]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be configured.")
    return SUPABASE_URL, SUPABASE_KEY


def get_supabase_client() -> Client:
    """Return the publishable-key Data/Auth client.

    The publishable key is not a secret. Data access is safe only when an
    authenticated user context and restrictive RLS/owner predicates are applied.
    """
    url, key = _require_public_config()
    return create_client(url, key)


def get_supabase_auth_client() -> Client:
    """Return a client used only to validate end-user Supabase Auth sessions."""
    url, key = _require_public_config()
    return create_client(url, key)


def get_supabase_storage_client() -> Client:
    """Return a server-only client for private receipt storage operations."""
    if not SUPABASE_URL:
        raise ValueError("SUPABASE_URL must be configured.")
    if not SUPABASE_SERVICE_ROLE_KEY:
        raise ValueError("SUPABASE_SERVICE_ROLE_KEY is required for private receipt storage.")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def ensure_receipts_bucket() -> None:
    """Ensure the financial-document bucket exists and remains private."""
    storage_client = get_supabase_storage_client()
    try:
        storage_client.storage.create_bucket("receipts", options={"public": False})
        logger.info("Receipt storage bucket is configured as private.")
    except Exception as exc:
        error_text = str(exc).lower()
        if "already exists" not in error_text and "duplicate" not in error_text and "409" not in error_text:
            logger.error("Failed to create private receipt storage bucket: %s", type(exc).__name__)
            raise

        storage_client.storage.update_bucket("receipts", options={"public": False})
        logger.info("Existing receipt storage bucket was verified as private.")
