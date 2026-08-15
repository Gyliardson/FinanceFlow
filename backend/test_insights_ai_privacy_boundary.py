import asyncio
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

import ai_service
import insights_routes
import runtime


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


def test_provider_rejects_generation_without_explicit_user_action():
    with pytest.raises(ValueError, match="explicit user action"):
        ai_service.generate_financial_insights(_financials())


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

    def forbidden_provider_call(_payload, **_kwargs):
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
        lambda _payload, **_kwargs: (_ for _ in ()).throw(AssertionError("provider must stay unused")),
    )

    result = asyncio.run(insights_routes.get_insights())

    assert result["data"]["insight"] is None
    assert supabase.updates == []


def test_explicit_refresh_calls_provider_and_persists_result(monkeypatch):
    supabase = FakeSupabase({"id": "settings-1", "latest_insight_text": None})
    provider_calls = []
    monkeypatch.setattr(insights_routes, "get_supabase_client", lambda: supabase)
    monkeypatch.setattr(insights_routes, "_calculate_financials", lambda *_args: _financials())

    def fake_provider(payload, *, explicit_user_action=False):
        provider_calls.append((payload, explicit_user_action))
        return {"status": "success", "insight": "Novo insight"}

    monkeypatch.setattr(insights_routes, "generate_financial_insights", fake_provider)
    monkeypatch.setattr(insights_routes, "financial_today", lambda: date(2026, 8, 15))

    result = asyncio.run(insights_routes.refresh_insights())

    assert provider_calls == [(_financials(), True)]
    assert result["data"]["insight"] == "Novo insight"
    assert supabase.updates == [
        {"latest_insight_text": "Novo insight", "latest_insight_date": "2026-08-15"}
    ]


def test_canonical_runtime_uses_privacy_minimized_insights_handlers():
    app = runtime.create_app()
    routes = {(tuple(route.methods or []), route.path): route.endpoint for route in app.routes}

    assert routes[(('GET',), '/insights')] is insights_routes.get_insights
    assert routes[(('POST',), '/insights/refresh')] is insights_routes.refresh_insights


def test_mobile_discloses_external_ai_aggregate_categories_before_refresh():
    repo_root = Path(__file__).resolve().parents[1]
    wrapper = (repo_root / 'mobile/src/screens/InsightsPrivacyScreen.tsx').read_text(encoding='utf-8')
    navigator = (repo_root / 'mobile/src/navigation/AppNavigator.tsx').read_text(encoding='utf-8')

    assert 'saldo atual' in wrapper
    assert 'sobra estimada' in wrapper
    assert 'meta da reserva' in wrapper
    assert 'Faturas, recibos e transações individuais não fazem parte' in wrapper
    assert 'InsightsPrivacyScreen' in navigator
    assert 'component={InsightsPrivacyScreen}' in navigator
