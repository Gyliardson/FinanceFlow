import os
from unittest.mock import patch

from fastapi.testclient import TestClient

os.environ.setdefault("API_SECRET_KEY", "ci-test-key")

from main import app

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
def test_add_bill_record(mock_supabase):
    mock_execute = mock_supabase.return_value.table.return_value.insert.return_value.execute
    mock_execute.return_value.data = [{"id": "abc", "amount": 250.0}]
    payload = {"description": "Conta X", "amount": 250.0, "status": "pending", "due_date": "2026-05-10"}
    response = client.post("/add-bill", json=payload, headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["data"][0]["amount"] == 250.0


@patch("main.get_supabase_client")
def test_get_bills_is_hermetic(mock_supabase):
    mock_execute = mock_supabase.return_value.table.return_value.select.return_value.order.return_value.execute
    mock_execute.return_value.data = [{"id": "bill-1", "amount": 99.9}]
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
    mock_execute.return_value.data = [{"id": "123-abc", "amount": 100.0, "due_date": "2023-10-10", "barcode": "111222333"}]
    approved = {"bill_id": "123-abc", "ocr_amount": 102.0, "ocr_due_date": "2023-10-10", "ocr_barcode": "111222333"}
    response = client.post("/validate-bill", json=approved, headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["is_approved"] is True
    rejected = {"bill_id": "123-abc", "ocr_amount": 500.0, "ocr_due_date": "2020-01-01", "ocr_barcode": "0000"}
    response = client.post("/validate-bill", json=rejected, headers=AUTH_HEADERS)
    assert response.status_code == 200
    assert response.json()["is_approved"] is False
