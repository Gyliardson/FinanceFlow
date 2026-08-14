from dataclasses import dataclass
from datetime import date
from typing import Any

from database import build_receipt_object_key
from financial_clock import financial_today
from receipt_uploads import ValidatedReceipt, validate_receipt_upload


class ReceiptPaymentError(RuntimeError):
    """Base error for receipt-backed payment persistence."""


class BillNotFoundError(ReceiptPaymentError):
    """Raised when the authenticated data client cannot see the requested bill."""


class BillAlreadyPaidError(ReceiptPaymentError):
    """Raised when another completed payment owns the authoritative bill state."""


class ReceiptStorageError(ReceiptPaymentError):
    """Raised when private receipt storage cannot persist the validated document."""


class PaymentPersistenceError(ReceiptPaymentError):
    """Raised when bill state cannot be safely resolved after a payment attempt."""


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


def _select_bill_state(data_client: Any, bill_id: str) -> dict[str, Any] | None:
    """Read the current RLS-scoped payment state used for reconciliation."""
    response = (
        data_client.table("finance_bills")
        .select("id,status,payment_date,receipt_path")
        .eq("id", bill_id)
        .limit(1)
        .execute()
    )
    return _first_row(response)


def _committed_receipt_payment(bill: dict[str, Any] | None) -> ReceiptPaymentResult | None:
    """Return a complete committed receipt payment, otherwise ``None``."""
    if not bill or bill.get("status") != "paid":
        return None

    receipt_path = bill.get("receipt_path")
    payment_date = bill.get("payment_date")
    if not receipt_path or not payment_date:
        return None

    return ReceiptPaymentResult(
        bill_id=str(bill["id"]),
        receipt_path=str(receipt_path),
        payment_date=str(payment_date),
    )


def _reconcile_ambiguous_payment(
    *,
    data_client: Any,
    bucket: Any,
    bill_id: str,
    uploaded_receipt_path: str,
    original_error: Exception,
) -> ReceiptPaymentResult:
    """Resolve a write whose transport result is not authoritative.

    A Data API exception is not proof that PostgreSQL rolled back. Re-read the
    owner-scoped bill and only remove the uploaded object when the visible,
    authoritative row proves that this attempt's path is not referenced.

    If reconciliation itself is unavailable, preserve the receipt. A bounded
    orphan is safer than deleting evidence that may already be referenced by a
    committed financial record.
    """
    try:
        bill = _select_bill_state(data_client, bill_id)
    except Exception as reconcile_error:
        raise PaymentPersistenceError(
            "Payment outcome is ambiguous; the private receipt was retained for reconciliation."
        ) from reconcile_error

    if bill is None:
        # A missing/hidden row does not prove that no durable reference exists.
        # Preserve the object and fail closed instead of destroying evidence.
        raise PaymentPersistenceError(
            "Payment outcome could not be reconciled; the private receipt was retained."
        ) from original_error

    committed = _committed_receipt_payment(bill)
    if committed is not None:
        if committed.receipt_path == uploaded_receipt_path:
            # The mutation committed and only its response was lost.
            return committed

        # Another payment won. The current authoritative row references a
        # different receipt, so this attempt's owner/bill-scoped upload is an
        # orphan and can be cleaned without detaching the committed evidence.
        _delete_uploaded_receipt(bucket, uploaded_receipt_path)
        raise BillAlreadyPaidError("Bill was completed by another payment attempt.")

    current_receipt_path = bill.get("receipt_path")
    if current_receipt_path == uploaded_receipt_path:
        # An unexpected partial state still references our object. Never delete
        # a referenced receipt merely because the payment status is incomplete.
        raise PaymentPersistenceError(
            "Payment state is incomplete; the referenced private receipt was retained."
        ) from original_error

    if bill.get("status") == "paid":
        # A receipt-less or otherwise different payment won the CAS. Our upload
        # is provably not the bill's durable receipt reference.
        _delete_uploaded_receipt(bucket, uploaded_receipt_path)
        raise BillAlreadyPaidError("Bill was completed by another payment attempt.")

    # The same authenticated row is still unpaid and does not reference this
    # object, which is the proof required before bounded orphan cleanup.
    _delete_uploaded_receipt(bucket, uploaded_receipt_path)
    if isinstance(original_error, PaymentPersistenceError):
        raise original_error
    raise PaymentPersistenceError("Could not persist the payment state.") from original_error


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

    Security/correctness invariants:
    - bill lookup/update happens only through the caller-supplied authenticated client;
    - uploaded bytes are validated independently of the user-controlled filename;
    - storage object identity is owner/bill scoped and opaque;
    - only the durable private ``receipt_path`` is persisted;
    - no public URL is generated or persisted;
    - the final write is compare-and-set on ``status != paid`` to reject double-submit races;
    - a database/API exception is treated as an ambiguous outcome, not proof of rollback;
    - uploaded evidence is deleted only after an authoritative re-read proves it is unreferenced.
    """
    bill = _select_bill_state(data_client, bill_id)
    if bill is None:
        raise BillNotFoundError("Bill was not found in the authenticated user scope.")

    existing_payment = _committed_receipt_payment(bill)
    if existing_payment is not None:
        # Transport retry after a previously committed receipt payment converges
        # to the already-authoritative result without another upload or mutation.
        return existing_payment
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

    effective_payment_date = payment_date or financial_today()
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
            .neq("status", "paid")
            .execute()
        )
    except Exception as exc:
        return _reconcile_ambiguous_payment(
            data_client=data_client,
            bucket=bucket,
            bill_id=bill_id,
            uploaded_receipt_path=receipt_path,
            original_error=exc,
        )

    if not getattr(update_response, "data", None):
        return _reconcile_ambiguous_payment(
            data_client=data_client,
            bucket=bucket,
            bill_id=bill_id,
            uploaded_receipt_path=receipt_path,
            original_error=PaymentPersistenceError(
                "Authenticated bill update affected no rows; payment may have been concurrently completed."
            ),
        )

    return ReceiptPaymentResult(
        bill_id=bill_id,
        receipt_path=receipt_path,
        payment_date=effective_payment_date.isoformat(),
    )
