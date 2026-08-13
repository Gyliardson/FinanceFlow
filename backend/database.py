import logging
import os
import re
import uuid

from dotenv import load_dotenv
from supabase import Client, create_client

from request_context import get_request_client

load_dotenv()
logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
_RECEIPT_EXTENSION = re.compile(r"^[a-z0-9]{1,8}$")


def _require_public_config() -> tuple[str, str]:
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be configured.")
    return SUPABASE_URL, SUPABASE_KEY


def get_supabase_client() -> Client:
    """Return the authenticated request client when available.

    Outside a protected request this falls back to a publishable-key client,
    which remains constrained by RLS and has no service-role privileges.
    """
    request_client = get_request_client()
    if request_client is not None:
        return request_client
    url, key = _require_public_config()
    return create_client(url, key)


def get_supabase_auth_client() -> Client:
    """Return a client used only to validate end-user Supabase Auth sessions."""
    url, key = _require_public_config()
    return create_client(url, key)


def get_user_supabase_client(access_token: str) -> Client:
    """Return a Data API client whose PostgREST requests carry a verified user JWT.

    Callers must validate the JWT with Supabase Auth before constructing this
    client. Supplying the bearer token to PostgREST allows PostgreSQL RLS to
    evaluate auth.uid() for the authenticated end user.
    """
    if not access_token:
        raise ValueError("A non-empty user access token is required.")
    url, key = _require_public_config()
    client = create_client(url, key)
    client.postgrest.auth(access_token)
    return client


def build_receipt_object_key(owner_id: str, bill_id: str, extension: str) -> str:
    """Build an opaque receipt key from validated identifiers, never a user filename."""
    safe_owner = str(uuid.UUID(str(owner_id)))
    safe_bill = str(uuid.UUID(str(bill_id)))
    safe_extension = extension.lower().lstrip(".")
    if not _RECEIPT_EXTENSION.fullmatch(safe_extension):
        raise ValueError("Unsupported receipt file extension.")
    return f"{safe_owner}/{safe_bill}/{uuid.uuid4().hex}.{safe_extension}"


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
