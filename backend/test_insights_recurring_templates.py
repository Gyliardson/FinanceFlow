from types import SimpleNamespace

import api_handlers


class FakeQuery:
    def __init__(self, table_name, calls):
        self.table_name = table_name
        self.calls = calls
        self.filters = []

    def select(self, columns):
        self.calls.append((self.table_name, "select", columns))
        return self

    def eq(self, column, value):
        self.filters.append(("eq", column, value))
        self.calls.append((self.table_name, "eq", column, value))
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
        if self.table_name == "finance_incomes":
            return SimpleNamespace(data=[])

        if ("eq", "status", "paid") in self.filters:
            # A pre-existing anomalous paid template must never affect cash-flow
            # totals. Only the actual non-template paid child is authoritative.
            if ("eq", "is_recurring", False) in self.filters:
                return SimpleNamespace(data=[{"amount": "10.00"}])
            return SimpleNamespace(data=[{"amount": "10.00"}, {"amount": "10.00"}])

        if ("in", "status", ("pending", "overdue")) in self.filters:
            # Model one recurring template and one generated child for the same
            # R$25 obligation. Only the generated child is a payable liability.
            if ("eq", "is_recurring", False) in self.filters:
                return SimpleNamespace(data=[{"amount": "25.00"}])
            return SimpleNamespace(data=[{"amount": "25.00"}, {"amount": "25.00"}])

        return SimpleNamespace(data=[])


class FakeSupabase:
    def __init__(self):
        self.calls = []

    def table(self, table_name):
        return FakeQuery(table_name, self.calls)


def test_authoritative_cash_flow_excludes_recurring_templates(monkeypatch):
    monkeypatch.setattr(api_handlers, "financial_today", lambda: api_handlers.date(2026, 8, 14))
    supabase = FakeSupabase()

    result = api_handlers._calculate_financials(
        supabase,
        {
            "initial_balance": "100.00",
            "initial_balance_date": "2026-08-01",
            "emergency_fund_goal": "0.00",
            "emergency_fund_balance": "0.00",
        },
    )

    assert result["current_balance"] == api_handlers.money("90.00")
    assert result["estimated_surplus"] == api_handlers.money("65.00")
    recurring_false_filters = [
        call
        for call in supabase.calls
        if call == ("finance_bills", "eq", "is_recurring", False)
    ]
    assert len(recurring_false_filters) == 2
