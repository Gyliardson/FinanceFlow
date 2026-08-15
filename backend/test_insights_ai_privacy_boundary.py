import asyncio
from types import SimpleNamespace

import insights_routes


class FakeSettingsQuery:
    def __init__(self, settings, updates):
        self.settings = settings
        self.updates = updates
        self.pending_update = None

    def select(self, _columns):
        return self

    def limit(self, _value):
        return self

    def update(self, payload):
        self.pending_update = payload
        return self

    def eq(self, _column, _value):
        return self

    def execute(self):
        if self.pending_update is not None:
            self.updates.append(self.pending_update)
            return SimpleNamespace(data=[self.pending_update])
        return SimpleNamespace(data=[self.settings])


class FakeSupabase:
    def __init__(self, settings):
        self.settings = settings
        self.updates = []

    def table(self, table_name):
        assert table_name == "finance_user_settings"
        return FakeSettingsQuery(self.settings, self.updates)


def _financials():
    return {
        "current_balance": 100,
        "estimated_surplus": 75,
        "emergency_fund_goal": 1000,
        "emergency_fund_balance": 250,
    }


def test_passive_get_never_calls_external_ai(monkeypatch):
    supabase = FakeSupabase(
        {
            "id": "settings-1",
            "latest_insight_text": "Insight previamente persistido",
            "latest_insight_date": "2025-01-01",
        }
    )
    monkeypatch.setattr(insights_routes, "get_supabase_client", lambda: supabase)
    monkeypatch.setattr(insights_routes, "_calculate_financials", lambda *_args: _financials())

    def forbidden_provider_call(_payload):
        raise AssertionError("passive GET must not invoke external AI")

    monkeypatch.setattr(insights_routes, "generate_financial_insights", forbidden_provider_call)

    result = asyncio.run(insights_routes.get_insights())

    assert result["data"]["insight"] == "Insight previamente persistido"
    assert result["data"]["current_balance"] == 100
    assert supabase.updates == []


def test_passive_get_returns_null_when_no_stored_insight(monkeypatch):
    supabase = FakeSupabase({"id": "settings-1", "latest_insight_text": None})
    monkeypatch.setattr(insights_routes, "get_supabase_client", lambda: supabase)
    monkeypatch.setattr(insights_routes, "_calculate_financials", lambda *_args: _financials())
    monkeypatch.setattr(
        insights_routes,
        "generate_financial_insights",
        lambda _payload: (_ for _ in ()).throw(AssertionError("provider must stay unused")),
    )

    result = asyncio.run(insights_routes.get_insights())

    assert result["data"]["insight"] is None
    assert supabase.updates == []


def test_explicit_refresh_calls_provider_and_persists_result(monkeypatch):
    supabase = FakeSupabase({"id": "settings-1", "latest_insight_text": None})
    provider_calls = []
    monkeypatch.setattr(insights_routes, "get_supabase_client", lambda: supabase)
    monkeypatch.setattr(insights_routes, "_calculate_financials", lambda *_args: _financials())
    monkeypatch.setattr(
        insights_routes,
        "generate_financial_insights",
        lambda payload: provider_calls.append(payload) or {"status": "success", "insight": "Novo insight"},
    )
    monkeypatch.setattr(
        insights_routes,
        "financial_today",
        lambda: insights_routes.financial_today.__globals__["date"](2026, 8, 15)
        if "date" in insights_routes.financial_today.__globals__
        else __import__("datetime").date(2026, 8, 15),
    )

    result = asyncio.run(insights_routes.refresh_insights())

    assert provider_calls == [_financials()]
    assert result["data"]["insight"] == "Novo insight"
    assert supabase.updates == [
        {"latest_insight_text": "Novo insight", "latest_insight_date": "2026-08-15"}
    ]
