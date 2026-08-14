import json
from decimal import Decimal

import pytest

from ocr_service import (
    OcrInvalidOutput,
    OcrProviderRateLimited,
    OcrProviderTimeout,
    OcrProviderUnavailable,
    extract_with_provider,
    parse_ocr_output,
)


class FakeProvider:
    def __init__(self, raw=None, error=None):
        self.raw = raw
        self.error = error
        self.calls = []

    def extract(self, file_bytes: bytes, mime_type: str) -> str:
        self.calls.append((file_bytes, mime_type))
        if self.error:
            raise self.error
        return self.raw


def test_valid_output_uses_exact_money_and_no_manual_review():
    result = parse_ocr_output(json.dumps({
        "amount": "123.455",
        "due_date": "2026-08-31",
        "barcode": " 1234  5678 ",
        "confidence": "0.95",
    }))

    assert result.amount == Decimal("123.46")
    assert result.due_date.isoformat() == "2026-08-31"
    assert result.barcode == "1234 5678"
    assert result.confidence == Decimal("0.95")
    assert result.needs_manual_review is False
    assert result.to_public_dict() == {
        "amount": "123.46",
        "due_date": "2026-08-31",
        "barcode": "1234 5678",
        "confidence": "0.95",
        "needs_manual_review": False,
    }


def test_exact_json_fence_is_tolerated_but_extra_prose_is_rejected():
    fenced = parse_ocr_output('```json\n{"amount":"0.10","due_date":null,"barcode":null,"confidence":"0.90"}\n```')
    assert fenced.amount == Decimal("0.10")

    with pytest.raises(OcrInvalidOutput):
        parse_ocr_output('Result: {"amount":"0.10","due_date":null,"barcode":null}')


@pytest.mark.parametrize("raw", ["", "not-json", "[]", '{"amount": 10, "extra": "unexpected"}'])
def test_malformed_or_unsupported_output_fails_closed(raw):
    with pytest.raises(OcrInvalidOutput):
        parse_ocr_output(raw)


@pytest.mark.parametrize(
    "payload",
    [
        {"amount": True},
        {"amount": -1},
        {"amount": "1000000.01"},
        {"amount": {"value": 10}},
        {"due_date": 20260831},
        {"due_date": "2026-02-30"},
        {"due_date": "2026-8-1"},
        {"barcode": 123456},
        {"barcode": "x" * 256},
        {"confidence": True},
        {"confidence": "1.01"},
        {"confidence": "NaN"},
    ],
)
def test_wrong_financial_field_types_and_ranges_fail_closed(payload):
    with pytest.raises(OcrInvalidOutput):
        parse_ocr_output(json.dumps(payload))


def test_unreadable_and_low_confidence_outputs_require_manual_review():
    unreadable = parse_ocr_output('{"amount":null,"due_date":null,"barcode":null,"confidence":"0.90"}')
    low_confidence = parse_ocr_output('{"amount":"42.00","due_date":null,"barcode":null,"confidence":"0.40"}')
    missing_confidence = parse_ocr_output('{"amount":"42.00","due_date":null,"barcode":null}')

    assert unreadable.needs_manual_review is True
    assert low_confidence.needs_manual_review is True
    assert missing_confidence.needs_manual_review is True


def test_provider_is_injected_and_receives_only_validated_call_inputs():
    provider = FakeProvider('{"amount":"0.30","due_date":"2026-12-31","barcode":null,"confidence":"1"}')
    result = extract_with_provider(provider, b"synthetic-document", "application/pdf")

    assert provider.calls == [(b"synthetic-document", "application/pdf")]
    assert result.amount == Decimal("0.30")


@pytest.mark.parametrize(
    "error",
    [OcrProviderTimeout(), OcrProviderRateLimited(), OcrProviderUnavailable()],
)
def test_provider_failures_propagate_as_stable_typed_categories(error):
    provider = FakeProvider(error=error)
    with pytest.raises(type(error)):
        extract_with_provider(provider, b"synthetic", "image/png")
