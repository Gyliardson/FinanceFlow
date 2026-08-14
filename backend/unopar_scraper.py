"""Experimental Unopar student-portal browser adapter.

This adapter deliberately avoids stealth plugins, fingerprint spoofing, randomized
"human" input, and anti-bot/human-verification bypass. It is disabled by default and
returns only validated, non-persisted invoice candidates.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Literal

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

load_dotenv()
logger = logging.getLogger(__name__)

UNOPAR_URL = "https://login.unopar.br"
NAVIGATION_TIMEOUT_MS = 60_000
PortalState = Literal["blocked", "unavailable"]


def _payload(result: IntegrationResult) -> dict:
    return result.model_dump(mode="json", exclude_none=True)


def _classify_portal_text(text: str) -> PortalState | None:
    normalized = text.lower()
    if "captcha" in normalized or "verificação de segurança" in normalized:
        return "blocked"
    if "indisponível" in normalized or "tente novamente" in normalized:
        return "unavailable"
    return None


async def _first_visible(*locators):
    for locator in locators:
        try:
            if await locator.first.is_visible(timeout=2_500):
                return locator.first
        except Exception:
            continue
    return None


def _extract_visible_invoice(text: str) -> dict | None:
    description_match = re.search(r"(Mensalidade\s+\d+)", text, re.IGNORECASE)
    amount_match = re.search(r"Valor:\s*R\$\s*([\d.,]+)", text, re.IGNORECASE)
    due_match = re.search(
        r"(?:pontualidade|desconto|vencimento)\s*(?:até)?:?\s*(\d{2}/\d{2}/\d{4})",
        text,
        re.IGNORECASE,
    )
    if not amount_match or not due_match:
        return None

    day, month, year = due_match.group(1).split("/")
    return {
        "description": (description_match.group(1) if description_match else "Mensalidade Unopar"),
        "amount": amount_match.group(1).replace(".", "").replace(",", "."),
        "due_date": f"{year}-{month}-{day}",
    }


async def scrape_unopar() -> dict:
    if not experimental_integrations_enabled():
        return _payload(disabled_result("Unopar"))

    load_dotenv(override=True)
    student_id = os.getenv("UNOPAR_RA", "").strip()
    password = os.getenv("UNOPAR_PASSWORD", "")
    if not student_id or not password:
        return _payload(
            IntegrationResult(
                status="error",
                message="Unopar requires UNOPAR_RA and UNOPAR_PASSWORD server configuration.",
            )
        )

    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return _payload(unavailable_result("Unopar browser adapter"))

    try:
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            try:
                page = await (await browser.new_context()).new_page()
                page.set_default_timeout(NAVIGATION_TIMEOUT_MS)
                await page.goto(
                    UNOPAR_URL,
                    wait_until="domcontentloaded",
                    timeout=NAVIGATION_TIMEOUT_MS,
                )

                initial_state = _classify_portal_text(
                    await page.locator("body").inner_text()
                )
                if initial_state == "blocked":
                    return _payload(blocked_result("Unopar"))
                if initial_state == "unavailable":
                    return _payload(unavailable_result("Unopar portal"))

                identity_input = await _first_visible(
                    page.get_by_label("CPF", exact=False),
                    page.get_by_label("RA", exact=False),
                    page.locator('input[type="text"]'),
                )
                if identity_input is None:
                    return _payload(unavailable_result("Unopar login interface"))
                await identity_input.fill(student_id)
                await identity_input.press("Enter")

                password_input = await _first_visible(
                    page.get_by_label("Senha", exact=False),
                    page.locator('input[type="password"]'),
                )
                if password_input is None:
                    return _payload(unavailable_result("Unopar login interface"))
                await password_input.fill(password)
                await password_input.press("Enter")
                await page.wait_for_load_state("domcontentloaded")

                authenticated_state = _classify_portal_text(
                    await page.locator("body").inner_text()
                )
                if authenticated_state == "blocked":
                    return _payload(blocked_result("Unopar"))
                if authenticated_state == "unavailable":
                    return _payload(unavailable_result("Unopar portal"))

                finance_control = await _first_visible(
                    page.get_by_role("link", name="Financeiro", exact=False),
                    page.get_by_role("button", name="Financeiro", exact=False),
                    page.get_by_text("Financeiro", exact=True),
                )
                if finance_control is None:
                    return _payload(unavailable_result("Unopar financial interface"))
                await finance_control.click()
                await page.wait_for_load_state("domcontentloaded")

                visible_text = await page.locator("body").inner_text()
                finance_state = _classify_portal_text(visible_text)
                if finance_state == "blocked":
                    return _payload(blocked_result("Unopar"))
                if finance_state == "unavailable":
                    return _payload(unavailable_result("Unopar portal"))
                if "em aberto" not in visible_text.lower():
                    return _payload(
                        IntegrationResult(
                            status="info",
                            message="Unopar reports no open tuition invoice.",
                        )
                    )

                extracted = _extract_visible_invoice(visible_text)
                if extracted is None:
                    return _payload(unavailable_result("Unopar invoice interface"))

                # PIX/barcode is optional. Clipboard access is not granted globally;
                # use visible text only when the portal exposes it semantically.
                pix_match = re.search(
                    r"(?:pix|copia e cola|linha digit[aá]vel)\s*:?[\s\n]+([^\n]{10,255})",
                    visible_text,
                    re.IGNORECASE,
                )
                barcode = pix_match.group(1).strip() if pix_match else None

                try:
                    candidate = InvoiceCandidate(
                        description=extracted["description"],
                        amount=extracted["amount"],
                        due_date=extracted["due_date"],
                        barcode=barcode,
                    )
                except (ValidationError, ValueError, TypeError):
                    return _payload(error_result("Unopar invoice validation"))
            finally:
                await browser.close()

        return _payload(
            IntegrationResult(
                status="success",
                message="Unopar produced one validated invoice candidate.",
                candidate=candidate,
            )
        )
    except Exception as exc:
        logger.warning("Unopar adapter failed safely: %s", type(exc).__name__)
        return _payload(error_result("Unopar"))


if __name__ == "__main__":
    import asyncio

    print(asyncio.run(scrape_unopar()))
