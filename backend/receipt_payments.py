from dataclasses import dataclass
from datetime import date
from typing import Any

from database import build_receipt_object_key, validate_receipt_object_key
from receipt_uploads import ValidatedReceipt, validate_receipt_upload


class ReceiptPaymentError(RuntimeError):
    """Base error for receipt-backed payment persistence."""


class BillNotFoundError(ReceiptPaymentError):
    """Raised when the authenticated data client cannot see the requested bill."""


class BillAlreadyPaidError(ReceiptPaymentError):
    """Raised when another completed payment owns the authoritative bill state."""


class RecurringTemplatePaymentError(ReceiptPaymentError):
    """Raised when scheduling metadata is submitted as a payable bill."""


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


def _rpc_payload(response: Any) -> dict[str, Any] | None:
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    return None


def _storage_bucket(storage_client: Any):
    return storage_client.storage.from_("receipts")


def _delete_uploaded_receipt(bucket: Any, receipt_path: str) -> None:
    try:
        bucket.remove([receipt_path])
    except Exception:
        pass


def _cleanup_stale_receipts_after_commit(
    *,
    bucket: Any,
    owner_id: str,
    bill_id: str,
    committed_receipt_path: str,
) -> None:
    """Best-effort cleanup after authoritative paid state exists."""
    try:
        validated_path = validate_receipt_object_key(
            owner_id,
            bill_id,
            committed_receipt_path,
        )
        namespace = validated_path.rsplit("/", 1)[0]
        objects = bucket.list(path=namespace) or []
        stale_paths: list[str] = []
        for item in objects:
            name = item.get("name") if isinstance(item, dict) else getattr(item, "name", None)
            if not isinstance(name, str) or not name or "/" in name or "\\" in name:
                continue
            candidate = f"{namespace}/{name}"
            if candidate != validated_path:
                stale_paths.append(candidate)
        if stale_paths:
            bucket.remove(stale_paths)
    except Exception:
        pass


def _select_bill_state(data_client: Any, bill_id: str) -> dict[str, Any] | None:
    """Read the current RLS-scoped payment state used for reconciliation."""
    response = (
        data_client.table("finance_bills")
        .select("id,status,payment_date,receipt_path,is_recurring")
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
    owner_id: str,
    bill_id: str,
    uploaded_receipt_path: str,
    original_error: Exception,
) -> ReceiptPaymentResult:
    """Resolve a write whose transport result is not authoritative."""
    try:
        bill = _select_bill_state(data_client, bill_id)
    except Exception as reconcile_error:
        raise PaymentPersistenceError(
            "Payment outcome is ambiguous; the private receipt was retained for reconciliation."
        ) from reconcile_error

    if bill is None:
        raise PaymentPersistenceError(
            "Payment outcome could not be reconciled; the private receipt was retained."
        ) from original_error

    committed = _committed_receipt_payment(bill)
    if committed is not None:
        if committed.receipt_path != uploaded_receipt_path:
            _delete_uploaded_receipt(bucket, uploaded_receipt_path)
        _cleanup_stale_receipts_after_commit(
            bucket=bucket,
            owner_id=owner_id,
            bill_id=bill_id,
            committed_receipt_path=committed.receipt_path,
        )
        if committed.receipt_path == uploaded_receipt_path:
            return committed
        raise BillAlreadyPaidError("Bill was completed by another payment attempt.")

    current_receipt_path = bill.get("receipt_path")
    if current_receipt_path == uploaded_receipt_path:
        raise PaymentPersistenceError(
            "Payment state is incomplete; the referenced private receipt was retained."
        ) from original_error

    if bill.get("status") == "paid":
        _delete_uploaded_receipt(bucket, uploaded_receipt_path)
        raise BillAlreadyPaidError("Bill was completed by another payment attempt.")

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
    """Persist a receipt-backed payment through the sanctioned PostgreSQL transition.

    Security/correctness invariants:
    - bill lookup/reconciliation uses the authenticated RLS client;
    - recurring templates can never enter payment state;
    - uploaded bytes are structurally validated before private storage;
    - object identity is owner/bill scoped and opaque;
    - final financial mutation is an owner-derived SECURITY DEFINER RPC;
    - payment_date is derived inside PostgreSQL from private runtime configuration;
    - a transport exception remains an ambiguous outcome and is reconciled;
    - uploaded evidence is deleted only after authoritative state proves it unreferenced.

    ``payment_date`` is retained only as a backwards-compatible test-call argument;
    it is intentionally not sent to PostgreSQL and cannot override financial date.
    """
    _ = payment_date
    bill = _select_bill_state(data_client, bill_id)
    if bill is None:
        raise BillNotFoundError("Bill was not found in the authenticated user scope.")
    if bill.get("is_recurring") is True:
        raise RecurringTemplatePaymentError("Recurring templates are not payable bills.")

    existing_payment = _committed_receipt_payment(bill)
    bucket = _storage_bucket(storage_client)
    if existing_payment is not None:
        _cleanup_stale_receipts_after_commit(
            bucket=bucket,
            owner_id=owner_id,
            bill_id=bill_id,
            committed_receipt_path=existing_payment.receipt_path,
        )
        return existing_payment
    if bill.get("status") == "paid":
        raise BillAlreadyPaidError("Bill is already paid.")

    validated: ValidatedReceipt = validate_receipt_upload(content, declared_mime_type)
    receipt_path = build_receipt_object_key(owner_id, bill_id, validated.extension)

    try:
        bucket.upload(
            path=receipt_path,
            file=validated.content,
            file_options={"content-type": validated.mime_type},
        )
    except Exception as exc:
        # The payment RPC has not started, so this exact generated object path
        # cannot be referenced by durable financial state. A Storage exception
        # may still mean commit-then-response-loss; deleting the known path is
        # therefore safe and prevents an otherwise unreachable private orphan.
        _delete_uploaded_receipt(bucket, receipt_path)
        raise ReceiptStorageError("Could not persist the private receipt.") from exc

    try:
        rpc_response = data_client.rpc(
            "finance_mark_bill_paid",
            {"p_bill_id": bill_id, "p_receipt_path": receipt_path},
        ).execute()
    except Exception as exc:
        return _reconcile_ambiguous_payment(
            data_client=data_client,
            bucket=bucket,
            owner_id=owner_id,
            bill_id=bill_id,
            uploaded_receipt_path=receipt_path,
            original_error=exc,
        )

    payload = _rpc_payload(rpc_response)
    authoritative = payload.get("data") if payload else None
    committed = _committed_receipt_payment(authoritative if isinstance(authoritative, dict) else None)
    if committed is None:
        return _reconcile_ambiguous_payment(
            data_client=data_client,
            bucket=bucket,
            owner_id=owner_id,
            bill_id=bill_id,
            uploaded_receipt_path=receipt_path,
            original_error=PaymentPersistenceError(
                "Payment RPC did not return a complete authoritative paid state."
            ),
        )

    if committed.receipt_path != receipt_path:
        return _reconcile_ambiguous_payment(
            data_client=data_client,
            bucket=bucket,
            owner_id=owner_id,
            bill_id=bill_id,
            uploaded_receipt_path=receipt_path,
            original_error=BillAlreadyPaidError("Another payment attempt owns the durable receipt."),
        )

    _cleanup_stale_receipts_after_commit(
        bucket=bucket,
        owner_id=owner_id,
        bill_id=bill_id,
        committed_receipt_path=committed.receipt_path,
    )
    return committed
