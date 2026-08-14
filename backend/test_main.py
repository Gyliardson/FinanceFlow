import asyncio
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient

from api_handlers import _calculate_financials, add_bill, add_income, add_to_reserve, validate_bill
from api_models import BillCreateRequest, BillValidationRequest, IncomeCreateRequest, ReserveAddRequest
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
def test_add_bill_record_persists_canonical_money(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [{"id": "abc", "amount": "250.00"}]

    result = asyncio.run(
        add_bill(
            BillCreateRequest(
                description="Conta X",
                amount="250.0",
                status="pending",
                due_date="2026-05-10",
            )
        )
    )

    persisted = table.insert.call_args.args[0]
    assert persisted["amount"] == "250.00"
    assert result["data"][0]["amount"] == "250.00"


@patch("api_handlers.get_supabase_client")
def test_add_bill_rounds_once_before_persistence(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [{"id": "abc", "amount": "1.01"}]

    asyncio.run(
        add_bill(
            BillCreateRequest(
                description="Cent boundary",
                amount="1.005",
                status="pending",
                due_date="2026-05-10",
            )
        )
    )

    assert table.insert.call_args.args[0]["amount"] == "1.01"


@patch("api_handlers.get_supabase_client")
def test_income_persists_canonical_money(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [{"id": "income-1", "amount": "0.30"}]

    result = asyncio.run(
        add_income(IncomeCreateRequest(title="Synthetic income", amount="0.300", date="2026-08-01"))
    )

    assert table.insert.call_args.args[0]["amount"] == "0.30"
    assert result["data"][0]["amount"] == "0.30"


@patch("api_handlers.get_supabase_client")
def test_reserve_update_is_exact_and_canonical(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.select.return_value.limit.return_value.execute.return_value.data = [
        {"id": "settings-1", "emergency_fund_balance": "10.00"}
    ]
    table.update.return_value.eq.return_value.execute.return_value.data = [
        {"id": "settings-1", "emergency_fund_balance": "10.01"}
    ]

    result = asyncio.run(add_to_reserve(ReserveAddRequest(amount="0.005")))

    assert table.update.call_args.args[0]["emergency_fund_balance"] == "10.01"
    assert result["status"] == "success"


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
