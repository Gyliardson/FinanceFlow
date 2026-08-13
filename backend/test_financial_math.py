from decimal import Decimal

import pytest

from financial_math import add_to_reserve, calculate_balances


def test_calculate_balances_is_exact_across_decimal_boundaries():
    result = calculate_balances(
        initial_balance="1000.10",
        incomes=["0.10", "0.20", "199.60"],
        paid_bills=["300.01", "0.09"],
        emergency_fund_balance="100.00",
        pending_bills=["99.99", "0.01"],
    )

    assert result == {
        "current_balance": Decimal("799.90"),
        "estimated_surplus": Decimal("699.90"),
    }


def test_calculate_balances_supports_negative_balance_without_float_drift():
    result = calculate_balances(
        initial_balance="0.00",
        incomes=[],
        paid_bills=["0.10", "0.20"],
        emergency_fund_balance="0.00",
        pending_bills=["0.30"],
    )
    assert result["current_balance"] == Decimal("-0.30")
    assert result["estimated_surplus"] == Decimal("-0.60")


def test_add_to_reserve_rounds_once_at_currency_boundary():
    assert add_to_reserve("10.00", "0.005") == Decimal("10.01")


@pytest.mark.parametrize("amount", ["0", "-0.01"])
def test_add_to_reserve_rejects_non_positive_amount(amount):
    with pytest.raises(ValueError):
        add_to_reserve("10.00", amount)
