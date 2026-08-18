from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Iterable, Union

MoneyInput = Union[Decimal, int, float, str]
CENT = Decimal("0.01")
ZERO = Decimal("0.00")


def money(value: MoneyInput) -> Decimal:
    """Normalize a monetary value to two decimal places using ROUND_HALF_UP.

    Floats are converted through ``str`` so their binary representation never
    becomes part of authoritative arithmetic.
    """
    try:
        amount = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise ValueError(f"Invalid monetary value: {value!r}") from exc

    if not amount.is_finite():
        raise ValueError("Monetary values must be finite")

    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def money_sum(values: Iterable[MoneyInput]) -> Decimal:
    """Sum monetary values without binary floating-point arithmetic."""
    total = ZERO
    for value in values:
        total += money(value)
    return total.quantize(CENT, rounding=ROUND_HALF_UP)


def money_to_storage(value: MoneyInput) -> str:
    """Return a canonical fixed-scale decimal string for NUMERIC/DECIMAL storage."""
    return format(money(value), ".2f")
