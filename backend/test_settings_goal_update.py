import asyncio
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from api_models import EmergencyFundGoalUpdateRequest
from runtime import create_app
from settings_routes import update_emergency_fund_goal


@patch("settings_routes.get_request_user_id", return_value="user-a")
@patch("settings_routes.get_supabase_client")
def test_goal_update_writes_only_goal_and_preserves_other_settings(mock_supabase, _mock_user):
    table = mock_supabase.return_value.table.return_value
    table.select.return_value.limit.return_value.execute.return_value.data = [{"id": "settings-a"}]
    table.update.return_value.eq.return_value.execute.return_value.data = [
        {
            "id": "settings-a",
            "initial_balance": "975.25",
            "initial_balance_date": "2026-08-14",
            "emergency_fund_goal": "2500.01",
            "emergency_fund_balance": "125.00",
        }
    ]

    result = asyncio.run(
        update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="2500.005"))
    )

    table.update.assert_called_once_with({"emergency_fund_goal": "2500.01"})
    table.update.return_value.eq.assert_called_once_with("id", "settings-a")
    assert result["data"]["initial_balance"] == "975.25"
    assert result["data"]["initial_balance_date"] == "2026-08-14"
    assert result["data"]["emergency_fund_balance"] == "125.00"


@patch("settings_routes.get_request_user_id", return_value="user-a")
@patch("settings_routes.get_supabase_client")
def test_goal_update_requires_existing_owner_scoped_settings(mock_supabase, _mock_user):
    table = mock_supabase.return_value.table.return_value
    table.select.return_value.limit.return_value.execute.return_value.data = []

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="1000.00"))
        )

    assert exc_info.value.status_code == 400
    table.update.assert_not_called()


@patch("settings_routes.get_request_user_id", return_value="user-a")
@patch("settings_routes.get_supabase_client")
def test_goal_update_treats_persistence_failure_as_unconfirmed(mock_supabase, _mock_user):
    table = mock_supabase.return_value.table.return_value
    table.select.return_value.limit.return_value.execute.return_value.data = [{"id": "settings-a"}]
    table.update.return_value.eq.return_value.execute.side_effect = RuntimeError("transport lost")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            update_emergency_fund_goal(EmergencyFundGoalUpdateRequest(emergency_fund_goal="1000.00"))
        )

    assert exc_info.value.status_code == 503
    assert "confirmar" in str(exc_info.value.detail).lower()


def test_goal_update_route_is_authenticated_patch_surface():
    app = create_app()
    route = next(route for route in app.routes if getattr(route, "path", None) == "/settings/emergency-fund-goal")
    assert route.methods == {"PATCH"}
    assert "/settings/emergency-fund-goal" not in {"/", "/health", "/healthz", "/docs", "/openapi.json", "/redoc"}
