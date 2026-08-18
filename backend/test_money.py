from decimal import Decimal

import pytest

from money import money, money_sum, money_to_storage


def test_money_avoids_binary_float_drift():
    assert money_sum([0.1, 0.2]) == Decimal("0.30")


def test_money_uses_explicit_half_up_rounding():
    assert money("1.005") == Decimal("1.01")
    assert money("1.004") == Decimal("1.00")
    assert money("-1.005") == Decimal("-1.01")


def test_money_preserves_zero_and_cent_scale():
    assert money(0) == Decimal("0.00")
    assert money("0.01") == Decimal("0.01")
    assert money_to_storage("123456.7") == "123456.70"


def test_money_to_storage_never_leaks_binary_float_representation():
    assert money_to_storage(0.1 + 0.2) == "0.30"
    assert money_to_storage("1000000") == "1000000.00"


def test_money_sum_handles_mixed_exact_inputs():
    values = [Decimal("10.10"), "20.20", 30, 0.4]
    assert money_sum(values) == Decimal("60.70")


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "not-a-number", None])
def test_money_rejects_non_finite_or_invalid_values(value):
    with pytest.raises(ValueError):
        money(value)
