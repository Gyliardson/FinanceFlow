from decimal import Decimal

import pytest
from pydantic import ValidationError

from api_models import BillCreateRequest, RecurringBillCreateRequest, ReserveAddRequest


def test_add_bill_rejects_positive_value_that_rounds_to_zero():
    with pytest.raises(ValidationError):
        BillCreateRequest(
            description="Sub-cent synthetic bill",
            amount="0.004",
            status="pending",
            due_date="2026-08-20",
        )


def test_reserve_rejects_subcent_value_before_handler_execution():
    with pytest.raises(ValidationError):
        ReserveAddRequest(amount="0.004")


def test_recurring_bill_canonicalizes_amount_and_accepts_month_end_day():
    request = RecurringBillCreateRequest(
        title="Synthetic recurring",
        amount="10.005",
        recurring_day=31,
    )

    assert request.amount == Decimal("10.01")
    assert request.recurring_day == 31


def test_recurring_bill_rejects_invalid_day_before_handler_execution():
    with pytest.raises(ValidationError):
        RecurringBillCreateRequest(
            title="Invalid recurring",
            amount="10.00",
            recurring_day=32,
        )
