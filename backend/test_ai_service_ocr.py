import pytest

from ai_service import extract_invoice_data
from ocr_service import OcrProviderRateLimited, OcrProviderTimeout, OcrProviderUnavailable


class FakeProvider:
    def __init__(self, raw=None, error=None):
        self.raw = raw
        self.error = error

    def extract(self, _file_bytes: bytes, _mime_type: str) -> str:
        if self.error:
            raise self.error
        return self.raw


def test_extract_invoice_data_returns_typed_public_suggestion():
    result = extract_invoice_data(
        b"synthetic",
        "application/pdf",
        provider=FakeProvider(
            '{"amount":"19.995","due_date":"2026-08-31","barcode":"123 456","confidence":"0.93"}'
        ),
    )

    assert result == {
        "status": "success",
        "extracted_data": {
            "amount": "20.00",
            "due_date": "2026-08-31",
            "barcode": "123 456",
            "confidence": "0.93",
            "needs_manual_review": False,
        },
    }


@pytest.mark.parametrize(
    ("provider", "code"),
    [
        (FakeProvider(raw="not json"), "invalid_output"),
        (FakeProvider(error=OcrProviderTimeout("secret timeout detail")), "timeout"),
        (FakeProvider(error=OcrProviderRateLimited("secret 429 detail")), "rate_limited"),
        (FakeProvider(error=OcrProviderUnavailable("secret provider detail")), "provider_unavailable"),
        (FakeProvider(error=RuntimeError("secret unexpected detail")), "provider_unavailable"),
    ],
)
def test_extract_invoice_data_returns_stable_error_without_provider_details(provider, code, caplog):
    result = extract_invoice_data(b"synthetic", "image/png", provider=provider)

    assert result["status"] == "error"
    assert result["error_code"] == code
    assert "details" not in result
    serialized = str(result) + caplog.text
    assert "secret timeout detail" not in serialized
    assert "secret 429 detail" not in serialized
    assert "secret provider detail" not in serialized
    assert "secret unexpected detail" not in serialized
