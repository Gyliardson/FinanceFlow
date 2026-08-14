"""Authoritative calendar boundary for FinanceFlow date-only financial events."""

import os
from datetime import date, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEFAULT_FINANCIAL_TIMEZONE = "America/Sao_Paulo"


def financial_timezone_name() -> str:
    """Return the configured IANA timezone used for date-only financial semantics."""
    return os.getenv("FINANCIAL_TIMEZONE", DEFAULT_FINANCIAL_TIMEZONE).strip() or DEFAULT_FINANCIAL_TIMEZONE


def financial_today(
    *,
    now: datetime | None = None,
    timezone_name: str | None = None,
) -> date:
    """Return the current financial calendar date in the configured timezone.

    An explicit ``now`` must be timezone-aware so tests/callers cannot accidentally
    reinterpret a naive datetime according to the CI/deploy host timezone.
    """
    name = timezone_name or financial_timezone_name()
    try:
        timezone = ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Unknown FINANCIAL_TIMEZONE: {name}") from exc

    if now is None:
        return datetime.now(timezone).date()
    if now.tzinfo is None:
        raise ValueError("financial_today requires a timezone-aware datetime")
    return now.astimezone(timezone).date()
