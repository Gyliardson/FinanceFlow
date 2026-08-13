import logging
import os

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")


def get_supabase_client() -> Client:
    """Return the Data API client used by the current backend.

    Ownership-aware request scoping is introduced by the security migration and
    endpoint layer. A public/publishable key is never treated as a secret.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be configured.")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def get_supabase_storage_client() -> Client:
    """Return a server-only Storage client.

    Receipt operations require the service-role credential. There is deliberately
    no fallback to the publishable key because startup/storage behavior must fail
    closed rather than silently weakening access controls.
    """
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

        # Existing buckets are explicitly normalized back to private. Never log
        # storage URLs or provider response bodies for financial documents.
        storage_client.storage.update_bucket("receipts", options={"public": False})
        logger.info("Existing receipt storage bucket was verified as private.")
