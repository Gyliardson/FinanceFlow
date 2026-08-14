import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from secure_routes import pay_bill_without_receipt


def _client_for_bill(*, bill, update_data):
    client = MagicMock()
    table = client.table.return_value
    table.select.return_value.eq.return_value.limit.return_value.execute.return_value = SimpleNamespace(
        data=[] if bill is None else [bill]
    )
    table.update.return_value.eq.return_value.neq.return_value.execute.return_value = SimpleNamespace(
        data=update_data
    )
    return client, table


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_uses_compare_and_set(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={"id": "bill-1", "status": "pending", "description": "Synthetic bill"},
        update_data=[{"id": "bill-1", "status": "paid"}],
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result["status"] == "success"
    table.update.return_value.eq.assert_called_once_with("id", "bill-1")
    table.update.return_value.eq.return_value.neq.assert_called_once_with("status", "paid")


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_race_is_idempotent_not_second_success(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={"id": "bill-1", "status": "pending", "description": "Synthetic bill"},
        update_data=[],
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result == {"status": "info", "message": "Esta fatura já foi marcada como paga."}
    table.update.return_value.eq.return_value.neq.assert_called_once_with("status", "paid")


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_already_paid_does_not_write(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={"id": "bill-1", "status": "paid", "description": "Synthetic bill"},
        update_data=[],
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result["status"] == "info"
    table.update.assert_not_called()


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_cross_owner_or_missing_is_404_without_write(mock_client, _mock_user):
    client, table = _client_for_bill(bill=None, update_data=[])
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("other-user-or-missing"))

    assert exc_info.value.status_code == 404
    table.update.assert_not_called()


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_provider_failure_is_sanitized(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={"id": "bill-1", "status": "pending", "description": "Synthetic bill"},
        update_data=[],
    )
    table.update.return_value.eq.return_value.neq.return_value.execute.side_effect = RuntimeError(
        "database credential / provider detail"
    )
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("bill-1"))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "Não foi possível confirmar o pagamento."
    assert "credential" not in exc_info.value.detail
