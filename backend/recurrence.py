import calendar
from datetime import date


def recurring_due_date(recurring_day: int, today: date) -> date:
    """Return the next due date for a monthly recurring bill.

    The configured day is clamped to the last valid day of shorter months.
    A due date equal to ``today`` is considered consumed, so the next month is
    selected. This matches the product rule that new/generated bills should not
    immediately be created as due today or already overdue.
    """
    if recurring_day < 1 or recurring_day > 31:
        raise ValueError("recurring_day must be between 1 and 31")

    last_day_this_month = calendar.monthrange(today.year, today.month)[1]
    candidate = date(
        today.year,
        today.month,
        min(recurring_day, last_day_this_month),
    )

    if today < candidate:
        return candidate

    if today.month == 12:
        year, month = today.year + 1, 1
    else:
        year, month = today.year, today.month + 1

    last_day_next_month = calendar.monthrange(year, month)[1]
    return date(year, month, min(recurring_day, last_day_next_month))
