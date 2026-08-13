from decimal import Decimal
from typing import Iterable

from money import MoneyInput, money, money_sum


def calculate_balances(
    *,
    initial_balance: MoneyInput,
    incomes: Iterable[MoneyInput],
    paid_bills: Iterable[MoneyInput],
    emergency_fund_balance: MoneyInput,
    pending_bills: Iterable[MoneyInput],
) -> dict[str, Decimal]:
    """Calculate authoritative FinanceFlow balances using exact decimal money."""
    current_balance = (
        money(initial_balance)
        + money_sum(incomes)
        - money_sum(paid_bills)
        - money(emergency_fund_balance)
    )
    current_balance = money(current_balance)
    estimated_surplus = money(current_balance - money_sum(pending_bills))

    return {
        "current_balance": current_balance,
        "estimated_surplus": estimated_surplus,
    }


def add_to_reserve(current_reserve: MoneyInput, amount: MoneyInput) -> Decimal:
    """Add to the emergency reserve without binary floating-point arithmetic."""
    increment = money(amount)
    if increment <= 0:
        raise ValueError("Reserve increment must be greater than zero")
    return money(money(current_reserve) + increment)
