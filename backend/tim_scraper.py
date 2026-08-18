"""Experimental Meu TIM browser adapter.

The adapter uses ordinary Playwright behavior only. It does not use stealth plugins,
coordinate spraying, forged browser fingerprints, or CAPTCHA/human-verification
bypass techniques. Production does not activate this module.
"""

from __future__ import annotations

import logging
import os
from typing import Literal
from urllib.parse import urlparse

from dotenv import load_dotenv
from pydantic import ValidationError

from integration_contracts import (
    IntegrationResult,
    InvoiceCandidate,
    blocked_result,
    disabled_result,
    error_result,
    experimental_integrations_enabled,
    unavailable_result,
)
from receipt_uploads import sanitize_receipt_for_external_processing, validate_receipt_upload

load_dotenv()
logger = logging.getLogger(__name__)

MEU_TIM_HOST = "meuplano2.tim.com.br"
MEU_TIM_URL = f"https://{MEU_TIM_HOST}/home"
NAVIGATION_TIMEOUT_MS = 60_000
ALL_PAID_KEYWORDS = (
    "suas contas estão todas pagas",
    "contas estão todas pagas",
    "próximas faturas iremos apresentar aqui",
)
PortalState = Literal["blocked", "unavailable", "all_paid"]


def _payload(result: IntegrationResult) -> dict:
    return result.model_dump(mode="json", exclude_none=True)


def _classify_portal_text(text: str) -> PortalState | None:
    normalized = text.lower()
    if "captcha" in normalized or "verificação de segurança" in normalized:
        return "blocked"
    if "indisponível" in normalized or "tente novamente" in normalized:
        return "unavailable"
    if any(keyword in normalized for keyword in ALL_PAID_KEYWORDS):
        return "all_paid"
    return None


def _is_trusted_tim_url(url: str) -> bool:
    """Require TIM credentials to stay on the configured HTTPS login origin."""
    try:
        parsed = urlparse(url)
        port = parsed.port
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() == MEU_TIM_HOST
        and port in (None, 443)
    )


def _prepare_screenshot_for_external_ocr(screenshot: bytes) -> bytes | None:
    """Validate and minimize an authenticated TIM screenshot before external OCR."""
    try:
        validated = validate_receipt_upload(screenshot, "image/png")
        return sanitize_receipt_for_external_processing(validated)
    except Exception as exc:
        logger.warning("TIM screenshot rejected before external OCR: %s", type(exc).__name__)
        return None


async def _first_visible(*locators):
    for locator in locators:
        try:
            if await locator.first.is_visible(timeout=2_500):
                return locator.first
        except Exception:
            continue
    return None


async def scrape_tim() -> dict:
    """Return a validated invoice candidate or an explicit non-success state."""

    if not experimental_integrations_enabled():
        return _payload(disabled_result("TIM"))

    load_dotenv(override=True)
    phone = os.getenv("TIM_PHONE", "").strip()
    password = os.getenv("TIM_PASSWORD", "")
    if not phone or not password:
        return _payload(
            IntegrationResult(
                status="error",
                message="TIM requires TIM_PHONE and TIM_PASSWORD server configuration.",
            )
        )

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return _payload(unavailable_result("TIM browser adapter"))

    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await (await browser.new_context()).new_page()
                page.set_default_timeout(NAVIGATION_TIMEOUT_MS)
                await page.goto(
                    MEU_TIM_URL,
                    wait_until="domcontentloaded",
                    timeout=NAVIGATION_TIMEOUT_MS,
                )

                # Login credentials are sensitive configuration. Never fill them
                # after a downgrade or cross-origin redirect, even if a lookalike
                # page exposes matching labels/input types.
                if not _is_trusted_tim_url(page.url):
                    return _payload(unavailable_result("TIM secure login origin"))

                initial_state = _classify_portal_text(
                    await page.locator("body").inner_text()
                )
                if initial_state == "blocked":
                    return _payload(blocked_result("TIM"))
                if initial_state == "unavailable":
                    return _payload(unavailable_result("TIM portal"))

                phone_input = await _first_visible(
                    page.get_by_label("Telefone", exact=False),
                    page.get_by_label("Número", exact=False),
                    page.locator('input[type="tel"]'),
                )
                password_input = await _first_visible(
                    page.get_by_label("Senha", exact=False),
                    page.locator('input[type="password"]'),
                )
                if phone_input is None or password_input is None:
                    return _payload(unavailable_result("TIM login interface"))

                if not _is_trusted_tim_url(page.url):
                    return _payload(unavailable_result("TIM secure login origin"))
                await phone_input.fill(phone)

                # Re-check immediately before the password boundary so a portal
                # transition cannot silently move the more sensitive field.
                if not _is_trusted_tim_url(page.url):
                    return _payload(unavailable_result("TIM secure login origin"))
                await password_input.fill(password)
                submit = await _first_visible(
                    page.get_by_role("button", name="Entrar", exact=False),
                    page.locator('button[type="submit"]'),
                )
                if submit is None:
                    return _payload(unavailable_result("TIM login interface"))
                await submit.click()
                await page.wait_for_load_state("domcontentloaded")

                authenticated_state = _classify_portal_text(
                    await page.locator("body").inner_text()
                )
                if authenticated_state == "blocked":
                    return _payload(blocked_result("TIM"))
                if authenticated_state == "unavailable":
                    return _payload(unavailable_result("TIM portal"))

                accounts_control = await _first_visible(
                    page.get_by_role("link", name="Contas", exact=False),
                    page.get_by_role("button", name="Contas", exact=False),
                    page.get_by_text("Contas", exact=True),
                )
                if accounts_control is None:
                    # Canvas-only interfaces are treated as unsupported rather than
                    # manipulated through guessed screen coordinates.
                    return _payload(unavailable_result("TIM accounts interface"))

                await accounts_control.click()
                await page.wait_for_load_state("domcontentloaded")
                accounts_state = _classify_portal_text(
                    await page.locator("body").inner_text()
                )
                if accounts_state == "blocked":
                    return _payload(blocked_result("TIM"))
                if accounts_state == "unavailable":
                    return _payload(unavailable_result("TIM portal"))
                if accounts_state == "all_paid":
                    return _payload(
                        IntegrationResult(
                            status="info",
                            message="TIM reports no open invoice for this account.",
                        )
                    )

                # Some portal versions render invoice details on canvas. If DOM text
                # does not expose a usable amount/date, OCR is performed in-memory;
                # no authenticated screenshot is written to disk.
                screenshot = await page.screenshot(full_page=False)
            finally:
                await browser.close()

        provider_screenshot = _prepare_screenshot_for_external_ocr(screenshot)
        if provider_screenshot is None:
            return _payload(error_result("TIM screenshot validation"))

        from ai_service import extract_invoice_data

        ocr_response = extract_invoice_data(provider_screenshot, "image/png")
        if ocr_response.get("status") != "success":
            return _payload(error_result("TIM OCR"))
        extracted = ocr_response.get("extracted_data") or {}

        try:
            candidate = InvoiceCandidate(
                description="Conta TIM Móvel",
                amount=extracted.get("amount"),
                due_date=extracted.get("due_date"),
                barcode=extracted.get("barcode"),
            )
        except (ValidationError, ValueError, TypeError):
            return _payload(error_result("TIM invoice validation"))

        return _payload(
            IntegrationResult(
                status="success",
                message="TIM produced one validated invoice candidate.",
                candidate=candidate,
            )
        )
    except Exception as exc:
        logger.warning("TIM adapter failed safely: %s", type(exc).__name__)
        return _payload(error_result("TIM"))


if __name__ == "__main__":
    import asyncio

    print(asyncio.run(scrape_tim()))
