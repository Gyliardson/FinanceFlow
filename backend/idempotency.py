"""Server-side contract for durable financial mutation idempotency.

The client supplies only an opaque operation identity. Owner identity and the
canonical payload fingerprint are both derived again inside PostgreSQL, which is
the transaction authority for replay and conflict detection.
"""

from __future__ import annotations

import re
from typing import Any, Mapping


IDEMPOTENCY_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")


class IdempotencyError(RuntimeError):
    """Base error for the financial idempotency protocol."""


class InvalidIdempotencyKeyError(IdempotencyError):
    """Raised when the public operation identity is malformed."""


class IdempotencyPayloadConflictError(IdempotencyError):
    """Raised when a durable key is replayed with a different logical payload."""


class IdempotencyPersistenceError(IdempotencyError):
    """Raised when an RPC result is unavailable or ambiguous to the HTTP layer."""


def validate_idempotency_key(value: str | None) -> str:
    if not isinstance(value, str):
        raise InvalidIdempotencyKeyError("Idempotency-Key header is required.")
    key = value.strip()
    if not IDEMPOTENCY_KEY_RE.fullmatch(key):
        raise InvalidIdempotencyKeyError(
            "Idempotency-Key must be 8-128 characters using letters, digits, '.', '_', ':', or '-'."
        )
    return key


def execute_idempotent_rpc(
    *,
    data_client: Any,
    rpc_name: str,
    idempotency_key: str | None,
    rpc_parameters: Mapping[str, Any],
) -> dict[str, Any]:
    """Execute one transaction-backed mutation RPC.

    A transport exception is intentionally *not* retried with a new key here. The
    HTTP layer reports an indeterminate outcome; the caller must retry the same
    logical intent using the same key. PostgreSQL then computes the canonical
    fingerprint itself and either returns the already-committed result or applies
    a rolled-back attempt once.
    """
    key = validate_idempotency_key(idempotency_key)
    params = {
        "p_idempotency_key": key,
        **dict(rpc_parameters),
    }

    try:
        response = data_client.rpc(rpc_name, params).execute()
    except Exception as exc:
        message = str(exc)
        if "idempotency_key_payload_mismatch" in message:
            raise IdempotencyPayloadConflictError(
                "Idempotency-Key was already used for a different payload."
            ) from exc
        raise IdempotencyPersistenceError(
            "Financial mutation outcome is indeterminate; retry the same logical operation with the same Idempotency-Key."
        ) from exc

    result = getattr(response, "data", None)
    if isinstance(result, list) and len(result) == 1 and isinstance(result[0], dict):
        result = result[0]
    if not isinstance(result, dict):
        raise IdempotencyPersistenceError("Financial mutation RPC returned an invalid durable result.")
    return result
