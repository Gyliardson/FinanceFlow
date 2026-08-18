from decimal import Decimal

import pytest

from financial_math import add_to_reserve, amounts_within_percentage, calculate_balances


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


def test_calculate_balances_handles_large_allowed_values_exactly():
    result = calculate_balances(
        initial_balance="1000000.00",
        incomes=["1000000.00", "999999.99"],
        paid_bills=["999999.98"],
        emergency_fund_balance="500000.01",
        pending_bills=["750000.00", "0.01"],
    )

    assert result == {
        "current_balance": Decimal("1500000.00"),
        "estimated_surplus": Decimal("749999.99"),
    }


def test_calculate_balances_normalizes_each_external_money_value_before_totalling():
    result = calculate_balances(
        initial_balance="0",
        incomes=["0.005", "0.005"],
        paid_bills=[],
        emergency_fund_balance="0",
        pending_bills=[],
    )

    # Each independently supplied monetary value crosses the currency boundary
    # before aggregation, so each 0.005 becomes 0.01 under ROUND_HALF_UP.
    assert result["current_balance"] == Decimal("0.02")


def test_add_to_reserve_rounds_once_at_currency_boundary():
    assert add_to_reserve("10.00", "0.005") == Decimal("10.01")


@pytest.mark.parametrize("amount", ["0", "-0.01"])
def test_add_to_reserve_rejects_non_positive_amount(amount):
    with pytest.raises(ValueError):
        add_to_reserve("10.00", amount)


def test_amount_tolerance_accepts_exact_five_percent_boundary():
    assert amounts_within_percentage("100.00", "105.00") is True
    assert amounts_within_percentage("100.00", "95.00") is True


def test_amount_tolerance_rejects_one_cent_beyond_boundary():
    assert amounts_within_percentage("100.00", "105.01") is False
    assert amounts_within_percentage("100.00", "94.99") is False


def test_amount_tolerance_normalizes_external_values_before_comparison():
    assert amounts_within_percentage("0.30", 0.1 + 0.2) is True
    assert amounts_within_percentage("10.00", "10.005", tolerance=Decimal("0.001")) is True


def test_amount_tolerance_rejects_invalid_negative_reference():
    with pytest.raises(ValueError):
        amounts_within_percentage("-1.00", "-1.00")
