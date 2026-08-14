import asyncio
from io import BytesIO

from PIL import Image
from pypdf import PdfWriter
import pytest
from fastapi import HTTPException

import secure_ocr_routes
from receipt_uploads import MAX_RECEIPT_BYTES


class FakeUpload:
    def __init__(self, content: bytes, content_type: str | None):
        self.content = content
        self.content_type = content_type
        self.read_sizes = []

    async def read(self, size=-1):
        self.read_sizes.append(size)
        return self.content[:size] if size >= 0 else self.content


def _pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _png_bytes() -> bytes:
    output = BytesIO()
    Image.new("RGB", (8, 8), (20, 40, 60)).save(output, format="PNG")
    return output.getvalue()


def _jpeg_with_exif() -> bytes:
    output = BytesIO()
    image = Image.new("RGB", (8, 8), (20, 40, 60))
    exif = Image.Exif()
    exif[0x010E] = "private metadata"
    image.save(output, format="JPEG", exif=exif)
    return output.getvalue()


def test_ocr_route_validates_bytes_and_returns_manual_review_suggestion(monkeypatch):
    content = _pdf_bytes()
    upload = FakeUpload(content, "application/pdf")
    calls = []

    def fake_extract(file_bytes, mime_type):
        calls.append((file_bytes, mime_type))
        return {
            "status": "success",
            "extracted_data": {
                "amount": "10.00",
                "due_date": None,
                "barcode": None,
                "confidence": "0.45",
                "needs_manual_review": True,
            },
        }

    monkeypatch.setattr(secure_ocr_routes, "extract_invoice_data", fake_extract)
    response = asyncio.run(secure_ocr_routes.upload_receipt_for_ocr(upload))

    assert upload.read_sizes == [MAX_RECEIPT_BYTES + 1]
    assert len(calls) == 1
    assert calls[0][1] == "application/pdf"
    assert calls[0][0].startswith(b"%PDF-")
    assert response["ocr_result"]["needs_manual_review"] is True
    assert "filename" not in response


def test_ocr_route_strips_image_metadata_before_provider_call(monkeypatch):
    original = _jpeg_with_exif()
    calls = []

    def fake_extract(file_bytes, mime_type):
        calls.append((file_bytes, mime_type))
        return {
            "status": "success",
            "extracted_data": {
                "amount": None,
                "due_date": None,
                "barcode": None,
                "confidence": None,
                "needs_manual_review": True,
            },
        }

    monkeypatch.setattr(secure_ocr_routes, "extract_invoice_data", fake_extract)
    asyncio.run(
        secure_ocr_routes.upload_receipt_for_ocr(FakeUpload(original, "image/jpeg"))
    )

    assert len(calls) == 1
    provider_bytes, mime_type = calls[0]
    assert mime_type == "image/jpeg"
    assert provider_bytes != original
    with Image.open(BytesIO(provider_bytes)) as provider_image:
        assert provider_image.getexif().get(0x010E) is None


@pytest.mark.parametrize(
    ("content", "mime"),
    [
        (b"", "application/pdf"),
        (b"not-a-real-document", "application/pdf"),
        (b"%PDF-1.7\nnot-structurally-valid", "application/pdf"),
        (_pdf_bytes(), "image/png"),
        (b"%PDF-1.7" + b"x" * MAX_RECEIPT_BYTES, "application/pdf"),
    ],
)
def test_ocr_route_rejects_empty_spoofed_malformed_or_oversized_upload(content, mime):
    with pytest.raises(HTTPException) as captured:
        asyncio.run(secure_ocr_routes.upload_receipt_for_ocr(FakeUpload(content, mime)))
    assert captured.value.status_code == 400


@pytest.mark.parametrize(
    ("code", "status", "retry_after"),
    [
        ("invalid_output", 422, None),
        ("rate_limited", 503, "60"),
        ("timeout", 504, None),
        ("provider_unavailable", 503, None),
    ],
)
def test_ocr_route_maps_provider_failures_without_technical_details(
    monkeypatch, code, status, retry_after
):
    monkeypatch.setattr(
        secure_ocr_routes,
        "extract_invoice_data",
        lambda *_args, **_kwargs: {
            "status": "error",
            "error_code": code,
            "message": "provider secret detail must not escape",
        },
    )

    with pytest.raises(HTTPException) as captured:
        asyncio.run(
            secure_ocr_routes.upload_receipt_for_ocr(
                FakeUpload(_png_bytes(), "image/png")
            )
        )

    assert captured.value.status_code == status
    assert "provider secret" not in str(captured.value.detail)
    if retry_after is None:
        assert not captured.value.headers or "Retry-After" not in captured.value.headers
    else:
        assert captured.value.headers["Retry-After"] == retry_after
