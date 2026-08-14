from datetime import date

import pytest
from pydantic import ValidationError

from api_models import BillCreateRequest, BillValidationRequest, IncomeCreateRequest, SettingsUpdateRequest


def test_bill_accepts_leap_day_and_preserves_canonical_iso_date():
    request = BillCreateRequest(
        description="Leap day bill",
        amount="10.00",
        due_date="2028-02-29",
    )
    assert request.due_date == "2028-02-29"


@pytest.mark.parametrize(
    "invalid_date",
    [
        "2027-02-29",
        "2026-04-31",
        "2026-13-01",
        "2026-00-10",
        "2026-08-14T12:00:00Z",
        "14/08/2026",
        "",
    ],
)
def test_bill_rejects_invalid_or_noncanonical_date(invalid_date):
    with pytest.raises(ValidationError):
        BillCreateRequest(
            description="Invalid date bill",
            amount="10.00",
            due_date=invalid_date,
        )


def test_income_and_settings_share_same_date_only_contract():
    income = IncomeCreateRequest(title="Synthetic", amount="100.00", date=date(2026, 8, 31))
    settings = SettingsUpdateRequest(
        initial_balance="0.00",
        initial_balance_date=date(2026, 1, 1),
        emergency_fund_goal="100.00",
    )

    assert income.date == "2026-08-31"
    assert settings.initial_balance_date == "2026-01-01"


def test_ocr_validation_rejects_impossible_calendar_date():
    with pytest.raises(ValidationError):
        BillValidationRequest(bill_id="bill-1", ocr_due_date="2026-02-30")
