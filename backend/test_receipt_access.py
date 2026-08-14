import pytest

import receipt_access
from receipt_access import ReceiptAccessError, ReceiptNotFoundError, create_authorized_receipt_access


OWNER_ID = "11111111-1111-4111-8111-111111111111"
BILL_ID = "22222222-2222-4222-8222-222222222222"
RECEIPT_PATH = f"{OWNER_ID}/{BILL_ID}/opaque.pdf"


class Response:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []

    def select(self, fields):
        assert fields == "id,receipt_path"
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, value):
        assert value == 1
        return self

    def execute(self):
        return Response(self.rows)


class DataClient:
    def __init__(self, rows):
        self.query = Query(rows)

    def table(self, name):
        assert name == "finance_bills"
        return self.query


def test_authorizes_with_user_scoped_query_before_signed_storage_access(monkeypatch):
    data_client = DataClient([{"id": BILL_ID, "receipt_path": RECEIPT_PATH}])
    calls = []

    def fake_signed_url(**kwargs):
        calls.append(kwargs)
        return {"signedURL": "https://signed.invalid/receipt"}

    monkeypatch.setattr(receipt_access, "create_receipt_signed_url", fake_signed_url)

    result = create_authorized_receipt_access(
        data_client=data_client,
        owner_id=OWNER_ID,
        bill_id=BILL_ID,
        expires_in=300,
    )

    assert data_client.query.filters == [("id", BILL_ID)]
    assert calls == [
        {
            "owner_id": OWNER_ID,
            "bill_id": BILL_ID,
            "receipt_path": RECEIPT_PATH,
            "expires_in": 300,
        }
    ]
    assert result.bill_id == BILL_ID
    assert result.receipt_path == RECEIPT_PATH
    assert result.signed_url == "https://signed.invalid/receipt"
    assert result.expires_in == 300


def test_cross_user_or_missing_bill_never_reaches_privileged_storage(monkeypatch):
    data_client = DataClient([])

    def forbidden_call(**_kwargs):
        raise AssertionError("Privileged storage must not run for an unauthorized bill")

    monkeypatch.setattr(receipt_access, "create_receipt_signed_url", forbidden_call)

    with pytest.raises(ReceiptNotFoundError, match="authenticated user scope"):
        create_authorized_receipt_access(
            data_client=data_client,
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
        )


def test_bill_without_receipt_never_reaches_privileged_storage(monkeypatch):
    data_client = DataClient([{"id": BILL_ID, "receipt_path": None}])

    def forbidden_call(**_kwargs):
        raise AssertionError("Privileged storage must not run without a receipt path")

    monkeypatch.setattr(receipt_access, "create_receipt_signed_url", forbidden_call)

    with pytest.raises(ReceiptNotFoundError, match="does not have a private receipt"):
        create_authorized_receipt_access(
            data_client=data_client,
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
        )


@pytest.mark.parametrize(
    ("provider_response", "expected"),
    [
        ({"signedURL": "https://signed.invalid/a"}, "https://signed.invalid/a"),
        ({"signedUrl": "https://signed.invalid/b"}, "https://signed.invalid/b"),
        ({"signed_url": "https://signed.invalid/c"}, "https://signed.invalid/c"),
        ("https://signed.invalid/d", "https://signed.invalid/d"),
    ],
)
def test_accepts_supported_supabase_signed_url_response_shapes(monkeypatch, provider_response, expected):
    data_client = DataClient([{"id": BILL_ID, "receipt_path": RECEIPT_PATH}])
    monkeypatch.setattr(
        receipt_access,
        "create_receipt_signed_url",
        lambda **_kwargs: provider_response,
    )

    result = create_authorized_receipt_access(
        data_client=data_client,
        owner_id=OWNER_ID,
        bill_id=BILL_ID,
    )

    assert result.signed_url == expected


def test_malformed_storage_response_fails_closed(monkeypatch):
    data_client = DataClient([{"id": BILL_ID, "receipt_path": RECEIPT_PATH}])
    monkeypatch.setattr(
        receipt_access,
        "create_receipt_signed_url",
        lambda **_kwargs: {"unexpected": "value"},
    )

    with pytest.raises(ReceiptAccessError, match="did not return a signed receipt URL"):
        create_authorized_receipt_access(
            data_client=data_client,
            owner_id=OWNER_ID,
            bill_id=BILL_ID,
        )
