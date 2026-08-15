from datetime import date
from decimal import Decimal

import api_handlers


class Result:
    def __init__(self, data):
        self.data = data


class Query:
    def __init__(self, table_name, rows):
        self.table_name = table_name
        self.rows = list(rows)
        self.filters = []

    def select(self, *_args, **_kwargs):
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
        self.filters.append(("in", column, tuple(values)))
        return self

    def execute(self):
        rows = self.rows
        for operator, column, value in self.filters:
            if operator == "eq":
                rows = [row for row in rows if row.get(column) == value]
            elif operator == "gte":
                rows = [row for row in rows if row.get(column) is not None and str(row[column]) >= str(value)]
            elif operator == "lte":
                rows = [row for row in rows if row.get(column) is not None and str(row[column]) <= str(value)]
            elif operator == "in":
                rows = [row for row in rows if row.get(column) in value]
        return Result(rows)


class FakeSupabase:
    def __init__(self):
        self.tables = {
            "finance_incomes": [
                {"date": "2026-08-13", "amount": "999.00"},
                {"date": "2026-08-14", "amount": "100.00"},
                {"date": "2026-08-15", "amount": "25.00"},
            ],
            "finance_bills": [
                {
                    "status": "paid",
                    "payment_date": "2026-08-14",
                    "due_date": "2026-08-14",
                    "amount": "20.00",
                    "is_recurring": False,
                },
                {
                    "status": "pending",
                    "payment_date": None,
                    "due_date": "2026-08-20",
                    "amount": "30.00",
                    "is_recurring": False,
                },
            ],
        }

    def table(self, name):
        return Query(name, self.tables[name])


def settings(initial_date):
    return {
        "initial_balance": "1000.00",
        "initial_balance_date": initial_date,
        "emergency_fund_goal": "0.00",
        "emergency_fund_balance": "0.00",
    }


def test_initial_balance_boundary_includes_income_and_payment_on_same_financial_date(monkeypatch):
    monkeypatch.setattr(api_handlers, "financial_today", lambda: date(2026, 8, 14))
    supabase = FakeSupabase()

    on_correct_local_day = api_handlers._calculate_financials(supabase, settings("2026-08-14"))
    after_utc_drift = api_handlers._calculate_financials(supabase, settings("2026-08-15"))

    # D is inclusive: income +100 and payment -20 on D are both authoritative.
    assert on_correct_local_day["current_balance"] == Decimal("1105.00")
    assert on_correct_local_day["estimated_surplus"] == Decimal("1075.00")

    # Control: shifting the same product boundary to D+1 excludes both D records.
    assert after_utc_drift["current_balance"] == Decimal("1025.00")
    assert after_utc_drift["estimated_surplus"] == Decimal("995.00")
    assert on_correct_local_day != after_utc_drift
