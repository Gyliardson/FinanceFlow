from dataclasses import dataclass
from datetime import date
from typing import Any

from database import build_receipt_object_key
from receipt_uploads import ValidatedReceipt, validate_receipt_upload


class ReceiptPaymentError(RuntimeError):
    """Base error for receipt-backed payment persistence."""


class BillNotFoundError(ReceiptPaymentError):
    """Raised when the authenticated data client cannot see the requested bill."""


class BillAlreadyPaidError(ReceiptPaymentError):
    """Raised when a payment is submitted for an already-paid bill."""


class ReceiptStorageError(ReceiptPaymentError):
    """Raised when private receipt storage cannot persist the validated document."""


class PaymentPersistenceError(ReceiptPaymentError):
    """Raised when bill state cannot be updated after a receipt upload."""


@dataclass(frozen=True)
class ReceiptPaymentResult:
    bill_id: str
    receipt_path: str
    payment_date: str


def _first_row(response: Any) -> dict[str, Any] | None:
    rows = getattr(response, "data", None) or []
    return rows[0] if rows else None


def _storage_bucket(storage_client: Any):
    return storage_client.storage.from_("receipts")


def _delete_uploaded_receipt(bucket: Any, receipt_path: str) -> None:
    try:
        bucket.remove([receipt_path])
    except Exception:
        # Cleanup failure must not replace the authoritative persistence failure.
        pass


def persist_private_receipt_payment(
    *,
    data_client: Any,
    storage_client: Any,
    owner_id: str,
    bill_id: str,
    content: bytes,
    declared_mime_type: str | None,
    payment_date: date | None = None,
) -> ReceiptPaymentResult:
    """Persist a receipt-backed payment using an authenticated, RLS-scoped data client.

    Security invariants:
    - bill lookup/update happens only through the caller-supplied authenticated client;
    - uploaded bytes are validated independently of the user-controlled filename;
    - storage object identity is owner/bill scoped and opaque;
    - only the durable private ``receipt_path`` is persisted;
    - no public URL is generated or persisted;
    - if the database update fails after upload, best-effort cleanup removes the orphan.
    """
    bill_response = (
        data_client.table("finance_bills")
        .select("id,status")
        .eq("id", bill_id)
        .limit(1)
        .execute()
    )
    bill = _first_row(bill_response)
    if bill is None:
        raise BillNotFoundError("Bill was not found in the authenticated user scope.")
    if bill.get("status") == "paid":
        raise BillAlreadyPaidError("Bill is already paid.")

    validated: ValidatedReceipt = validate_receipt_upload(content, declared_mime_type)
    receipt_path = build_receipt_object_key(owner_id, bill_id, validated.extension)
    bucket = _storage_bucket(storage_client)

    try:
        bucket.upload(
            path=receipt_path,
            file=validated.content,
            file_options={"content-type": validated.mime_type},
        )
    except Exception as exc:
        raise ReceiptStorageError("Could not persist the private receipt.") from exc

    effective_payment_date = payment_date or date.today()
    try:
        update_response = (
            data_client.table("finance_bills")
            .update(
                {
                    "status": "paid",
                    "payment_date": effective_payment_date.isoformat(),
                    "receipt_path": receipt_path,
                }
            )
            .eq("id", bill_id)
            .execute()
        )
        if not getattr(update_response, "data", None):
            raise PaymentPersistenceError(
                "Authenticated bill update affected no rows; payment was not persisted."
            )
    except Exception as exc:
        _delete_uploaded_receipt(bucket, receipt_path)
        if isinstance(exc, PaymentPersistenceError):
            raise
        raise PaymentPersistenceError("Could not persist the payment state.") from exc

    return ReceiptPaymentResult(
        bill_id=bill_id,
        receipt_path=receipt_path,
        payment_date=effective_payment_date.isoformat(),
    )
