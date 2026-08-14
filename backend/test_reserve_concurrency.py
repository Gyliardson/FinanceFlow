import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import HTTPException

from api_models import ReserveAddRequest
from secure_routes import RESERVE_UPDATE_ATTEMPTS, add_to_reserve_atomic


def _reserve_client(read_balances, update_results):
    client = MagicMock()
    table = client.table.return_value
    table.select.return_value.limit.return_value.execute.side_effect = [
        SimpleNamespace(data=[{"id": "settings-1", "emergency_fund_balance": value}])
        for value in read_balances
    ]
    table.update.return_value.eq.return_value.eq.return_value.execute.side_effect = [
        SimpleNamespace(data=result) for result in update_results
    ]
    return client, table


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_reserve_update_compares_exact_previous_balance(mock_client, _mock_user):
    client, table = _reserve_client(["10.00"], [[{"id": "settings-1", "emergency_fund_balance": "10.01"}]])
    mock_client.return_value = client

    result = asyncio.run(add_to_reserve_atomic(ReserveAddRequest(amount="0.005")))

    assert result["data"]["emergency_fund_balance"] == "10.01"
    table.update.assert_called_once_with({"emergency_fund_balance": "10.01"})
    first_eq = table.update.return_value.eq
    first_eq.assert_called_once_with("id", "settings-1")
    first_eq.return_value.eq.assert_called_once_with("emergency_fund_balance", "10.00")


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_reserve_update_retries_after_concurrent_change(mock_client, _mock_user):
    client, table = _reserve_client(
        ["10.00", "20.00"],
        [[], [{"id": "settings-1", "emergency_fund_balance": "20.01"}]],
    )
    mock_client.return_value = client

    result = asyncio.run(add_to_reserve_atomic(ReserveAddRequest(amount="0.01")))

    assert result["data"]["emergency_fund_balance"] == "20.01"
    assert table.select.return_value.limit.return_value.execute.call_count == 2
    assert table.update.return_value.eq.return_value.eq.return_value.execute.call_count == 2


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_reserve_update_stops_after_bounded_contention(mock_client, _mock_user):
    client, table = _reserve_client(
        ["10.00"] * RESERVE_UPDATE_ATTEMPTS,
        [[] for _ in range(RESERVE_UPDATE_ATTEMPTS)],
    )
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(add_to_reserve_atomic(ReserveAddRequest(amount="1.00")))

    assert exc_info.value.status_code == 409
    assert table.update.return_value.eq.return_value.eq.return_value.execute.call_count == RESERVE_UPDATE_ATTEMPTS


@patch("secure_routes.get_request_user_id", return_value="11111111-1111-1111-1111-111111111111")
@patch("secure_routes.get_supabase_client")
def test_reserve_missing_settings_fails_without_write(mock_client, _mock_user):
    client = MagicMock()
    table = client.table.return_value
    table.select.return_value.limit.return_value.execute.return_value = SimpleNamespace(data=[])
    mock_client.return_value = client

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(add_to_reserve_atomic(ReserveAddRequest(amount="1.00")))

    assert exc_info.value.status_code == 400
    table.update.assert_not_called()
