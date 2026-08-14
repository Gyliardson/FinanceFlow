import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Protocol

from money import money, money_to_storage


MAX_OCR_AMOUNT = Decimal("1000000.00")
MAX_BARCODE_LENGTH = 255
LOW_CONFIDENCE_THRESHOLD = Decimal("0.70")


class OcrError(Exception):
    """Base class for stable OCR-layer failures."""


class OcrInvalidOutput(OcrError):
    """Provider returned output that cannot be trusted as structured data."""


class OcrProviderTimeout(OcrError):
    pass


class OcrProviderRateLimited(OcrError):
    pass


class OcrProviderUnavailable(OcrError):
    pass


class OcrProvider(Protocol):
    def extract(self, file_bytes: bytes, mime_type: str) -> str:
        """Return raw provider text. It is untrusted until parsed below."""
        ...


@dataclass(frozen=True)
class OcrExtraction:
    amount: Decimal | None
    due_date: date | None
    barcode: str | None
    confidence: Decimal | None
    needs_manual_review: bool

    def to_public_dict(self) -> dict:
        return {
            "amount": money_to_storage(self.amount) if self.amount is not None else None,
            "due_date": self.due_date.isoformat() if self.due_date is not None else None,
            "barcode": self.barcode,
            "confidence": str(self.confidence) if self.confidence is not None else None,
            "needs_manual_review": self.needs_manual_review,
        }


def _unwrap_exact_json(raw: str) -> str:
    text = raw.strip()
    if text.startswith("```json") and text.endswith("```"):
        return text[7:-3].strip()
    if text.startswith("```") and text.endswith("```"):
        return text[3:-3].strip()
    return text


def _parse_amount(value) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or isinstance(value, (dict, list)):
        raise OcrInvalidOutput("OCR amount has an invalid type.")
    try:
        parsed = money(value)
    except (ValueError, InvalidOperation, TypeError) as exc:
        raise OcrInvalidOutput("OCR amount is invalid.") from exc
    if parsed < 0 or parsed > MAX_OCR_AMOUNT:
        raise OcrInvalidOutput("OCR amount is outside the supported range.")
    return parsed


def _parse_due_date(value) -> date | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise OcrInvalidOutput("OCR due_date must be an ISO date string or null.")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise OcrInvalidOutput("OCR due_date is invalid.") from exc
    if value != parsed.isoformat():
        raise OcrInvalidOutput("OCR due_date must use YYYY-MM-DD format.")
    return parsed


def _parse_barcode(value) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise OcrInvalidOutput("OCR barcode must be a string or null.")
    normalized = " ".join(value.split())
    if not normalized:
        return None
    if len(normalized) > MAX_BARCODE_LENGTH:
        raise OcrInvalidOutput("OCR barcode exceeds the supported length.")
    if any(ord(char) < 32 for char in normalized):
        raise OcrInvalidOutput("OCR barcode contains control characters.")
    return normalized


def _parse_confidence(value) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, bool) or isinstance(value, (dict, list)):
        raise OcrInvalidOutput("OCR confidence has an invalid type.")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise OcrInvalidOutput("OCR confidence is invalid.") from exc
    if not parsed.is_finite() or parsed < 0 or parsed > 1:
        raise OcrInvalidOutput("OCR confidence must be between 0 and 1.")
    return parsed


def parse_ocr_output(raw: str) -> OcrExtraction:
    """Convert untrusted provider text into a strict financial-document suggestion."""
    if not isinstance(raw, str) or not raw.strip():
        raise OcrInvalidOutput("OCR provider returned an empty response.")

    try:
        payload = json.loads(_unwrap_exact_json(raw), parse_float=Decimal, parse_int=Decimal)
    except (json.JSONDecodeError, TypeError) as exc:
        raise OcrInvalidOutput("OCR provider did not return valid JSON.") from exc

    if not isinstance(payload, dict):
        raise OcrInvalidOutput("OCR provider output must be a JSON object.")

    allowed = {"amount", "due_date", "barcode", "confidence"}
    unknown = set(payload) - allowed
    if unknown:
        raise OcrInvalidOutput("OCR provider returned unsupported fields.")

    amount = _parse_amount(payload.get("amount"))
    due_date_value = _parse_due_date(payload.get("due_date"))
    barcode = _parse_barcode(payload.get("barcode"))
    confidence = _parse_confidence(payload.get("confidence"))

    unreadable = amount is None and due_date_value is None and barcode is None
    low_confidence = confidence is not None and confidence < LOW_CONFIDENCE_THRESHOLD
    missing_confidence = confidence is None

    return OcrExtraction(
        amount=amount,
        due_date=due_date_value,
        barcode=barcode,
        confidence=confidence,
        needs_manual_review=unreadable or low_confidence or missing_confidence,
    )


def extract_with_provider(provider: OcrProvider, file_bytes: bytes, mime_type: str) -> OcrExtraction:
    raw = provider.extract(file_bytes, mime_type)
    return parse_ocr_output(raw)
