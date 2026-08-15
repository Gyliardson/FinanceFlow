import asyncio
from types import SimpleNamespace

import bill_read_routes


class Query:
    def __init__(self):
        self.filters = []

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = [
            {"id": "template", "status": "pending", "is_recurring": True},
            {"id": "child", "status": "pending", "is_recurring": False},
        ]
        for column, value in self.filters:
            rows = [row for row in rows if row.get(column) == value]
        return SimpleNamespace(data=rows)


class Client:
    def __init__(self):
        self.query = Query()

    def table(self, name):
        assert name == "finance_bills"
        return self.query


def test_pending_payment_candidates_exclude_recurring_templates(monkeypatch):
    client = Client()
    monkeypatch.setattr(bill_read_routes, "get_supabase_client", lambda: client)

    response = asyncio.run(bill_read_routes.get_pending_bills())

    assert response == {
        "data": [
            {
                "id": "child",
                "status": "pending",
                "is_recurring": False,
                "has_receipt": False,
                "legacy_receipt_requires_reconciliation": False,
            }
        ]
    }
    assert ("status", "pending") in client.query.filters
    assert ("is_recurring", False) in client.query.filters
