"""Experimental IMAP/PDF invoice collector.

The collector is intentionally non-destructive and does not persist financial records.
It narrows messages by an explicit sender allowlist, uses BODY.PEEK to avoid marking
messages as read, validates PDF content/size, and returns deterministic source IDs so
an owner-scoped caller can implement persistence/idempotency separately.

Encrypted PDFs are deliberately unsupported by the default experimental baseline. This
avoids adding a vulnerable PDF parser solely for decryption; encrypted attachments fail
closed until a patched parser baseline is available and reviewed.
"""

from __future__ import annotations

import email
import hashlib
import imaplib
import logging
import os
from email.header import decode_header
from email.utils import parseaddr
from typing import Callable

from dotenv import load_dotenv
from pydantic import ValidationError

from integration_contracts import (
    InvoiceCandidate,
    disabled_result,
    error_result,
    experimental_integrations_enabled,
    unavailable_result,
)

load_dotenv()
logger = logging.getLogger(__name__)

DEFAULT_IMAP_SERVER = "imap.gmail.com"
MAX_PDF_BYTES = 10 * 1024 * 1024
MAX_MESSAGES_PER_RUN = 25


def decode_mime_words(value: str | None) -> str:
    if not value:
        return ""
    pieces: list[str] = []
    for word, encoding in decode_header(value):
        if isinstance(word, bytes):
            pieces.append(word.decode(encoding or "utf-8", errors="replace"))
        else:
            pieces.append(word)
    return "".join(pieces)


def _looks_encrypted_pdf(pdf_bytes: bytes) -> bool:
    """Conservatively quarantine PDFs that advertise an encryption dictionary."""

    return b"/Encrypt" in pdf_bytes


def _allowed_senders() -> set[str]:
    raw = os.getenv("IMAP_ALLOWED_SENDERS", "")
    return {
        item.strip().lower()
        for item in raw.split(",")
        if item.strip() and "@" in item
    }


def _subject_tokens() -> tuple[str, ...]:
    raw = os.getenv("IMAP_SUBJECT_CONTAINS", "")
    return tuple(item.strip().lower() for item in raw.split(",") if item.strip())


def _is_allowed_message(message) -> bool:
    sender = parseaddr(message.get("From", ""))[1].lower()
    if sender not in _allowed_senders():
        return False
    tokens = _subject_tokens()
    if not tokens:
        return True
    subject = decode_mime_words(message.get("Subject")).lower()
    return any(token in subject for token in tokens)


def _pdf_attachments(message):
    for part in message.walk():
        if part.is_multipart():
            continue
        filename = decode_mime_words(part.get_filename())
        if not filename or not filename.lower().endswith(".pdf"):
            continue
        if part.get_content_type().lower() != "application/pdf":
            continue
        payload = part.get_payload(decode=True) or b""
        if not payload or len(payload) > MAX_PDF_BYTES:
            continue
        if not payload.lstrip().startswith(b"%PDF-"):
            continue
        yield filename, payload


def _source_id(message, filename: str, payload: bytes) -> str:
    message_id = (message.get("Message-ID") or "").strip()
    digest = hashlib.sha256(payload).hexdigest()
    return hashlib.sha256(
        f"{message_id}\n{filename}\n{digest}".encode("utf-8")
    ).hexdigest()


async def scrape_vivo_email(
    *,
    ocr_extract: Callable[[bytes, str], dict] | None = None,
) -> dict:
    """Collect validated candidates without changing mailbox state or database state."""

    if not experimental_integrations_enabled():
        return disabled_result("IMAP/PDF collector").model_dump(
            mode="json", exclude_none=True
        )

    load_dotenv(override=True)
    account = os.getenv("GMAIL_EMAIL") or os.getenv("IMAP_EMAIL")
    password = (os.getenv("GMAIL_APP_PASSWORD") or os.getenv("IMAP_PASSWORD", "")).replace(
        " ", ""
    )
    allowed_senders = _allowed_senders()
    if not account or not password or not allowed_senders:
        return {
            "status": "error",
            "message": "IMAP collector requires account credentials and IMAP_ALLOWED_SENDERS.",
        }

    if ocr_extract is None:
        from ai_service import extract_invoice_data

        ocr_extract = extract_invoice_data

    server = os.getenv("IMAP_SERVER", DEFAULT_IMAP_SERVER).strip() or DEFAULT_IMAP_SERVER
    mail = None
    candidates: list[dict] = []
    encrypted_attachment_seen = False

    try:
        mail = imaplib.IMAP4_SSL(server, timeout=20)
        mail.login(account, password)
        status, _ = mail.select("inbox", readonly=True)
        if status != "OK":
            return error_result("IMAP mailbox").model_dump(mode="json", exclude_none=True)

        status, messages = mail.search(None, "UNSEEN")
        if status != "OK" or not messages or not messages[0]:
            return {
                "status": "info",
                "message": "No unread allowed invoice messages found.",
                "candidates": [],
            }

        email_ids = messages[0].split()[:MAX_MESSAGES_PER_RUN]
        for email_id in email_ids:
            # BODY.PEEK keeps collection non-destructive even if downstream OCR fails.
            fetch_status, msg_data = mail.fetch(email_id, "(BODY.PEEK[])")
            if fetch_status != "OK":
                continue

            raw_message = next(
                (
                    item[1]
                    for item in msg_data
                    if isinstance(item, tuple) and isinstance(item[1], bytes)
                ),
                None,
            )
            if raw_message is None:
                continue

            message = email.message_from_bytes(raw_message)
            if not _is_allowed_message(message):
                continue

            subject = decode_mime_words(message.get("Subject"))[:80]
            for filename, pdf_bytes in _pdf_attachments(message):
                if _looks_encrypted_pdf(pdf_bytes):
                    encrypted_attachment_seen = True
                    continue

                try:
                    ocr_result = ocr_extract(pdf_bytes, "application/pdf")
                    if ocr_result.get("status") != "success":
                        continue
                    extracted = ocr_result.get("extracted_data") or {}
                    candidate = InvoiceCandidate(
                        description=f"Fatura recebida por e-mail - {subject or 'sem assunto'}",
                        amount=extracted.get("amount"),
                        due_date=extracted.get("due_date"),
                        barcode=extracted.get("barcode"),
                    )
                except (ValidationError, ValueError, TypeError):
                    continue

                candidates.append(
                    {
                        "source_id": _source_id(message, filename, pdf_bytes),
                        "candidate": candidate.model_dump(mode="json"),
                    }
                )

        if not candidates and encrypted_attachment_seen:
            return unavailable_result("Encrypted IMAP PDF").model_dump(
                mode="json", exclude_none=True
            )
        if not candidates:
            return {
                "status": "info",
                "message": "No validated invoice PDF was produced from allowed unread messages.",
                "candidates": [],
            }
        return {
            "status": "success",
            "message": f"Collected {len(candidates)} validated invoice candidate(s) without persistence.",
            "candidates": candidates,
        }
    except Exception as exc:
        logger.warning("IMAP collector failed safely: %s", type(exc).__name__)
        return error_result("IMAP collector").model_dump(mode="json", exclude_none=True)
    finally:
        if mail is not None:
            try:
                mail.logout()
            except Exception:
                pass
