import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from secure_routes import pay_bill_without_receipt


def _client_for_bill(*, bill, rpc_data=None):
    client = MagicMock()
    table = client.table.return_value
    table.select.return_value.eq.return_value.limit.return_value.execute.return_value = SimpleNamespace(
        data=[] if bill is None else [bill]
    )
    client.rpc.return_value.execute.return_value = SimpleNamespace(data=rpc_data)
    return client, table


def _success_payload(*, payment_date="2026-08-15", status="success"):
    return {
        "status": status,
        "data": {
            "id": "bill-1",
            "status": "paid",
            "is_recurring": False,
            "payment_date": payment_date,
        },
    }


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_uses_sanctioned_rpc(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={
            "id": "bill-1",
            "status": "pending",
            "description": "Synthetic bill",
            "is_recurring": False,
        },
        rpc_data=_success_payload(),
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result == {
        "status": "success",
        "message": "Fatura 'Synthetic bill' paga com sucesso!",
        "payment_date": "2026-08-15",
    }
    client.rpc.assert_called_once_with(
        "finance_mark_bill_paid",
        {"p_bill_id": "bill-1", "p_receipt_path": None},
    )
    table.update.assert_not_called()


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_rpc_already_paid_converges(mock_client, _mock_user):
    client, _table = _client_for_bill(
        bill={
            "id": "bill-1",
            "status": "pending",
            "description": "Synthetic bill",
            "is_recurring": False,
        },
        rpc_data=_success_payload(status="info"),
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result == {
        "status": "info",
        "message": "Esta fatura já foi marcada como paga.",
        "payment_date": "2026-08-15",
    }


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_malformed_rpc_result_converges_only_after_authoritative_paid_reread(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    paid = {"id": "bill-1", "status": "paid", "is_recurring": False, "payment_date": "2026-08-15"}
    client, table = _client_for_bill(bill=pending, rpc_data=[])
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        SimpleNamespace(data=[paid]),
    ]
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result == {
        "status": "info",
        "message": "Esta fatura já foi marcada como paga.",
        "payment_date": "2026-08-15",
    }


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_malformed_rpc_result_still_pending_is_explicitly_unconfirmed(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    client, table = _client_for_bill(bill=pending, rpc_data=[])
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        SimpleNamespace(data=[pending]),
    ]
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
    paid = {"id": "bill-1", "status": "paid", "is_recurring": False, "payment_date": "2026-08-15"}
    client, table = _client_for_bill(bill=pending)
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        SimpleNamespace(data=[paid]),
    ]
    client.rpc.return_value.execute.side_effect = RuntimeError("response lost after commit")
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result["status"] == "info"
    assert result["payment_date"] == "2026-08-15"


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_provider_error_pending_state_is_not_reported_as_rollback(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    client, table = _client_for_bill(bill=pending)
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        SimpleNamespace(data=[pending]),
    ]
    client.rpc.return_value.execute.side_effect = RuntimeError("database credential / provider detail")
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("bill-1"))

    assert exc_info.value.status_code == 409
    assert "credential" not in str(exc_info.value.detail)


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_reconciliation_failure_stays_ambiguous_and_sanitized(mock_client, _mock_user):
    pending = {
        "id": "bill-1",
        "status": "pending",
        "description": "Synthetic bill",
        "is_recurring": False,
    }
    client, table = _client_for_bill(bill=pending)
    table.select.return_value.eq.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[pending]),
        RuntimeError("provider token / replica detail"),
    ]
    client.rpc.return_value.execute.side_effect = RuntimeError("response lost")
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("bill-1"))

    assert exc_info.value.status_code == 503
    assert exc_info.value.detail == "Não foi possível confirmar o resultado do pagamento."
    assert "token" not in exc_info.value.detail


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_rejects_recurring_template_before_rpc(mock_client, _mock_user):
    client, table = _client_for_bill(
        bill={
            "id": "template-1",
            "status": "pending",
            "description": "Synthetic recurring template",
            "is_recurring": True,
        }
    )
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("template-1"))

    assert exc_info.value.status_code == 409
    client.rpc.assert_not_called()
    table.update.assert_not_called()


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_already_paid_does_not_rpc(mock_client, _mock_user):
    client, _table = _client_for_bill(
        bill={
            "id": "bill-1",
            "status": "paid",
            "description": "Synthetic bill",
            "is_recurring": False,
            "payment_date": "2026-08-14",
        }
    )
    mock_client.return_value = client

    result = asyncio.run(pay_bill_without_receipt("bill-1"))

    assert result["status"] == "info"
    assert result["payment_date"] == "2026-08-14"
    client.rpc.assert_not_called()


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_receiptless_payment_cross_owner_or_missing_is_404_without_rpc(mock_client, _mock_user):
    client, _table = _client_for_bill(bill=None)
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(pay_bill_without_receipt("other-user-or-missing"))

    assert exc_info.value.status_code == 404
    client.rpc.assert_not_called()
