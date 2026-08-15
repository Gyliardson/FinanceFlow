from datetime import date
from io import BytesIO

from PIL import Image
import pytest

from receipt_payments import PaymentPersistenceError, persist_private_receipt_payment


OWNER_ID = "11111111-1111-4111-8111-111111111111"
BILL_ID = "22222222-2222-4222-8222-222222222222"
NAMESPACE = f"{OWNER_ID}/{BILL_ID}"


def _jpeg_bytes():
    output = BytesIO()
    Image.new("RGB", (4, 4), (20, 40, 60)).save(output, format="JPEG")
    return output.getvalue()


JPEG_BYTES = _jpeg_bytes()


class Response:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, client, operation="select", payload=None):
        self.client = client
        self.operation = operation
        self.payload = payload

    def select(self, *_args):
        self.operation = "select"
        return self

    def update(self, payload):
        self.operation = "update"
        self.payload = payload
        return self

    def eq(self, *_args):
        return self

    def neq(self, *_args):
        return self

    def limit(self, *_args):
        return self

    def execute(self):
        if self.operation == "select":
            self.client.select_calls += 1
            if self.client.select_calls in self.client.select_error_calls:
                raise RuntimeError("authoritative read unavailable")
            return Response([dict(self.client.bill)])

        if self.client.fail_before_commit:
            raise RuntimeError("write failed before commit")
        self.client.bill.update(self.payload)
        return Response([dict(self.client.bill)])


class DataClient:
    def __init__(self):
        self.bill = {
            "id": BILL_ID,
            "status": "pending",
            "payment_date": None,
            "receipt_path": None,
            "is_recurring": False,
        }
        self.select_calls = 0
        self.select_error_calls = set()
        self.fail_before_commit = False

    def table(self, name):
        assert name == "finance_bills"
        return Query(self)


class Bucket:
    def __init__(self):
        self.objects = {}
        self.uploads = []
        self.removals = []
        self.list_error = False

    def upload(self, **kwargs):
        self.uploads.append(kwargs)
        self.objects[kwargs["path"]] = kwargs["file"]
        return {"path": kwargs["path"]}

    def list(self, path):
        if self.list_error:
            raise RuntimeError("storage listing unavailable")
        prefix = f"{path}/"
        return [
            {"name": object_path.removeprefix(prefix)}
            for object_path in sorted(self.objects)
            if object_path.startswith(prefix)
            and "/" not in object_path.removeprefix(prefix)
        ]

    def remove(self, paths):
        self.removals.append(list(paths))
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


def test_retained_ambiguous_orphan_is_removed_after_later_success():
    client = DataClient()
    bucket = Bucket()
    client.fail_before_commit = True
    client.select_error_calls = {2}

    with pytest.raises(PaymentPersistenceError, match="retained for reconciliation"):
        persist(client, bucket)

    stale_path = bucket.uploads[0]["path"]
    assert stale_path in bucket.objects
    assert bucket.removals == []

    client.fail_before_commit = False
    client.select_error_calls.clear()
    result = persist(client, bucket)

    assert result.receipt_path != stale_path
    assert result.receipt_path in bucket.objects
    assert stale_path not in bucket.objects
    assert any(stale_path in removal for removal in bucket.removals)


def test_retry_of_committed_payment_cleans_stale_namespace_without_new_upload():
    client = DataClient()
    bucket = Bucket()
    committed_path = f"{NAMESPACE}/committed.jpg"
    stale_path = f"{NAMESPACE}/stale.jpg"
    client.bill.update(
        status="paid",
        payment_date="2026-08-14",
        receipt_path=committed_path,
    )
    bucket.objects[committed_path] = b"committed"
    bucket.objects[stale_path] = b"stale"

    result = persist(client, bucket)

    assert result.receipt_path == committed_path
    assert bucket.uploads == []
    assert committed_path in bucket.objects
    assert stale_path not in bucket.objects


def test_cleanup_listing_failure_does_not_change_authoritative_payment_success():
    client = DataClient()
    bucket = Bucket()
    bucket.list_error = True

    result = persist(client, bucket)

    assert client.bill["status"] == "paid"
    assert client.bill["receipt_path"] == result.receipt_path
    assert result.receipt_path in bucket.objects
