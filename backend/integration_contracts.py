"""Safety contracts for experimental external invoice integrations.

External portals and mailboxes are untrusted, mutable dependencies. These helpers keep
experimental adapters fail-closed and prevent unvalidated financial data from being
promoted as successful invoice candidates.
"""

from __future__ import annotations

import asyncio
import os
from datetime import date
from decimal import Decimal
from typing import Awaitable, Callable, Literal

from pydantic import BaseModel, BeforeValidator, Field, field_validator, model_validator
from typing_extensions import Annotated

from money import money


MAX_INTEGRATION_MONEY = Decimal("1000000.00")
CanonicalMoney = Annotated[Decimal, BeforeValidator(money)]
IntegrationStatus = Literal["success", "info", "error", "blocked", "disabled", "unavailable"]


class InvoiceCandidate(BaseModel):
    """Validated, non-persisted financial data produced by an external adapter."""

    description: str = Field(min_length=1, max_length=150)
    amount: CanonicalMoney = Field(gt=Decimal("0.00"), le=MAX_INTEGRATION_MONEY)
    due_date: date
    barcode: str | None = Field(default=None, max_length=255)

    @field_validator("description", "barcode", mode="before")
    @classmethod
    def strip_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        return stripped or None


class IntegrationResult(BaseModel):
    status: IntegrationStatus
    message: str = Field(min_length=1, max_length=240)
    candidate: InvoiceCandidate | None = None

    @model_validator(mode="after")
    def validate_candidate_contract(self):
        if self.status == "success" and self.candidate is None:
            raise ValueError("successful integration results require a validated candidate")
        if self.status != "success" and self.candidate is not None:
            raise ValueError("non-success integration results cannot carry financial candidates")
        return self


def experimental_integrations_enabled() -> bool:
    """Experimental external-site automation is opt-in and disabled by default."""

    return os.getenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def disabled_result(name: str) -> IntegrationResult:
    return IntegrationResult(
        status="disabled",
        message=f"{name} is experimental and disabled unless explicitly enabled.",
    )


def blocked_result(name: str) -> IntegrationResult:
    return IntegrationResult(
        status="blocked",
        message=f"{name} requires human verification or access that automation must not bypass.",
    )


def unavailable_result(name: str) -> IntegrationResult:
    return IntegrationResult(
        status="unavailable",
        message=f"{name} is temporarily unavailable or its external interface changed.",
    )


def error_result(name: str) -> IntegrationResult:
    """Return a sanitized error without propagating provider/credential details."""

    return IntegrationResult(
        status="error",
        message=f"{name} could not complete safely. Check server diagnostics.",
    )


async def run_bounded(
    operation: Callable[[], Awaitable[IntegrationResult]],
    *,
    timeout_seconds: float,
    name: str,
) -> IntegrationResult:
    """Run one external operation with a hard upper bound and sanitized timeout."""

    if timeout_seconds <= 0 or timeout_seconds > 300:
        raise ValueError("timeout_seconds must be in (0, 300]")
    try:
        return await asyncio.wait_for(operation(), timeout=timeout_seconds)
    except TimeoutError:
        return IntegrationResult(
            status="unavailable",
            message=f"{name} timed out before producing a validated result.",
        )
