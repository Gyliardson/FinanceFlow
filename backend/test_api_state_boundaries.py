import pytest
from pydantic import ValidationError

from api_models import BillCreateRequest


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
