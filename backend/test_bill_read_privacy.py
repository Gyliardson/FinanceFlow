import asyncio
from types import SimpleNamespace
from unittest.mock import patch

from bill_read_routes import get_bill_detail, get_bills, serialize_bill_for_client


BILL_ID = "22222222-2222-4222-8222-222222222222"
OWNER_ID = "11111111-1111-4111-8111-111111111111"


class Query:
    def __init__(self, rows):
        self.rows = rows
        self.filters = []

    def select(self, *_args):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        if column == "id":
            self.rows = [row for row in self.rows if row.get("id") == value]
        elif column == "parent_bill_id":
            self.rows = [row for row in self.rows if row.get("parent_bill_id") == value]
        return self

    def ilike(self, *_args):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=list(self.rows))


class Client:
    def __init__(self, rows):
        self.rows = rows

    def table(self, name):
        assert name == "finance_bills"
        return Query(list(self.rows))


def current_bill(**overrides):
    row = {
        "id": BILL_ID,
        "owner_id": OWNER_ID,
        "description": "Conta atual",
        "amount": "10.00",
        "due_date": "2026-08-20",
        "status": "paid",
        "is_recurring": False,
        "parent_bill_id": None,
        "receipt_path": f"{OWNER_ID}/{BILL_ID}/opaque.pdf",
        "receipt_url": "https://legacy-public.invalid/should-not-leave-api",
    }
    row.update(overrides)
    return row


def test_serializer_never_exposes_receipt_locator_fields():
    payload = serialize_bill_for_client(current_bill())

    assert "receipt_path" not in payload
    assert "receipt_url" not in payload
    assert payload["has_receipt"] is True
    assert payload["legacy_receipt_requires_reconciliation"] is False


def test_legacy_only_receipt_is_marked_for_reconciliation_without_url():
    payload = serialize_bill_for_client(current_bill(receipt_path=None))

    assert "receipt_path" not in payload
    assert "receipt_url" not in payload
    assert payload["has_receipt"] is False
    assert payload["legacy_receipt_requires_reconciliation"] is True


@patch("bill_read_routes.get_supabase_client")
def test_bill_list_minimizes_receipt_fields_before_response(mock_client):
    mock_client.return_value = Client([current_bill()])

    result = asyncio.run(get_bills())

    assert len(result["data"]) == 1
    assert result["data"][0]["has_receipt"] is True
    assert "receipt_path" not in result["data"][0]
    assert "receipt_url" not in result["data"][0]


@patch("bill_read_routes.get_supabase_client")
def test_detail_and_history_minimize_current_and_legacy_receipts(mock_client):
    child_id = "33333333-3333-4333-8333-333333333333"
    parent_id = "44444444-4444-4444-8444-444444444444"
    selected = current_bill(parent_bill_id=parent_id)
    sibling = current_bill(
        id=child_id,
        parent_bill_id=parent_id,
        receipt_path=None,
        receipt_url="https://legacy-public.invalid/sibling",
    )
    mock_client.return_value = Client([selected, sibling])

    result = asyncio.run(get_bill_detail(BILL_ID))

    assert result["bill"]["has_receipt"] is True
    assert "receipt_path" not in result["bill"]
    assert "receipt_url" not in result["bill"]
    assert result["history_count"] == 1
    assert result["history"][0]["legacy_receipt_requires_reconciliation"] is True
    assert "receipt_path" not in result["history"][0]
    assert "receipt_url" not in result["history"][0]
