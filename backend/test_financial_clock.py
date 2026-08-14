from datetime import datetime, timezone

import pytest

from financial_clock import DEFAULT_FINANCIAL_TIMEZONE, financial_today


def test_financial_today_uses_brazil_calendar_before_utc_rollover():
    # 01:30 UTC is still 22:30 on the previous calendar day in São Paulo.
    now = datetime(2026, 8, 15, 1, 30, tzinfo=timezone.utc)
    assert financial_today(now=now) == datetime(2026, 8, 14).date()


def test_financial_today_crosses_midnight_in_configured_timezone():
    now = datetime(2026, 8, 15, 3, 0, tzinfo=timezone.utc)
    assert financial_today(now=now, timezone_name=DEFAULT_FINANCIAL_TIMEZONE) == datetime(2026, 8, 15).date()


def test_financial_today_rejects_naive_datetime():
    with pytest.raises(ValueError, match="timezone-aware"):
        financial_today(now=datetime(2026, 8, 14, 22, 0))


def test_financial_today_rejects_unknown_timezone():
    with pytest.raises(ValueError, match="Unknown FINANCIAL_TIMEZONE"):
        financial_today(
            now=datetime(2026, 8, 14, 22, 0, tzinfo=timezone.utc),
            timezone_name="Invalid/FinanceFlow",
        )
