"""Experimental PGMEI browser adapter.

This module intentionally does not attempt to evade CAPTCHA, bot detection, fraud
controls, or other human-verification mechanisms. The production FinanceFlow runtime
does not activate it. When explicitly enabled, it uses ordinary Playwright behavior
and fails closed if the external portal requires human verification or changes.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from datetime import datetime
from pathlib import Path
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

PGMEI_HOST = "www8.receita.fazenda.gov.br"
PGMEI_URL = (
    "https://www8.receita.fazenda.gov.br/SimplesNacional/"
    "Aplicacoes/ATSPO/pgmei.app/Identificacao"
)
NAVIGATION_TIMEOUT_MS = 45_000
MAX_PDF_BYTES = 10 * 1024 * 1024


def _result_payload(result: IntegrationResult) -> dict:
    return result.model_dump(mode="json", exclude_none=True)


def _target_competence(now: datetime) -> tuple[int, int]:
    if now.month == 1:
        return now.year - 1, 12
    return now.year, now.month - 1


def _requires_human_verification(body_text: str, *, captcha_frames: int = 0) -> bool:
    normalized = body_text.lower()
    return (
        captcha_frames > 0
        or "captcha" in normalized
        or "comportamento de rob" in normalized
        or "impedido" in normalized
        or "verificação de segurança" in normalized
    )


def _is_trusted_pgmei_url(url: str) -> bool:
    """Require the sensitive CNPJ form to remain on the expected HTTPS origin."""
    try:
        parsed = urlparse(url)
        port = parsed.port
    except (TypeError, ValueError):
        return False
    return (
        parsed.scheme.lower() == "https"
        and (parsed.hostname or "").lower() == PGMEI_HOST
        and port in (None, 443)
    )


def _prepare_pdf_for_external_ocr(pdf_bytes: bytes) -> bytes | None:
    """Validate external PGMEI bytes and produce the metadata-minimized OCR copy."""
    try:
        validated = validate_receipt_upload(
            pdf_bytes,
            "application/pdf",
            max_bytes=MAX_PDF_BYTES,
        )
        return sanitize_receipt_for_external_processing(validated)
    except Exception as exc:
        logger.warning("DASMEI PDF rejected before external OCR: %s", type(exc).__name__)
        return None


async def scrape_dasmei() -> dict:
    """Return one validated DAS invoice candidate without persisting it."""

    if not experimental_integrations_enabled():
        return _result_payload(disabled_result("DASMEI"))

    load_dotenv(override=True)
    cnpj = os.getenv("TARGET_CNPJ", "")
    cnpj_clean = re.sub(r"[^0-9]", "", cnpj)
    if len(cnpj_clean) != 14:
        return _result_payload(
            IntegrationResult(
                status="error",
                message="DASMEI requires a valid 14-digit TARGET_CNPJ configuration.",
            )
        )

    try:
        from playwright.async_api import TimeoutError as PlaywrightTimeoutError
        from playwright.async_api import async_playwright
    except ImportError:
        return _result_payload(unavailable_result("DASMEI browser adapter"))

    now = datetime.now()
    target_year, target_month = _target_competence(now)

    try:
        with tempfile.TemporaryDirectory(prefix="financeflow-dasmei-") as tmp_dir:
            pdf_path = Path(tmp_dir) / f"dasmei_{target_year}_{target_month:02d}.pdf"

            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch(headless=True)
                try:
                    context = await browser.new_context(accept_downloads=True)
                    page = await context.new_page()
                    page.set_default_timeout(NAVIGATION_TIMEOUT_MS)

                    await page.goto(
                        PGMEI_URL,
                        wait_until="domcontentloaded",
                        timeout=NAVIGATION_TIMEOUT_MS,
                    )
                    # CNPJ is sensitive configuration. Never submit it after a downgrade
                    # or cross-origin redirect, even if the portal UI still resembles PGMEI.
                    if not _is_trusted_pgmei_url(page.url):
                        return _result_payload(unavailable_result("DASMEI secure origin"))

                    cnpj_input = page.locator("#cnpj")
                    await cnpj_input.fill(cnpj_clean)
                    await cnpj_input.press("Enter")

                    # Human verification is a hard boundary, never something to evade.
                    body_text = await page.locator("body").inner_text()
                    captcha_frame = page.locator(
                        'iframe[src*="captcha" i], iframe[title*="captcha" i]'
                    )
                    if _requires_human_verification(
                        body_text,
                        captcha_frames=await captcha_frame.count(),
                    ):
                        return _result_payload(blocked_result("DASMEI"))

                    emit_selector = (
                        'a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao"]'
                    )
                    try:
                        await page.locator(emit_selector).wait_for(
                            state="visible", timeout=20_000
                        )
                    except PlaywrightTimeoutError:
                        return _result_payload(unavailable_result("DASMEI"))

                    await page.locator(emit_selector).click()
                    await page.wait_for_load_state("domcontentloaded")

                    await page.locator("#anoCalendarioSelect").select_option(
                        str(target_year)
                    )
                    await page.locator('button[type="submit"]').click()
                    await page.wait_for_load_state("domcontentloaded")

                    competence = f"{target_year}{target_month:02d}"
                    month_option = page.locator(f'[value="{competence}"]')
                    try:
                        await month_option.wait_for(state="visible", timeout=15_000)
                    except PlaywrightTimeoutError:
                        return _result_payload(
                            IntegrationResult(
                                status="info",
                                message="No DAS competence is currently available for collection.",
                            )
                        )

                    await month_option.click()
                    await page.locator("#btnEmitirDas").click()
                    await page.wait_for_load_state("domcontentloaded")

                    pdf_link = page.locator(
                        'a[href="/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao/imprimir"]'
                    ).first
                    try:
                        async with page.expect_download(timeout=15_000) as download_info:
                            await pdf_link.click()
                        download = await download_info.value
                        await download.save_as(str(pdf_path))
                    except PlaywrightTimeoutError:
                        return _result_payload(unavailable_result("DASMEI PDF download"))
                finally:
                    await browser.close()

            from ai_service import extract_invoice_data

            pdf_bytes = pdf_path.read_bytes()
            provider_pdf = _prepare_pdf_for_external_ocr(pdf_bytes)
            if provider_pdf is None:
                return _result_payload(error_result("DASMEI PDF validation"))

            ocr_response = extract_invoice_data(provider_pdf, "application/pdf")
            if ocr_response.get("status") != "success":
                return _result_payload(error_result("DASMEI OCR"))

            extracted = ocr_response.get("extracted_data") or {}
            try:
                candidate = InvoiceCandidate(
                    description=f"Guia DAS MEI - {target_month:02d}/{target_year}",
                    amount=extracted.get("amount"),
                    due_date=extracted.get("due_date"),
                    barcode=extracted.get("barcode"),
                )
            except (ValidationError, ValueError, TypeError):
                return _result_payload(error_result("DASMEI invoice validation"))

            return _result_payload(
                IntegrationResult(
                    status="success",
                    message="DASMEI produced one validated invoice candidate.",
                    candidate=candidate,
                )
            )
    except Exception as exc:  # external browser/provider boundary
        logger.warning("DASMEI adapter failed safely: %s", type(exc).__name__)
        return _result_payload(error_result("DASMEI"))


if __name__ == "__main__":
    import asyncio

    print(asyncio.run(scrape_dasmei()))
