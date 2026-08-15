from datetime import date
from io import BytesIO

from PIL import Image
import pytest

from receipt_payments import (
    BillAlreadyPaidError,
    BillNotFoundError,
    PaymentPersistenceError,
    ReceiptStorageError,
    RecurringTemplatePaymentError,
    persist_private_receipt_payment,
)
from receipt_uploads import ReceiptValidationError


OWNER_ID = "11111111-1111-4111-8111-111111111111"
BILL_ID = "22222222-2222-4222-8222-222222222222"


def _jpeg_bytes():
    output = BytesIO()
    Image.new("RGB", (4, 4), (20, 40, 60)).save(output, format="JPEG")
    return output.getvalue()


JPEG_BYTES = _jpeg_bytes()


class Response:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, client):
        self.client = client

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def execute(self):
        if self.client.select_error is not None:
            error = self.client.select_error
            self.client.select_error = None
            raise error
        if self.client.select_responses:
            return Response(self.client.select_responses.pop(0))
        return Response(self.client.select_rows)


class RPCQuery:
    def __init__(self, client):
        self.client = client

    def execute(self):
        if self.client.rpc_error is not None:
            raise self.client.rpc_error
        return Response(self.client.rpc_data)


class DataClient:
    def __init__(
        self,
        *,
        select_rows=None,
        select_responses=None,
        select_error=None,
        rpc_data=None,
        rpc_error=None,
    ):
        self.select_rows = select_rows if select_rows is not None else [
            {"id": BILL_ID, "status": "pending", "is_recurring": False}
        ]
        self.select_responses = list(select_responses or [])
        self.select_error = select_error
        self.rpc_error = rpc_error
        self.rpc_calls = []
        self.rpc_data = rpc_data

    def table(self, name):
        assert name == "finance_bills"
        return Query(self)

    def rpc(self, name, payload):
        self.rpc_calls.append((name, payload))
        if self.rpc_data is None and self.rpc_error is None:
            self.rpc_data = {
                "status": "success",
                "data": {
                    "id": BILL_ID,
                    "status": "paid",
                    "is_recurring": False,
                    "payment_date": "2026-08-15",
                    "receipt_path": payload["p_receipt_path"],
                },
            }
        return RPCQuery(self)


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

    def list(self, **_kwargs):
        return []

    def get_public_url(self, *_args, **_kwargs):
        raise AssertionError("Private payment flow must never request a public URL")


class Storage:
    def __init__(self, bucket):
        self.bucket = bucket

    def from_(self, name):
        assert name == "receipts"
        return self.bucket


class StorageClient:
    def __init__(self, bucket):
        self.storage = Storage(bucket)


def _persist(data_client, bucket, *, mime="image/jpeg"):
    return persist_private_receipt_payment(
        data_client=data_client,
        storage_client=StorageClient(bucket),
        owner_id=OWNER_ID,
        bill_id=BILL_ID,
        content=JPEG_BYTES,
        declared_mime_type=mime,
        payment_date=date(1999, 1, 1),
    )


def test_payment_uses_owner_scoped_private_path_and_database_rpc_date():
    data_client = DataClient()
    bucket = Bucket()

    result = _persist(data_client, bucket)

    assert result.bill_id == BILL_ID
    assert result.payment_date == "2026-08-15"
    assert result.payment_date != "1999-01-01"
    assert result.receipt_path.startswith(f"{OWNER_ID}/{BILL_ID}/")
    assert result.receipt_path.endswith(".jpg")
    assert bucket.uploads[0]["path"] == result.receipt_path
    assert bucket.uploads[0]["file"] == JPEG_BYTES
    assert bucket.uploads[0]["file_options"] == {"content-type": "image/jpeg"}
    assert data_client.rpc_calls == [
        (
            "finance_mark_bill_paid",
            {"p_bill_id": BILL_ID, "p_receipt_path": result.receipt_path},
        )
    ]


def test_recurring_template_fails_before_storage_or_rpc():
    data_client = DataClient(select_rows=[{"id": BILL_ID, "status": "pending", "is_recurring": True}])
    bucket = Bucket()

    with pytest.raises(RecurringTemplatePaymentError):
        _persist(data_client, bucket)

    assert bucket.uploads == []
    assert data_client.rpc_calls == []


def test_generated_recurring_child_remains_payable():
    data_client = DataClient(
        select_rows=[
            {
                "id": BILL_ID,
                "status": "pending",
                "is_recurring": False,
                "parent_bill_id": "template-id",
            }
        ]
    )
    bucket = Bucket()

    result = _persist(data_client, bucket)

    assert result.payment_date == "2026-08-15"
    assert len(bucket.uploads) == 1
    assert len(data_client.rpc_calls) == 1


def test_bill_not_visible_in_authenticated_scope_fails_before_storage():
    data_client = DataClient(select_rows=[])
    bucket = Bucket()

    with pytest.raises(BillNotFoundError):
        _persist(data_client, bucket)

    assert bucket.uploads == []
    assert data_client.rpc_calls == []


def test_already_paid_without_complete_receipt_fails_before_storage():
    data_client = DataClient(select_rows=[{"id": BILL_ID, "status": "paid", "is_recurring": False}])
    bucket = Bucket()

    with pytest.raises(BillAlreadyPaidError):
        _persist(data_client, bucket)

    assert bucket.uploads == []
    assert data_client.rpc_calls == []


def test_complete_existing_receipt_payment_converges_without_new_upload():
    existing = f"{OWNER_ID}/{BILL_ID}/existing.jpg"
    data_client = DataClient(
        select_rows=[
            {
                "id": BILL_ID,
                "status": "paid",
                "is_recurring": False,
                "payment_date": "2026-08-14",
                "receipt_path": existing,
            }
        ]
    )
    bucket = Bucket()

    result = _persist(data_client, bucket)

    assert result.receipt_path == existing
    assert result.payment_date == "2026-08-14"
    assert bucket.uploads == []
    assert data_client.rpc_calls == []


def test_mime_spoofing_fails_before_storage_and_rpc():
    data_client = DataClient()
    bucket = Bucket()

    with pytest.raises(ReceiptValidationError):
        _persist(data_client, bucket, mime="application/pdf")

    assert bucket.uploads == []
    assert data_client.rpc_calls == []


def test_storage_failure_does_not_call_payment_rpc():
    data_client = DataClient()
    bucket = Bucket(upload_error=RuntimeError("provider detail must stay internal"))

    with pytest.raises(ReceiptStorageError, match="Could not persist the private receipt"):
        _persist(data_client, bucket)

    assert data_client.rpc_calls == []
    assert bucket.removals == []


def test_rpc_failure_pending_reread_removes_unreferenced_upload_and_is_unconfirmed():
    pending = {"id": BILL_ID, "status": "pending", "is_recurring": False}
    data_client = DataClient(
        select_responses=[[pending], [pending]],
        rpc_error=RuntimeError("database detail"),
    )
    bucket = Bucket()

    with pytest.raises(PaymentPersistenceError, match="Could not persist the payment state"):
        _persist(data_client, bucket)

    uploaded_path = bucket.uploads[0]["path"]
    assert bucket.removals == [[uploaded_path]]


def test_rpc_response_loss_after_commit_reconciles_authoritative_receipt():
    pending = {"id": BILL_ID, "status": "pending", "is_recurring": False}
    data_client = DataClient(select_responses=[[pending]], rpc_error=RuntimeError("response lost"))
    bucket = Bucket()

    original_rpc = data_client.rpc

    def rpc_with_commit(name, payload):
        query = original_rpc(name, payload)
        data_client.select_responses.append(
            [
                {
                    "id": BILL_ID,
                    "status": "paid",
                    "is_recurring": False,
                    "payment_date": "2026-08-15",
                    "receipt_path": payload["p_receipt_path"],
                }
            ]
        )
        return query

    data_client.rpc = rpc_with_commit

    result = _persist(data_client, bucket)

    assert result.payment_date == "2026-08-15"
    assert result.receipt_path == bucket.uploads[0]["path"]
    assert bucket.removals == []


def test_reconciliation_failure_retains_private_evidence_for_later_resolution():
    pending = {"id": BILL_ID, "status": "pending", "is_recurring": False}
    data_client = DataClient(select_responses=[[pending]], rpc_error=RuntimeError("response lost"))
    bucket = Bucket()

    original_rpc = data_client.rpc

    def rpc_then_break_read(name, payload):
        query = original_rpc(name, payload)
        data_client.select_error = RuntimeError("replica unavailable")
        return query

    data_client.rpc = rpc_then_break_read

    with pytest.raises(PaymentPersistenceError, match="retained for reconciliation"):
        _persist(data_client, bucket)

    assert len(bucket.uploads) == 1
    assert bucket.removals == []


def test_cleanup_failure_does_not_mask_authoritative_pending_failure():
    pending = {"id": BILL_ID, "status": "pending", "is_recurring": False}
    data_client = DataClient(
        select_responses=[[pending], [pending]],
        rpc_error=RuntimeError("database unavailable"),
    )
    bucket = Bucket(remove_error=RuntimeError("storage cleanup unavailable"))

    with pytest.raises(PaymentPersistenceError, match="Could not persist the payment state"):
        _persist(data_client, bucket)

    assert len(bucket.removals) == 1
