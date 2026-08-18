"""Canonical HTTP request/response models shared by production route modules.

Keeping route contracts outside the compatibility application module prevents security-sensitive
routers from importing and constructing a second FastAPI application as a side effect.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, Field

from money import money


MAX_MONEY = Decimal("1000000.00")
MIN_SIGNED_MONEY = Decimal("-1000000.00")
CanonicalMoney = Annotated[Decimal, BeforeValidator(money)]
IncomeType = Literal["salary", "extra", "adjustment"]


def canonical_date(value) -> str:
    """Normalize a date-only API value to strict ISO YYYY-MM-DD semantics."""
    # ``datetime`` subclasses ``date`` in Python. Reject it explicitly so callers
    # cannot bypass the date-only contract by supplying an in-process datetime.
    if isinstance(value, datetime):
        raise ValueError("Date must use ISO YYYY-MM-DD format without a time component.")
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str):
        raise ValueError("Date must use ISO YYYY-MM-DD format.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("Date must be a valid ISO YYYY-MM-DD calendar date.") from exc
    if value != parsed.isoformat():
        # Keep the public contract deterministic instead of accepting alternate
        # date spellings or datetime/timezone values for date-only financial fields.
        raise ValueError("Date must use canonical ISO YYYY-MM-DD format.")
    return parsed.isoformat()


def canonical_bill_id(value) -> str:
    """Normalize bill identifiers before a request can reach UUID-backed storage."""
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError("Bill identifier must be a valid UUID.") from exc


CanonicalDate = Annotated[str, BeforeValidator(canonical_date)]
CanonicalBillId = Annotated[str, BeforeValidator(canonical_bill_id)]


class HealthResponse(BaseModel):
    status: str
    message: str


class BillCreateRequest(BaseModel):
    description: str = Field(..., max_length=150)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    due_date: CanonicalDate
    barcode: Optional[str] = Field(None, max_length=255)
    # New bills enter the authoritative lifecycle as pending. Paid/overdue are
    # server-owned transitions so clients cannot create a paid row without the
    # payment metadata used by financial calculations.
    status: Literal["pending"] = "pending"


class RecurringBillCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    recurring_day: int = Field(..., ge=1, le=31)
    # The current recurrence engine is intentionally monthly-only. Rejecting
    # unsupported labels prevents records that claim one cadence while being
    # generated with another.
    frequency: Literal["monthly"] = "monthly"


class BillValidationRequest(BaseModel):
    bill_id: CanonicalBillId
    ocr_amount: Optional[CanonicalMoney] = None
    ocr_due_date: Optional[CanonicalDate] = None
    ocr_barcode: Optional[str] = None


class IncomeCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    date: CanonicalDate
    description: Optional[str] = Field(None, max_length=255)
    type: IncomeType = "salary"
    is_recurring: bool = False


class SettingsUpdateRequest(BaseModel):
    initial_balance: CanonicalMoney = Field(..., ge=MIN_SIGNED_MONEY, le=MAX_MONEY)
    initial_balance_date: CanonicalDate
    emergency_fund_goal: CanonicalMoney = Field(..., ge=Decimal("0.00"), le=MAX_MONEY)


class EmergencyFundGoalUpdateRequest(BaseModel):
    emergency_fund_goal: CanonicalMoney = Field(..., ge=Decimal("0.00"), le=MAX_MONEY)


class ReserveAddRequest(BaseModel):
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
