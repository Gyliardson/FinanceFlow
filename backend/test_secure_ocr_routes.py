import asyncio

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


def test_ocr_route_validates_bytes_and_returns_manual_review_suggestion(monkeypatch):
    content = b"%PDF-1.7\nsynthetic"
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
    assert calls == [(content, "application/pdf")]
    assert response["ocr_result"]["needs_manual_review"] is True
    assert "filename" not in response


@pytest.mark.parametrize(
    ("content", "mime"),
    [
        (b"", "application/pdf"),
        (b"not-a-real-document", "application/pdf"),
        (b"%PDF-1.7\nsynthetic", "image/png"),
        (b"%PDF-1.7" + b"x" * MAX_RECEIPT_BYTES, "application/pdf"),
    ],
)
def test_ocr_route_rejects_empty_spoofed_unsupported_or_oversized_upload(content, mime):
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
                FakeUpload(b"\x89PNG\r\n\x1a\nsynthetic", "image/png")
            )
        )

    assert captured.value.status_code == status
    assert "provider secret" not in str(captured.value.detail)
    if retry_after is None:
        assert not captured.value.headers or "Retry-After" not in captured.value.headers
    else:
        assert captured.value.headers["Retry-After"] == retry_after
