import asyncio
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from api_handlers import _calculate_financials, validate_bill
from api_models import BillValidationRequest
from auth_middleware import SupabaseAuthMiddleware
from main import app


BACKEND_DIR = Path(__file__).resolve().parent


def _middleware_classes():
    return [getattr(item, "cls", None) for item in app.user_middleware]


def test_legacy_import_resolves_to_canonical_secure_application():
    classes = _middleware_classes()
    assert classes.count(SupabaseAuthMiddleware) == 1
    assert classes.count(CORSMiddleware) == 1

    client = TestClient(app)
    assert client.get("/").json() == {"message": "Bem-vindo à API do FinanceFlow"}
    protected = client.get("/bills")
    assert protected.status_code == 401
    assert protected.headers["WWW-Authenticate"] == "Bearer"


def test_legacy_module_has_no_independent_shared_secret_or_wildcard_surface():
    source = (BACKEND_DIR / "main.py").read_text(encoding="utf-8")
    assert "APIKeyMiddleware" not in source
    assert "API_SECRET_KEY" not in source
    assert "X-API-KEY" not in source
    assert 'allow_origins=["*"]' not in source
    assert "from runtime import create_app" in source


@patch("api_handlers.get_supabase_client")
def test_validate_bill_amount_boundary_is_exact(mock_supabase):
    mock_execute = (
        mock_supabase.return_value.table.return_value.select.return_value.eq.return_value.execute
    )
    mock_execute.return_value.data = [
        {"id": "123-abc", "amount": "100.00", "due_date": "2026-08-10", "barcode": None}
    ]

    accepted = asyncio.run(
        validate_bill(BillValidationRequest(bill_id="123-abc", ocr_amount="105.00"))
    )
    rejected = asyncio.run(
        validate_bill(BillValidationRequest(bill_id="123-abc", ocr_amount="105.01"))
    )

    assert accepted["details"]["amount_match"] is True
    assert rejected["details"]["amount_match"] is False


class _Query:
    def __init__(self, data):
        self.data = data

    def select(self, *_args):
        return self

    def gte(self, *_args):
        return self

    def eq(self, *_args):
        return self

    def in_(self, *_args):
        return self

    def lte(self, *_args):
        return self

    def execute(self):
        return SimpleNamespace(data=self.data)


class _BillsQuery(_Query):
    def __init__(self, paid, pending):
        super().__init__([])
        self.paid = paid
        self.pending = pending

    def eq(self, field, value):
        if field == "status" and value == "paid":
            self.data = self.paid
        return self

    def in_(self, field, values):
        if field == "status" and set(values) == {"pending", "overdue"}:
            self.data = self.pending
        return self


class _FinancialSupabase:
    def table(self, name):
        if name == "finance_incomes":
            return _Query([{"amount": "0.10"}, {"amount": "0.20"}, {"amount": "99.70"}])
        if name == "finance_bills":
            return _BillsQuery(
                paid=[{"amount": "25.01"}, {"amount": "0.09"}],
                pending=[{"amount": "10.00"}, {"amount": "0.01"}],
            )
        raise AssertionError(f"Unexpected table {name}")


def test_calculate_financials_keeps_authoritative_values_decimal():
    result = _calculate_financials(
        _FinancialSupabase(),
        {
            "initial_balance": "100.00",
            "initial_balance_date": "2026-01-01",
            "emergency_fund_goal": "1000.00",
            "emergency_fund_balance": "5.00",
        },
    )

    assert result == {
        "current_balance": Decimal("169.90"),
        "estimated_surplus": Decimal("159.89"),
        "emergency_fund_goal": Decimal("1000.00"),
        "emergency_fund_balance": Decimal("5.00"),
    }
