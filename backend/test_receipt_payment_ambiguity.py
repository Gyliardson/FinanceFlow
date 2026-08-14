from datetime import date
from io import BytesIO

from PIL import Image
import pytest

import receipt_access
from receipt_access import create_authorized_receipt_access
from receipt_payments import (
    BillAlreadyPaidError,
    PaymentPersistenceError,
    persist_private_receipt_payment,
)


OWNER_ID = "11111111-1111-4111-8111-111111111111"
BILL_ID = "22222222-2222-4222-8222-222222222222"


def _jpeg_bytes():
    output = BytesIO()
    Image.new("RGB", (4, 4), (20, 40, 60)).save(output, format="JPEG")
    return output.getvalue()


JPEG_BYTES = _jpeg_bytes()
OTHER_PATH = f"{OWNER_ID}/{BILL_ID}/other.jpg"


class Response:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, client, operation="select", payload=None):
        self.client = client
        self.operation = operation
        self.payload = payload
        self.filters = []

    def select(self, *_args):
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

    def limit(self, *_args):
        return self

    def execute(self):
        if self.operation == "select":
            self.client.select_calls += 1
            if self.client.select_calls in self.client.select_error_calls:
                raise RuntimeError("authoritative read unavailable")
            return Response([] if self.client.bill is None else [dict(self.client.bill)])

        self.client.update_payloads.append(self.payload)
        if self.client.mode == "fail_before_commit":
            raise RuntimeError("write failed before commit")
        if self.client.mode == "zero_rows":
            return Response([])
        if self.client.mode == "other_payment_wins":
            self.client.bill.update(
                status="paid",
                payment_date="2026-08-14",
                receipt_path=OTHER_PATH,
            )
            return Response([])

        self.client.bill.update(self.payload)
        committed = dict(self.client.bill)
        if self.client.mode == "commit_then_timeout":
            raise TimeoutError("commit succeeded but response was lost")
        return Response([committed])


class DataClient:
    def __init__(self, mode="success", select_error_calls=None):
        self.mode = mode
        self.bill = {
            "id": BILL_ID,
            "status": "pending",
            "payment_date": None,
            "receipt_path": None,
        }
        self.select_calls = 0
        self.select_error_calls = set(select_error_calls or [])
        self.update_payloads = []

    def table(self, name):
        assert name == "finance_bills"
        return Query(self)


class Bucket:
    def __init__(self):
        self.uploads = []
        self.removals = []
        self.objects = {}

    def upload(self, **kwargs):
        self.uploads.append(kwargs)
        self.objects[kwargs["path"]] = kwargs["file"]
        return {"path": kwargs["path"]}

    def remove(self, paths):
        self.removals.append(paths)
        for path in paths:
            self.objects.pop(path, None)
        return {"removed": paths}


class Storage:
    def __init__(self, bucket):
        self.bucket = bucket

    def from_(self, name):
        assert name == "receipts"
        return self.bucket


class StorageClient:
    def __init__(self, bucket):
        self.storage = Storage(bucket)


def persist(client, bucket):
    return persist_private_receipt_payment(
        data_client=client,
        storage_client=StorageClient(bucket),
        owner_id=OWNER_ID,
        bill_id=BILL_ID,
        content=JPEG_BYTES,
        declared_mime_type="image/jpeg",
        payment_date=date(2026, 8, 14),
    )


def test_commit_then_response_timeout_preserves_receipt_and_reconciles_success():
    client = DataClient(mode="commit_then_timeout")
    bucket = Bucket()

    result = persist(client, bucket)

    assert client.select_calls == 2
    assert client.bill["status"] == "paid"
    assert client.bill["receipt_path"] == result.receipt_path
    assert result.receipt_path in bucket.objects
    assert bucket.removals == []


def test_reconciled_ambiguous_commit_remains_available_through_signed_access(monkeypatch):
    client = DataClient(mode="commit_then_timeout")
    bucket = Bucket()

    payment = persist(client, bucket)

    signed_calls = []

    def fake_signed_url(**kwargs):
        signed_calls.append(kwargs)
        return {"signedURL": "https://signed.invalid/reconciled-receipt"}

    monkeypatch.setattr(receipt_access, "create_receipt_signed_url", fake_signed_url)
    access = create_authorized_receipt_access(
        data_client=client,
        owner_id=OWNER_ID,
        bill_id=BILL_ID,
        expires_in=300,
    )

    assert access.receipt_path == payment.receipt_path
    assert payment.receipt_path in bucket.objects
    assert signed_calls == [
        {
            "owner_id": OWNER_ID,
            "bill_id": BILL_ID,
            "receipt_path": payment.receipt_path,
            "expires_in": 300,
        }
    ]


def test_failed_reconciliation_preserves_committed_receipt_and_later_retry_converges():
    client = DataClient(mode="commit_then_timeout", select_error_calls={2})
    bucket = Bucket()

    with pytest.raises(PaymentPersistenceError, match="retained for reconciliation"):
        persist(client, bucket)

    committed_path = client.bill["receipt_path"]
    assert committed_path in bucket.objects
    assert bucket.removals == []
    assert len(bucket.uploads) == 1

    client.select_error_calls.clear()
    result = persist(client, bucket)

    assert result.receipt_path == committed_path
    assert result.payment_date == "2026-08-14"
    assert len(bucket.uploads) == 1
    assert bucket.removals == []


def test_definite_pre_commit_failure_rechecks_unpaid_state_then_cleans_orphan():
    client = DataClient(mode="fail_before_commit")
    bucket = Bucket()

    with pytest.raises(PaymentPersistenceError, match="Could not persist the payment state"):
        persist(client, bucket)

    uploaded_path = bucket.uploads[0]["path"]
    assert client.bill["status"] == "pending"
    assert client.bill["receipt_path"] is None
    assert client.select_calls == 2
    assert bucket.removals == [[uploaded_path]]
    assert uploaded_path not in bucket.objects


def test_zero_row_with_other_committed_receipt_cleans_only_losing_upload():
    client = DataClient(mode="other_payment_wins")
    bucket = Bucket()

    with pytest.raises(BillAlreadyPaidError, match="another payment attempt"):
        persist(client, bucket)

    uploaded_path = bucket.uploads[0]["path"]
    assert client.bill["receipt_path"] == OTHER_PATH
    assert bucket.removals == [[uploaded_path]]
    assert uploaded_path not in bucket.objects


def test_zero_row_while_still_unpaid_cleans_only_after_authoritative_reread():
    client = DataClient(mode="zero_rows")
    bucket = Bucket()

    with pytest.raises(PaymentPersistenceError, match="affected no rows"):
        persist(client, bucket)

    uploaded_path = bucket.uploads[0]["path"]
    assert client.select_calls == 2
    assert client.bill["status"] == "pending"
    assert bucket.removals == [[uploaded_path]]
