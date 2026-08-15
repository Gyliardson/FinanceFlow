from io import BytesIO

from pypdf import PdfReader, PdfWriter

import dasmei_scraper
from dasmei_scraper import _prepare_pdf_for_external_ocr


def _pdf_with_metadata() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata(
        {
            "/Title": "Synthetic DAS private title",
            "/Author": "Synthetic taxpayer",
            "/Subject": "Must not cross the OCR boundary",
        }
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def test_magic_prefix_only_pdf_is_rejected_before_external_ocr():
    assert _prepare_pdf_for_external_ocr(b"%PDF-1.7\nnot-valid") is None


def test_provider_copy_is_valid_and_source_metadata_is_removed():
    original = _pdf_with_metadata()
    provider_copy = _prepare_pdf_for_external_ocr(original)

    assert provider_copy is not None
    assert provider_copy != original
    reader = PdfReader(BytesIO(provider_copy), strict=True)
    assert len(reader.pages) == 1
    metadata = reader.metadata or {}
    assert metadata.get("/Title") != "Synthetic DAS private title"
    assert metadata.get("/Author") != "Synthetic taxpayer"
    assert metadata.get("/Subject") != "Must not cross the OCR boundary"


def test_sanitizer_failure_never_falls_back_to_downloaded_bytes(monkeypatch):
    original = _pdf_with_metadata()

    def fail_sanitization(_validated):
        raise RuntimeError("synthetic sanitizer failure")

    monkeypatch.setattr(
        dasmei_scraper,
        "sanitize_receipt_for_external_processing",
        fail_sanitization,
    )

    assert _prepare_pdf_for_external_ocr(original) is None
