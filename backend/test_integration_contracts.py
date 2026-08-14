import asyncio
from decimal import Decimal

import pytest
from pydantic import ValidationError

from integration_contracts import (
    IntegrationResult,
    InvoiceCandidate,
    blocked_result,
    disabled_result,
    experimental_integrations_enabled,
    run_bounded,
)


def test_experimental_integrations_are_disabled_by_default(monkeypatch):
    monkeypatch.delenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", raising=False)
    assert experimental_integrations_enabled() is False
    assert disabled_result("DASMEI").status == "disabled"


@pytest.mark.parametrize("value", ["1", "true", "TRUE", " yes "])
def test_experimental_integrations_require_explicit_opt_in(monkeypatch, value):
    monkeypatch.setenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", value)
    assert experimental_integrations_enabled() is True


def test_invoice_candidate_uses_exact_money_and_iso_date():
    candidate = InvoiceCandidate(
        description="  Conta de teste  ",
        amount="0.105",
        due_date="2026-02-28",
        barcode="  12345  ",
    )

    assert candidate.description == "Conta de teste"
    assert candidate.amount == Decimal("0.11")
    assert candidate.due_date.isoformat() == "2026-02-28"
    assert candidate.barcode == "12345"


@pytest.mark.parametrize(
    "payload",
    [
        {"description": "Conta", "amount": "0", "due_date": "2026-02-28"},
        {"description": "Conta", "amount": "NaN", "due_date": "2026-02-28"},
        {"description": "Conta", "amount": "10.00", "due_date": "not-a-date"},
        {"description": "", "amount": "10.00", "due_date": "2026-02-28"},
    ],
)
def test_invalid_financial_candidates_fail_closed(payload):
    with pytest.raises((ValidationError, ValueError)):
        InvoiceCandidate(**payload)


def test_success_requires_validated_candidate():
    with pytest.raises(ValidationError):
        IntegrationResult(status="success", message="ok")


def test_non_success_cannot_smuggle_financial_candidate():
    candidate = InvoiceCandidate(
        description="Conta",
        amount="10.00",
        due_date="2026-02-28",
    )
    with pytest.raises(ValidationError):
        IntegrationResult(status="error", message="failed", candidate=candidate)


def test_blocked_result_has_no_candidate():
    result = blocked_result("Portal")
    assert result.status == "blocked"
    assert result.candidate is None
    assert "must not bypass" in result.message


def test_bounded_operation_times_out_without_provider_details():
    async def slow_operation():
        await asyncio.sleep(0.05)
        return IntegrationResult(status="info", message="done")

    result = asyncio.run(
        run_bounded(slow_operation, timeout_seconds=0.001, name="Portal")
    )

    assert result.status == "unavailable"
    assert "timed out" in result.message


@pytest.mark.parametrize("timeout", [0, -1, 301])
def test_bounded_operation_rejects_invalid_timeout(timeout):
    async def operation():
        return IntegrationResult(status="info", message="done")

    with pytest.raises(ValueError):
        asyncio.run(run_bounded(operation, timeout_seconds=timeout, name="Portal"))
