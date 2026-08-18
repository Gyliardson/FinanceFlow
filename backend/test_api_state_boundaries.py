import pytest
from pydantic import ValidationError

from api_models import BillCreateRequest, RecurringBillCreateRequest


def test_new_bill_defaults_to_pending_status():
    request = BillCreateRequest(
        description="Synthetic bill",
        amount="10.00",
        due_date="2026-08-31",
    )
    assert request.status == "pending"


@pytest.mark.parametrize("client_status", ["paid", "overdue", "cancelled"])
def test_client_cannot_create_bill_in_server_owned_status(client_status):
    with pytest.raises(ValidationError):
        BillCreateRequest(
            description="Forged status",
            amount="10.00",
            due_date="2026-08-31",
            status=client_status,
        )


def test_recurring_bill_defaults_to_supported_monthly_frequency():
    request = RecurringBillCreateRequest(
        title="Rent",
        amount="1000.00",
        recurring_day=5,
    )
    assert request.frequency == "monthly"


@pytest.mark.parametrize("unsupported_frequency", ["weekly", "yearly", "daily"])
def test_recurring_bill_rejects_frequency_not_implemented_by_engine(unsupported_frequency):
    with pytest.raises(ValidationError):
        RecurringBillCreateRequest(
            title="Unsupported cadence",
            amount="10.00",
            recurring_day=5,
            frequency=unsupported_frequency,
        )
