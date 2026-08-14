"""Server-side contract for durable financial mutation idempotency.

The client supplies only an opaque operation identity. Owner identity comes from the
validated request context and the PostgreSQL RPC derives it again from ``auth.uid()``.
Canonical payload fingerprints are computed by the backend and are never trusted from
the caller.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import date, datetime
from decimal import Decimal
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


def _canonical_value(value: Any) -> Any:
    if isinstance(value, Decimal):
        # Pydantic/money validation already applies the authoritative two-decimal
        # financial scale. String serialization avoids binary-float drift.
        return format(value, "f")
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _canonical_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    if value is None or isinstance(value, (str, int, bool)):
        return value
    if isinstance(value, float):
        # Financial request models should not reach here with floats, but keeping
        # JSON normalization deterministic makes the helper safe for non-money
        # scalar metadata as well.
        return repr(value)
    raise TypeError(f"Unsupported idempotency payload value: {type(value).__name__}")


def canonical_payload_fingerprint(operation_type: str, payload: Mapping[str, Any]) -> str:
    canonical = {
        "operation": operation_type,
        "payload": _canonical_value(payload),
    }
    serialized = json.dumps(
        canonical,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(serialized).hexdigest()


def execute_idempotent_rpc(
    *,
    data_client: Any,
    rpc_name: str,
    operation_type: str,
    idempotency_key: str | None,
    fingerprint_payload: Mapping[str, Any],
    rpc_parameters: Mapping[str, Any],
) -> dict[str, Any]:
    """Execute one transaction-backed mutation RPC.

    A transport exception is intentionally *not* retried with a new key here. The
    HTTP layer reports an indeterminate outcome; the caller must retry the same
    logical intent using the same key. PostgreSQL then returns the durable result
    if the first transaction committed, or applies it once if the first rolled back.
    """
    key = validate_idempotency_key(idempotency_key)
    fingerprint = canonical_payload_fingerprint(operation_type, fingerprint_payload)
    params = {
        "p_idempotency_key": key,
        "p_request_fingerprint": fingerprint,
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
