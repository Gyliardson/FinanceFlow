"""Experimental integration scheduler.

The scheduler is intentionally a collector/orchestrator only. It never writes financial
records by itself; persistence must happen in an explicitly authenticated owner-scoped
service after candidate validation/idempotency checks. Production does not start this
loop.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from typing import Awaitable, Callable

from integration_contracts import (
    IntegrationResult,
    error_result,
    experimental_integrations_enabled,
)

logger = logging.getLogger(__name__)

Scraper = Callable[[], Awaitable[dict]]
DEFAULT_TIMEOUT_SECONDS = 90.0
MIN_INTERVAL_SECONDS = 300
MAX_INTERVAL_SECONDS = 86_400


@dataclass(frozen=True)
class ServiceSpec:
    name: str
    scraper: Scraper


def _load_default_services() -> tuple[ServiceSpec, ...]:
    """Lazy import keeps Playwright-only experimental modules out of production startup."""

    from dasmei_scraper import scrape_dasmei
    from tim_scraper import scrape_tim
    from unopar_scraper import scrape_unopar

    return (
        ServiceSpec("DASMEI", scrape_dasmei),
        ServiceSpec("Unopar", scrape_unopar),
        ServiceSpec("TIM", scrape_tim),
    )


def _normalize_result(name: str, payload: dict) -> IntegrationResult:
    try:
        return IntegrationResult.model_validate(payload)
    except Exception:
        logger.warning("%s returned an invalid integration contract", name)
        return error_result(name)


async def _run_service(
    service: ServiceSpec,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> IntegrationResult:
    if timeout_seconds <= 0 or timeout_seconds > 300:
        raise ValueError("timeout_seconds must be in (0, 300]")
    try:
        payload = await asyncio.wait_for(service.scraper(), timeout=timeout_seconds)
    except TimeoutError:
        return IntegrationResult(
            status="unavailable",
            message=f"{service.name} timed out before producing a validated result.",
        )
    except Exception as exc:
        logger.warning("%s adapter failed safely: %s", service.name, type(exc).__name__)
        return error_result(service.name)
    return _normalize_result(service.name, payload)


async def run_scheduler_cycle(
    services: tuple[ServiceSpec, ...] | None = None,
    *,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, IntegrationResult]:
    """Run one bounded collection cycle without database side effects."""

    if not experimental_integrations_enabled():
        return {}
    resolved_services = services if services is not None else _load_default_services()
    results: dict[str, IntegrationResult] = {}
    for service in resolved_services:
        results[service.name] = await _run_service(
            service, timeout_seconds=timeout_seconds
        )
    return results


def _configured_interval() -> int:
    raw = os.getenv("EXPERIMENTAL_INTEGRATION_INTERVAL_SECONDS", "86400")
    try:
        interval = int(raw)
    except ValueError as exc:
        raise ValueError("EXPERIMENTAL_INTEGRATION_INTERVAL_SECONDS must be an integer") from exc
    if not MIN_INTERVAL_SECONDS <= interval <= MAX_INTERVAL_SECONDS:
        raise ValueError(
            f"experimental scheduler interval must be between {MIN_INTERVAL_SECONDS} and {MAX_INTERVAL_SECONDS} seconds"
        )
    return interval


async def start_scheduler() -> None:
    """Start an explicitly enabled collection loop; never persists candidates."""

    if not experimental_integrations_enabled():
        logger.info("Experimental integration scheduler is disabled.")
        return

    interval = _configured_interval()
    logger.warning(
        "Experimental integration scheduler enabled in collection-only mode; no financial records will be persisted."
    )
    while True:
        results = await run_scheduler_cycle()
        for name, result in results.items():
            logger.info("Integration %s completed with status=%s", name, result.status)
        await asyncio.sleep(interval)
