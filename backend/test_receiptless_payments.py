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
    update_query = table.update.return_value.eq.return_value.eq.return_value.neq.return_value
    update_query.execute.return_value = SimpleNamespace(data=update_data)
    return client, table


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_uses_compare_and_set(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={
            "id": "bill-1",
            "status": "pending",
            "description": "Synthetic bill",
            "is_recurring": False,
        },
        update_data=[{"id": "bill-1", "status": "paid"}],
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result["status"] == "success"
    table.update.return_value.eq.assert_called_once_with("id", "bill-1")
    table.update.return_value.eq.return_value.eq.assert_called_once_with("is_recurring", False)
    table.update.return_value.eq.return_value.eq.return_value.neq.assert_called_once_with(
        "status", "paid"
    )


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_race_converges_only_after_authoritative_paid_reread(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    paid = {"id": "bill-1", "status": "paid", "is_recurring": False}
    client, table = _client_for_bill(bill=pending, update_data=[])
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        SimpleNamespace(data=[paid]),
    ]
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result == {"status": "info", "message": "Esta fatura já foi marcada como paga."}
    table.update.return_value.eq.return_value.eq.return_value.neq.assert_called_once_with(
        "status", "paid"
    )


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_zero_row_still_pending_is_explicitly_unconfirmed(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    client, table = _client_for_bill(bill=pending, update_data=[])
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("bill-1"))

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == (
        "O resultado do pagamento não foi confirmado. Atualize os dados antes de tentar novamente."
    )


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_commit_then_response_loss_converges_to_paid(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    paid = {"id": "bill-1", "status": "paid", "is_recurring": False}
    client, table = _client_for_bill(bill=pending, update_data=[])
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        SimpleNamespace(data=[paid]),
    ]
    table.update.return_value.eq.return_value.eq.return_value.neq.return_value.execute.side_effect = RuntimeError(
        "response lost after commit"
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result == {"status": "info", "message": "Esta fatura já foi marcada como paga."}


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_provider_error_pending_state_is_not_reported_as_rollback(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    client, table = _client_for_bill(bill=pending, update_data=[])
    table.update.return_value.eq.return_value.eq.return_value.neq.return_value.execute.side_effect = RuntimeError(
        "database credential / provider detail"
    )
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("bill-1"))

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == (
        "O resultado do pagamento não foi confirmado. Atualize os dados antes de tentar novamente."
    )
    assert "credential" not in exc_info.value.detail


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_reconciliation_failure_stays_ambiguous_and_sanitized(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    client, table = _client_for_bill(bill=pending, update_data=[])
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        RuntimeError("provider token / replica detail"),
    ]
    table.update.return_value.eq.return_value.eq.return_value.neq.return_value.execute.side_effect = RuntimeError(
        "response lost"
    )
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("bill-1"))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "Não foi possível confirmar o resultado do pagamento."
    assert "token" not in exc_info.value.detail


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_rejects_recurring_template_before_write(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={
            "id": "template-1",
            "status": "pending",
            "description": "Synthetic recurring template",
            "is_recurring": True,
        },
        update_data=[],
    )
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("template-1"))

    assert exc_info.value.status_code == 409
    assert exc_info.value.detail == "Modelos recorrentes não podem ser pagos diretamente."
    table.update.assert_not_called()


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_already_paid_does_not_write(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={
            "id": "bill-1",
            "status": "paid",
            "description": "Synthetic bill",
            "is_recurring": False,
        },
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
