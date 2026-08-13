import os
from unittest.mock import patch

from fastapi.testclient import TestClient

os.environ.setdefault("API_SECRET_KEY", "ci-test-key")

from main import app

AUTH_HEADERS = {"X-API-KEY": os.environ["API_SECRET_KEY"]}
client = TestClient(app)


@patch("main.get_supabase_client")
def test_add_bill_rejects_positive_value_that_rounds_to_zero(mock_supabase):
    response = client.post(
        "/add-bill",
        json={
            "description": "Sub-cent synthetic bill",
            "amount": "0.004",
            "status": "pending",
            "due_date": "2026-08-20",
        },
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 422
    mock_supabase.assert_not_called()


@patch("main.get_supabase_client")
def test_reserve_rejects_subcent_value_before_database_access(mock_supabase):
    response = client.post(
        "/insights/reserve",
        json={"amount": "0.004"},
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 422
    mock_supabase.assert_not_called()


@patch("main.generate_recurring_instances")
@patch("main.get_supabase_client")
def test_recurring_bill_persists_canonical_amount(mock_supabase, mock_generate):
    table = mock_supabase.return_value.table.return_value
    table.insert.return_value.execute.return_value.data = [
        {"id": "template-1", "amount": "10.01"}
    ]

    response = client.post(
        "/recurring-bills",
        json={"title": "Synthetic recurring", "amount": "10.005", "recurring_day": 31},
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 200
    persisted = table.insert.call_args.args[0]
    assert persisted["amount"] == "10.01"
    assert persisted["recurring_day"] == 31
    mock_generate.assert_called_once()


@patch("main.get_supabase_client")
def test_recurring_bill_rejects_invalid_day_before_database_access(mock_supabase):
    response = client.post(
        "/recurring-bills",
        json={"title": "Invalid recurring", "amount": "10.00", "recurring_day": 32},
        headers=AUTH_HEADERS,
    )

    assert response.status_code == 422
    mock_supabase.assert_not_called()
