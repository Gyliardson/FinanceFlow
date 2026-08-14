import asyncio
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

from dasmei_scraper import (
    _requires_human_verification,
    _target_competence,
    scrape_dasmei,
)
from imap_scraper import (
    _is_allowed_message,
    _looks_encrypted_pdf,
    _pdf_attachments,
    _source_id,
    scrape_vivo_email,
)
from integration_contracts import IntegrationResult, InvoiceCandidate
from scheduler import ServiceSpec, _run_service, run_scheduler_cycle
from tim_scraper import _classify_portal_text as classify_tim_portal
from tim_scraper import scrape_tim
from unopar_scraper import _classify_portal_text as classify_unopar_portal
from unopar_scraper import _extract_visible_invoice, scrape_unopar


BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent
BROWSER_ADAPTERS = (
    "dasmei_scraper.py",
    "tim_scraper.py",
    "unopar_scraper.py",
)


def test_browser_adapters_are_disabled_without_explicit_opt_in(monkeypatch):
    monkeypatch.delenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", raising=False)

    for scraper in (scrape_dasmei, scrape_tim, scrape_unopar):
        result = asyncio.run(scraper())
        assert result["status"] == "disabled"
        assert "candidate" not in result


def test_dasmei_competence_and_human_verification_are_deterministic():
    assert _target_competence(datetime(2026, 1, 10)) == (2025, 12)
    assert _target_competence(datetime(2026, 8, 10)) == (2026, 7)
    assert _requires_human_verification("Acesso normal") is False
    assert _requires_human_verification("Verificação de segurança obrigatória") is True
    assert _requires_human_verification("Acesso normal", captcha_frames=1) is True


def test_tim_portal_state_fixtures_fail_closed():
    assert classify_tim_portal("CAPTCHA obrigatório") == "blocked"
    assert classify_tim_portal("Serviço indisponível, tente novamente") == "unavailable"
    assert classify_tim_portal("Suas contas estão todas pagas") == "all_paid"
    assert classify_tim_portal("Área de contas") is None


def test_unopar_portal_state_and_invoice_parser_fixtures():
    assert classify_unopar_portal("Verificação de segurança") == "blocked"
    assert classify_unopar_portal("Portal indisponível") == "unavailable"
    assert classify_unopar_portal("Financeiro") is None

    extracted = _extract_visible_invoice(
        "Mensalidade 8\nEm aberto\nValor: R$ 1.234,56\nVencimento: 31/08/2026"
    )
    assert extracted == {
        "description": "Mensalidade 8",
        "amount": "1234.56",
        "due_date": "2026-08-31",
    }
    assert _extract_visible_invoice("Mensalidade 8\nEm aberto\nVencimento: 31/08/2026") is None


def test_imap_collector_is_disabled_without_credentials_or_network(monkeypatch):
    monkeypatch.delenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", raising=False)

    result = asyncio.run(scrape_vivo_email())

    assert result["status"] == "disabled"
    assert "candidate" not in result


def test_imap_allowlist_and_subject_filter_are_fail_closed(monkeypatch):
    monkeypatch.setenv("IMAP_ALLOWED_SENDERS", "billing@example.com")
    monkeypatch.setenv("IMAP_SUBJECT_CONTAINS", "invoice,fatura")

    allowed = EmailMessage()
    allowed["From"] = "Billing <billing@example.com>"
    allowed["Subject"] = "Fatura de agosto"

    wrong_sender = EmailMessage()
    wrong_sender["From"] = "attacker@example.net"
    wrong_sender["Subject"] = "Fatura de agosto"

    wrong_subject = EmailMessage()
    wrong_subject["From"] = "billing@example.com"
    wrong_subject["Subject"] = "Newsletter"

    assert _is_allowed_message(allowed) is True
    assert _is_allowed_message(wrong_sender) is False
    assert _is_allowed_message(wrong_subject) is False


def test_pdf_attachment_requires_filename_mime_size_and_pdf_signature(monkeypatch):
    import imap_scraper

    monkeypatch.setattr(imap_scraper, "MAX_PDF_BYTES", 64)

    message = EmailMessage()
    message.set_content("body")
    message.add_attachment(
        b"%PDF-1.7\nsynthetic",
        maintype="application",
        subtype="pdf",
        filename="invoice.pdf",
    )
    message.add_attachment(
        b"not a pdf",
        maintype="application",
        subtype="pdf",
        filename="spoofed.pdf",
    )
    message.add_attachment(
        b"%PDF-1.7\nwrong mime",
        maintype="application",
        subtype="octet-stream",
        filename="wrong-mime.pdf",
    )
    message.add_attachment(
        b"%PDF-1.7\n" + b"x" * 100,
        maintype="application",
        subtype="pdf",
        filename="too-large.pdf",
    )

    attachments = list(_pdf_attachments(message))

    assert len(attachments) == 1
    assert attachments[0][0] == "invoice.pdf"
    assert attachments[0][1].startswith(b"%PDF-")


def test_encrypted_pdf_marker_is_quarantined_without_parser_dependency():
    assert _looks_encrypted_pdf(b"%PDF-1.7\ntrailer << /Encrypt 12 0 R >>") is True
    assert _looks_encrypted_pdf(b"%PDF-1.7\nsynthetic unencrypted fixture") is False


def test_imap_source_id_is_deterministic_and_content_sensitive():
    message = EmailMessage()
    message["Message-ID"] = "<invoice-123@example.com>"

    first = _source_id(message, "invoice.pdf", b"%PDF-first")
    repeated = _source_id(message, "invoice.pdf", b"%PDF-first")
    changed = _source_id(message, "invoice.pdf", b"%PDF-second")

    assert first == repeated
    assert first != changed
    assert len(first) == 64


def test_scheduler_does_nothing_when_experimental_integrations_are_disabled(monkeypatch):
    monkeypatch.delenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", raising=False)

    async def should_not_run():
        raise AssertionError("disabled scheduler must not invoke adapters")

    services = (ServiceSpec("test", should_not_run),)
    assert asyncio.run(run_scheduler_cycle(services)) == {}


def test_scheduler_accepts_only_validated_contracts(monkeypatch):
    monkeypatch.setenv("ENABLE_EXPERIMENTAL_INTEGRATIONS", "true")
    candidate = InvoiceCandidate(
        description="Synthetic invoice",
        amount="10.00",
        due_date="2026-08-31",
    )

    async def valid_adapter():
        return IntegrationResult(
            status="success",
            message="validated",
            candidate=candidate,
        ).model_dump(mode="json", exclude_none=True)

    async def invalid_adapter():
        return {
            "status": "success",
            "message": "invalid because candidate is missing",
        }

    results = asyncio.run(
        run_scheduler_cycle(
            (
                ServiceSpec("valid", valid_adapter),
                ServiceSpec("invalid", invalid_adapter),
            )
        )
    )

    assert results["valid"].status == "success"
    assert results["valid"].candidate == candidate
    assert results["invalid"].status == "error"
    assert results["invalid"].candidate is None


def test_scheduler_timeout_is_bounded_and_sanitized():
    async def slow_adapter():
        await asyncio.sleep(0.05)
        return {"status": "info", "message": "done"}

    result = asyncio.run(
        _run_service(
            ServiceSpec("Portal", slow_adapter),
            timeout_seconds=0.001,
        )
    )

    assert result.status == "unavailable"
    assert result.candidate is None
    assert "timed out" in result.message


def test_browser_adapters_do_not_reintroduce_evasion_or_persistent_screenshots():
    forbidden_tokens = (
        "playwright_stealth",
        "Stealth(",
        "page.mouse.click(",
        "user_agent=",
        "screenshot(path=",
        "random.uniform(",
        "random.randint(",
    )

    for filename in BROWSER_ADAPTERS:
        source = (BACKEND_DIR / filename).read_text(encoding="utf-8")
        for token in forbidden_tokens:
            assert token not in source, f"{filename} reintroduced forbidden pattern: {token}"


def test_readme_does_not_describe_antibot_bypass_as_a_feature():
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8").lower()
    forbidden_claims = (
        "para burlar bloqueios antibot",
        "to bypass antibot protections",
        "playwright-stealth",
        "superando os desafios do canvaskit",
    )

    for claim in forbidden_claims:
        assert claim not in readme
