import asyncio
from datetime import date
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from api_models import SettingsUpdateRequest
from settings_write_routes import update_settings


def _request(initial_balance_date: str) -> SettingsUpdateRequest:
    return SettingsUpdateRequest(
        initial_balance="125.50",
        initial_balance_date=initial_balance_date,
        emergency_fund_goal="500.00",
    )


@patch("settings_write_routes.financial_today", return_value=date(2026, 8, 15))
@patch("settings_write_routes.get_request_user_id", return_value="user-a")
@patch("settings_write_routes.get_supabase_client")
def test_settings_reject_future_initial_balance_date_before_transport(
    mock_supabase,
    _mock_user,
    _mock_today,
):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(update_settings(_request("2026-08-16")))

    assert exc_info.value.status_code == 422
    assert "futuro" in str(exc_info.value.detail).lower()
    mock_supabase.assert_not_called()


@patch("settings_write_routes.financial_today", return_value=date(2026, 8, 15))
@patch("settings_write_routes.get_request_user_id", return_value="user-a")
@patch("settings_write_routes.get_supabase_client")
def test_settings_accept_financial_today_and_use_scoped_rpc(mock_supabase, _mock_user, _mock_today):
    mock_supabase.return_value.rpc.return_value.execute.return_value = SimpleNamespace(
        data={
            "status": "success",
            "data": {
                "owner_id": "user-a",
                "initial_balance": "125.50",
                "initial_balance_date": "2026-08-15",
                "emergency_fund_goal": "500.00",
            },
        }
    )

    result = asyncio.run(update_settings(_request("2026-08-15")))

    mock_supabase.return_value.rpc.assert_called_once_with(
        "finance_replace_settings",
        {
            "p_initial_balance": "125.50",
            "p_initial_balance_date": "2026-08-15",
            "p_emergency_fund_goal": "500.00",
        },
    )
    assert result["data"]["initial_balance_date"] == "2026-08-15"


@patch("settings_write_routes.financial_today", return_value=date(2026, 8, 15))
@patch("settings_write_routes.get_request_user_id", return_value="user-a")
@patch("settings_write_routes.get_supabase_client")
def test_settings_accept_historical_initial_balance_date(mock_supabase, _mock_user, _mock_today):
    mock_supabase.return_value.rpc.return_value.execute.return_value = SimpleNamespace(
        data={
            "status": "success",
            "data": {
                "owner_id": "user-a",
                "initial_balance": "125.50",
                "initial_balance_date": "2025-12-31",
                "emergency_fund_goal": "500.00",
            },
        }
    )

    result = asyncio.run(update_settings(_request("2025-12-31")))

    assert result["data"]["initial_balance_date"] == "2025-12-31"
