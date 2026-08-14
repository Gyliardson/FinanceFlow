from datetime import date

import pytest

from receipt_payments import (
    BillAlreadyPaidError,
    BillNotFoundError,
    PaymentPersistenceError,
    ReceiptStorageError,
    persist_private_receipt_payment,
)
from receipt_uploads import ReceiptValidationError


OWNER_ID = "11111111-1111-4111-8111-111111111111"
BILL_ID = "22222222-2222-4222-8222-222222222222"
JPEG_BYTES = b"\xff\xd8\xff" + b"synthetic-receipt"


class Response:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, client, operation, payload=None):
        self.client = client
        self.operation = operation
        self.payload = payload
        self.filters = []

    def select(self, *_args, **_kwargs):
        self.operation = "select"
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = payload
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def neq(self, column, value):
        self.filters.append(("neq", column, value))
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self.operation == "select":
            return Response(self.client.select_rows)
        if self.operation == "update":
            self.client.update_payloads.append(self.payload)
            self.client.update_filters.append(list(self.filters))
            if self.client.update_error is not None:
                raise self.client.update_error
            return Response(self.client.update_rows)
        raise AssertionError(f"Unexpected operation: {self.operation}")


class DataClient:
    def __init__(self, *, select_rows=None, update_rows=None, update_error=None):
        self.select_rows = select_rows if select_rows is not None else [{"id": BILL_ID, "status": "pending"}]
        self.update_rows = update_rows if update_rows is not None else [{"id": BILL_ID}]
        self.update_error = update_error
        self.update_payloads = []
        self.update_filters = []

    def table(self, name):
        assert name == "finance_bills"
        return Query(self, "table")


class Bucket:
    def __init__(self, *, upload_error=None, remove_error=None):
        self.upload_error = upload_error
        self.remove_error = remove_error
        self.uploads = []
        self.removals = []

    def upload(self, **kwargs):
        if self.upload_error is not None:
            raise self.upload_error
        self.uploads.append(kwargs)
        return {"path": kwargs["path"]}

    def remove(self, paths):
        self.removals.append(paths)
        if self.remove_error is not None:
            raise self.remove_error
        return {"removed": paths}

    def get_public_url(self, *_args, **_kwargs):
        raise AssertionError("Private payment flow must never request a public URL")


class Storage:
    def __init__(self, bucket):
        self.bucket = bucket
        self.requested_buckets = []

    def from_(self, name):
        self.requested_buckets.append(name)
        assert name == "receipts"
        return self.bucket


class StorageClient:
    def __init__(self, bucket):
        self.storage = Storage(bucket)


def test_persist_private_receipt_payment_uses_owner_scoped_path_and_no_public_url():
    data_client = DataClient()
    bucket = Bucket()

    result = persist_private_receipt_payment(
        data_client=data_client,
        storage_client=StorageClient(bucket),
        owner_id=OWNER_ID,
        bill_id=BILL_ID,
        content=JPEG_BYTES,
        declared_mime_type="image/jpeg",
        payment_date=date(2026, 8, 14),
    )

    assert result.bill_id == BILL_ID
    assert result.payment_date == "2026-08-14"
    assert result.receipt_path.startswith(f"{OWNER_ID}/{BILL_ID}/")
    assert result.receipt_path.endswith(".jpg")
    assert len(bucket.uploads) == 1
    assert bucket.uploads[0]["path"] == result.receipt_path
    assert bucket.uploads[0]["file"] == JPEG_BYTES
    assert bucket.uploads[0]["file_options"] == {"content-type": "image/jpeg"}
    assert data_client.update_payloads == [
        {
            "status": "paid",
            "payment_date": "2026-08-14",
            "receipt_path": result.receipt_path,
        }
    ]
    assert data_client.update_filters == [
        [("eq", "id", BILL_ID), ("neq", "status", "paid")]
    ]
    assert bucket.removals == []


def test_bill_not_visible_in_authenticated_scope_fails_before_storage():
    data_client = DataClient(select_rows=[])
    bucket = Bucket()

    with pytest.raises(BillNotFoundError):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="image/jpeg",
        )

    assert bucket.uploads == []
    assert data_client.update_payloads == []


def test_already_paid_bill_fails_before_storage():
    data_client = DataClient(select_rows=[{"id": BILL_ID, "status": "paid"}])
    bucket = Bucket()

    with pytest.raises(BillAlreadyPaidError):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="image/jpeg",
        )

    assert bucket.uploads == []


def test_mime_spoofing_fails_before_storage_and_update():
    data_client = DataClient()
    bucket = Bucket()

    with pytest.raises(ReceiptValidationError):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="application/pdf",
        )

    assert bucket.uploads == []
    assert data_client.update_payloads == []


def test_storage_failure_does_not_mark_bill_paid():
    data_client = DataClient()
    bucket = Bucket(upload_error=RuntimeError("provider detail must stay internal"))

    with pytest.raises(ReceiptStorageError, match="Could not persist the private receipt"):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="image/jpeg",
        )

    assert data_client.update_payloads == []
    assert bucket.removals == []


def test_database_failure_removes_uploaded_private_object():
    data_client = DataClient(update_error=RuntimeError("database detail"))
    bucket = Bucket()

    with pytest.raises(PaymentPersistenceError, match="Could not persist the payment state"):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="image/jpeg",
        )

    assert len(bucket.uploads) == 1
    uploaded_path = bucket.uploads[0]["path"]
    assert bucket.removals == [[uploaded_path]]


def test_zero_row_update_is_treated_as_authorization_or_race_failure_and_cleans_up():
    data_client = DataClient(update_rows=[])
    bucket = Bucket()

    with pytest.raises(PaymentPersistenceError, match="affected no rows"):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="image/jpeg",
        )

    uploaded_path = bucket.uploads[0]["path"]
    assert bucket.removals == [[uploaded_path]]


def test_cleanup_failure_does_not_mask_authoritative_database_failure():
    data_client = DataClient(update_error=RuntimeError("database unavailable"))
    bucket = Bucket(remove_error=RuntimeError("storage cleanup unavailable"))

    with pytest.raises(PaymentPersistenceError, match="Could not persist the payment state"):
        persist_private_receipt_payment(
            data_client=data_client,
            storage_client=StorageClient(bucket),
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
            content=JPEG_BYTES,
            declared_mime_type="image/jpeg",
        )

    assert len(bucket.removals) == 1
