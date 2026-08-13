import os
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

os.environ.setdefault("API_SECRET_KEY", "ci-test-key")

from main import _calculate_financials, app

AUTH_HEADERS = {"X-API-KEY": os.environ["API_SECRET_KEY"]}
client = TestClient(app)


def test_read_main():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Bem-vindo à API do FinanceFlow"}


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "message": "A API está operante e saudável."}


def test_protected_route_rejects_missing_api_key():
    response = client.get("/bills")
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized – invalid or missing API key."}


def test_protected_route_rejects_invalid_api_key():
    response = client.get("/bills", headers={"X-API-KEY": "wrong-key"})
    assert response.status_code == 401
    assert response.json() == {"detail": "Unauthorized – invalid or missing API key."}


@patch("main.get_supabase_client")
def test_add_bill_record_persists_canonical_money(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [{"id": "abc", "amount": "250.00"}]
    payload = {"description": "Conta X", "amount": 250.0, "status": "pending", "due_date": "2026-05-10"}

    response = client.post("/add-bill", json=payload, headers=AUTH_HEADERS)

    assert response.status_code == 200
    persisted = table.insert.call_args.args[0]
    assert persisted["amount"] == "250.00"
    assert response.json()["data"][0]["amount"] == "250.00"


@patch("main.get_supabase_client")
def test_add_bill_rounds_once_before_persistence(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [{"id": "abc", "amount": "1.01"}]

    response = client.post(
        "/add-bill",
        json={"description": "Cent boundary", "amount": "1.005", "status": "pending", "due_date": "2026-05-10"},
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    assert table.insert.call_args.args[0]["amount"] == "1.01"


@patch("main.get_supabase_client")
def test_income_persists_canonical_money(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [{"id": "income-1", "amount": "0.30"}]

    response = client.post(
        "/incomes",
        json={"title": "Synthetic income", "amount": "0.300", "date": "2026-08-01"},
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    assert table.insert.call_args.args[0]["amount"] == "0.30"


@patch("main.get_supabase_client")
def test_settings_persist_canonical_money(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.select.return_value.limit.return_value.execute.return_value.data = [{"id": "settings-1"}]
    table.update.return_value.eq.return_value.execute.return_value.data = [
        {"id": "settings-1", "initial_balance": "-10.01", "emergency_fund_goal": "1000.00"}
    ]

    response = client.post(
        "/settings",
        json={
            "initial_balance": "-10.005",
            "initial_balance_date": "2026-08-01",
            "emergency_fund_goal": "1000",
        },
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    persisted = table.update.call_args.args[0]
    assert persisted["initial_balance"] == "-10.01"
    assert persisted["emergency_fund_goal"] == "1000.00"


@patch("main.get_supabase_client")
def test_reserve_update_is_exact_and_canonical(mock_supabase):
    table = mock_supabase.return_value.table.return_value
    table.select.return_value.limit.return_value.execute.return_value.data = [
        {"id": "settings-1", "emergency_fund_balance": "10.00"}
    ]
    table.update.return_value.eq.return_value.execute.return_value.data = [
        {"id": "settings-1", "emergency_fund_balance": "10.01"}
    ]

    response = client.post(
        "/insights/reserve",
        json={"amount": "0.005"},
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    assert table.update.call_args.args[0]["emergency_fund_balance"] == "10.01"


@patch("main.get_supabase_client")
def test_get_bills_is_hermetic(mock_supabase):
    mock_execute = mock_supabase.return_value.table.return_value.select.return_value.order.return_value.execute
    mock_execute.return_value.data = [{"id": "bill-1", "amount": "99.90"}]
    response = client.get("/bills", headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["data"] == mock_execute.return_value.data


@patch("main.extract_invoice_data")
def test_upload_receipt(mock_extract):
    mock_extract.return_value = {"status": "success", "extracted_data": {"amount": 150.0, "due_date": "2023-12-01", "barcode": "123456789"}}
    files = {"file": ("receipt.png", b"fake image content", "image/png")}
    response = client.post("/upload-receipt", files=files, headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["ocr_result"]["amount"] == 150.0


@patch("main.get_supabase_client")
def test_validate_bill(mock_supabase):
    mock_execute = mock_supabase.return_value.table.return_value.select.return_value.eq.return_value.execute
    mock_execute.return_value.data = [{"id": "123-abc", "amount": "100.00", "due_date": "2023-10-10", "barcode": "111222333"}]
    approved = {"bill_id": "123-abc", "ocr_amount": "102.00", "ocr_due_date": "2023-10-10", "ocr_barcode": "111222333"}
    response = client.post("/validate-bill", json=approved, headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["is_approved"] is True
    rejected = {"bill_id": "123-abc", "ocr_amount": "500.00", "ocr_due_date": "2020-01-01", "ocr_barcode": "0000"}
    response = client.post("/validate-bill", json=rejected, headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["is_approved"] is False


@patch("main.get_supabase_client")
def test_validate_bill_amount_boundary_is_exact(mock_supabase):
    mock_execute = mock_supabase.return_value.table.return_value.select.return_value.eq.return_value.execute
    mock_execute.return_value.data = [{"id": "123-abc", "amount": "100.00", "due_date": "2026-08-10", "barcode": None}]

    accepted = client.post(
        "/validate-bill",
        json={"bill_id": "123-abc", "ocr_amount": "105.00"},
        headers=AUTH_HEADERS,
    )
    rejected = client.post(
        "/validate-bill",
        json={"bill_id": "123-abc", "ocr_amount": "105.01"},
        headers=AUTH_HEADERS,
    )

    assert accepted.status_code == 200
    assert accepted.json()["details"]["amount_match"] is True
    assert rejected.status_code == 200
    assert rejected.json()["details"]["amount_match"] is False


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
