import asyncio
from types import SimpleNamespace

import bill_read_routes


class Query:
    def __init__(self):
        self.filters = []

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, tuple(values)))
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        rows = [
            {"id": "template", "status": "pending", "is_recurring": True},
            {"id": "pending-child", "status": "pending", "is_recurring": False},
            {"id": "overdue-child", "status": "overdue", "is_recurring": False},
            {"id": "paid-child", "status": "paid", "is_recurring": False},
        ]
        for operator, column, value in self.filters:
            if operator == "eq":
                rows = [row for row in rows if row.get(column) == value]
            elif operator == "in":
                rows = [row for row in rows if row.get(column) in value]
        return SimpleNamespace(data=rows)


class Client:
    def __init__(self):
        self.query = Query()

    def table(self, name):
        assert name == "finance_bills"
        return self.query


def test_payment_candidates_include_pending_and_overdue_but_exclude_paid_and_templates(monkeypatch):
    client = Client()
    monkeypatch.setattr(bill_read_routes, "get_supabase_client", lambda: client)

    response = asyncio.run(bill_read_routes.get_pending_bills())

    assert response == {
        "data": [
            {
                "id": "pending-child",
                "status": "pending",
                "is_recurring": False,
                "has_receipt": False,
                "legacy_receipt_requires_reconciliation": False,
            },
            {
                "id": "overdue-child",
                "status": "overdue",
                "is_recurring": False,
                "has_receipt": False,
                "legacy_receipt_requires_reconciliation": False,
            },
        ]
    }
    assert ("in", "status", ("pending", "overdue")) in client.query.filters
    assert ("eq", "is_recurring", False) in client.query.filters
