"""Canonical HTTP request/response models shared by production route modules.

Keeping route contracts outside the legacy application module prevents security-sensitive
routers from importing and constructing a second FastAPI application as a side effect.
"""

from decimal import Decimal
from typing import Annotated, Optional

from pydantic import BaseModel, BeforeValidator, Field

from money import money


MAX_MONEY = Decimal("1000000.00")
MIN_SIGNED_MONEY = Decimal("-1000000.00")
CanonicalMoney = Annotated[Decimal, BeforeValidator(money)]


class HealthResponse(BaseModel):
    status: str
    message: str


class BillCreateRequest(BaseModel):
    description: str = Field(..., max_length=150)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    due_date: str
    barcode: Optional[str] = Field(None, max_length=255)
    status: str = "pending"


class RecurringBillCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    recurring_day: int = Field(..., ge=1, le=31)
    frequency: str = "monthly"


class BillValidationRequest(BaseModel):
    bill_id: str
    ocr_amount: Optional[CanonicalMoney] = None
    ocr_due_date: Optional[str] = None
    ocr_barcode: Optional[str] = None


class IncomeCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    date: str
    description: Optional[str] = Field(None, max_length=255)
    type: str = "salary"
    is_recurring: bool = False


class SettingsUpdateRequest(BaseModel):
    initial_balance: CanonicalMoney = Field(..., ge=MIN_SIGNED_MONEY, le=MAX_MONEY)
    initial_balance_date: str
    emergency_fund_goal: CanonicalMoney = Field(..., ge=Decimal("0.00"), le=MAX_MONEY)


class ReserveAddRequest(BaseModel):
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
