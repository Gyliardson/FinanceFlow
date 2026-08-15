from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import api_handlers


class Query:
    def __init__(self, rows):
        self.rows = list(rows)
        self.filters = []
        self.selected = "*"

    def select(self, columns):
        self.selected = columns
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        return self

    def gte(self, column, value):
        self.filters.append(("gte", column, value))
        return self

    def lte(self, column, value):
        self.filters.append(("lte", column, value))
        return self

    def in_(self, column, values):
        self.filters.append(("in", column, values))
        return self

    def execute(self):
        rows = self.rows
        for operation, column, value in self.filters:
            if operation == "eq":
                rows = [row for row in rows if row.get(column) == value]
            elif operation == "gte":
                rows = [row for row in rows if row.get(column) is not None and row[column] >= value]
            elif operation == "lte":
                rows = [row for row in rows if row.get(column) is not None and row[column] <= value]
            elif operation == "in":
                rows = [row for row in rows if row.get(column) in value]
        if self.selected == "amount":
            rows = [{"amount": row["amount"]} for row in rows]
        return SimpleNamespace(data=rows)


class FakeSupabase:
    def __init__(self, incomes, bills):
        self.incomes = incomes
        self.bills = bills
        self.queries = []

    def table(self, name):
        query = Query(self.incomes if name == "finance_incomes" else self.bills)
        self.queries.append((name, query))
        return query


def settings(initial="100.00"):
    return {
        "initial_balance": initial,
        "initial_balance_date": "2026-08-01",
        "emergency_fund_goal": "1000.00",
        "emergency_fund_balance": "0.00",
    }


def test_current_balance_excludes_future_income_but_includes_today(monkeypatch):
    monkeypatch.setattr(api_handlers, "financial_today", lambda: date(2026, 8, 15))
    client = FakeSupabase(
        incomes=[
            {"amount": "25.00", "date": "2026-08-14"},
            {"amount": "10.00", "date": "2026-08-15"},
            {"amount": "900.00", "date": "2026-08-16"},
        ],
        bills=[],
    )

    result = api_handlers._calculate_financials(client, settings())

    assert result["current_balance"] == Decimal("135.00")
    income_query = next(query for name, query in client.queries if name == "finance_incomes")
    assert ("gte", "date", "2026-08-01") in income_query.filters
    assert ("lte", "date", "2026-08-15") in income_query.filters


def test_current_balance_does_not_subtract_future_payment(monkeypatch):
    monkeypatch.setattr(api_handlers, "financial_today", lambda: date(2026, 8, 15))
    client = FakeSupabase(
        incomes=[],
        bills=[
            {
                "amount": "20.00",
                "status": "paid",
                "is_recurring": False,
                "payment_date": "2026-08-15",
                "due_date": "2026-08-10",
            },
            {
                "amount": "70.00",
                "status": "paid",
                "is_recurring": False,
                "payment_date": "2026-08-16",
                "due_date": "2026-08-10",
            },
        ],
    )

    result = api_handlers._calculate_financials(client, settings())

    assert result["current_balance"] == Decimal("80.00")
    paid_query = next(
        query
        for name, query in client.queries
        if name == "finance_bills" and ("eq", "status", "paid") in query.filters
    )
    assert ("gte", "payment_date", "2026-08-01") in paid_query.filters
    assert ("lte", "payment_date", "2026-08-15") in paid_query.filters
