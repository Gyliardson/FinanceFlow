from datetime import date

import pytest

from recurrence import recurring_due_date


def test_uses_current_month_when_due_date_is_still_ahead():
    assert recurring_due_date(20, date(2026, 8, 13)) == date(2026, 8, 20)


def test_today_equal_due_date_rolls_to_next_month():
    assert recurring_due_date(13, date(2026, 8, 13)) == date(2026, 9, 13)


def test_day_31_clamps_to_shorter_month():
    assert recurring_due_date(31, date(2026, 4, 1)) == date(2026, 4, 30)
    assert recurring_due_date(31, date(2026, 4, 30)) == date(2026, 5, 31)


def test_february_handles_leap_and_non_leap_years():
    assert recurring_due_date(31, date(2027, 2, 1)) == date(2027, 2, 28)
    assert recurring_due_date(31, date(2028, 2, 1)) == date(2028, 2, 29)


def test_december_rolls_to_next_year():
    assert recurring_due_date(31, date(2026, 12, 31)) == date(2027, 1, 31)


@pytest.mark.parametrize("recurring_day", [0, -1, 32, 100])
def test_rejects_invalid_recurring_day(recurring_day):
    with pytest.raises(ValueError):
        recurring_due_date(recurring_day, date(2026, 8, 13))
