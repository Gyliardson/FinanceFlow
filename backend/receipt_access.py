from dataclasses import dataclass
from typing import Any

from database import (
    DEFAULT_RECEIPT_SIGNED_URL_TTL_SECONDS,
    create_receipt_signed_url,
)


class ReceiptAccessError(RuntimeError):
    """Base error for authorized private-receipt access."""


class ReceiptNotFoundError(ReceiptAccessError):
    """Raised when the authenticated client cannot see a receipt-backed bill."""


@dataclass(frozen=True)
class ReceiptAccessResult:
    bill_id: str
    receipt_path: str
    signed_url: str
    expires_in: int


def _extract_signed_url(response: Any) -> str:
    if isinstance(response, str) and response:
        return response
    if isinstance(response, dict):
        for key in ("signedURL", "signedUrl", "signed_url"):
            value = response.get(key)
            if isinstance(value, str) and value:
                return value
    raise ReceiptAccessError("Storage provider did not return a signed receipt URL.")


def create_authorized_receipt_access(
    *,
    data_client: Any,
    owner_id: str,
    bill_id: str,
    expires_in: int = DEFAULT_RECEIPT_SIGNED_URL_TTL_SECONDS,
) -> ReceiptAccessResult:
    """Authorize through the user-scoped Data API before using service-role storage.

    A guessed bill identifier from another account is indistinguishable from a
    missing bill because RLS filters it out before the privileged storage helper
    is invoked.
    """
    response = (
        data_client.table("finance_bills")
        .select("id,receipt_path")
        .eq("id", bill_id)
        .limit(1)
        .execute()
    )
    rows = getattr(response, "data", None) or []
    if not rows:
        raise ReceiptNotFoundError("Receipt was not found in the authenticated user scope.")

    receipt_path = rows[0].get("receipt_path")
    if not receipt_path:
        raise ReceiptNotFoundError("The bill does not have a private receipt.")

    signed_response = create_receipt_signed_url(
        owner_id=owner_id,
        bill_id=bill_id,
        receipt_path=receipt_path,
        expires_in=expires_in,
    )
    return ReceiptAccessResult(
        bill_id=bill_id,
        receipt_path=receipt_path,
        signed_url=_extract_signed_url(signed_response),
        expires_in=expires_in,
    )
