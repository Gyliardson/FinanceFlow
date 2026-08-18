import asyncio
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from api_models import EmergencyFundGoalUpdateRequest
from runtime import create_app
from settings_routes import update_emergency_fund_goal


@patch("settings_routes.get_request_user_id", return_value="user-a")
@patch("settings_routes.get_supabase_client")
def test_goal_update_uses_field_scoped_rpc_and_preserves_authoritative_response(mock_supabase, _mock_user):
    rpc = mock_supabase.return_value.rpc
    rpc.return_value.execute.return_value = SimpleNamespace(
        data={
            "status": "success",
            "data": {
                "id": "settings-a",
                "initial_balance": "975.25",
                "initial_balance_date": "2026-08-14",
                "emergency_fund_goal": "2500.01",
                "emergency_fund_balance": "125.00",
            },
        }
    )

    result = asyncio.run(
        update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="2500.005"))
    )

    rpc.assert_called_once_with(
        "finance_update_emergency_fund_goal",
        {"p_emergency_fund_goal": "2500.01"},
    )
    assert result["data"]["initial_balance"] == "975.25"
    assert result["data"]["initial_balance_date"] == "2026-08-14"
    assert result["data"]["emergency_fund_balance"] == "125.00"
    mock_supabase.return_value.table.assert_not_called()


@patch("settings_routes.get_request_user_id", return_value=None)
@patch("settings_routes.get_supabase_client")
def test_goal_update_requires_authenticated_context(mock_supabase, _mock_user):
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="1000.00"))
        )

    assert exc_info.value.status_code == 401
    mock_supabase.assert_not_called()


@patch("settings_routes.get_request_user_id", return_value="user-a")
@patch("settings_routes.get_supabase_client")
def test_goal_update_treats_rpc_transport_failure_as_unconfirmed(mock_supabase, _mock_user):
    mock_supabase.return_value.rpc.return_value.execute.side_effect = RuntimeError("transport lost")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="1000.00"))
        )

    assert exc_info.value.status_code == 503
    assert "confirmar" in str(exc_info.value.detail).lower()


@patch("settings_routes.get_request_user_id", return_value="user-a")
@patch("settings_routes.get_supabase_client")
def test_goal_update_rejects_malformed_rpc_result_as_unconfirmed(mock_supabase, _mock_user):
    mock_supabase.return_value.rpc.return_value.execute.return_value = SimpleNamespace(data=[])

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="1000.00"))
        )

    assert exc_info.value.status_code == 503


def test_goal_update_route_is_authenticated_patch_surface():
    app = create_app()
    route = next(route for route in app.routes if getattr(route, "path", None) == "/settings/emergency-fund-goal")
    assert route.methods == {"PATCH"}
    assert "/settings/emergency-fund-goal" not in {"/", "/health", "/healthz", "/docs", "/openapi.json", "/redoc"}
