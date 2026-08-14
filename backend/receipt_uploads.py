from dataclasses import dataclass

MAX_RECEIPT_BYTES = 10 * 1024 * 1024


class ReceiptValidationError(ValueError):
    """Raised when an uploaded receipt is not a supported, bounded document."""


@dataclass(frozen=True)
class ValidatedReceipt:
    content: bytes
    mime_type: str
    extension: str


def _detect_receipt_type(content: bytes) -> tuple[str, str] | None:
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", "jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", "png"
    if content.startswith(b"RIFF") and len(content) >= 12 and content[8:12] == b"WEBP":
        return "image/webp", "webp"
    if content.startswith(b"%PDF-"):
        return "application/pdf", "pdf"
    return None


def validate_receipt_upload(
    content: bytes,
    declared_mime_type: str | None,
    *,
    max_bytes: int = MAX_RECEIPT_BYTES,
) -> ValidatedReceipt:
    """Validate financial-document bytes independently of user-controlled filename.

    The declared MIME type must agree with the file signature. Object extensions
    are derived from validated content, never from the uploaded filename.
    """
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive.")
    if not content:
        raise ReceiptValidationError("Receipt file is empty.")
    if len(content) > max_bytes:
        raise ReceiptValidationError("Receipt file exceeds the allowed size.")

    detected = _detect_receipt_type(content)
    if detected is None:
        raise ReceiptValidationError("Receipt content is not a supported image or PDF.")

    detected_mime, extension = detected
    normalized_declared = (declared_mime_type or "").split(";", 1)[0].strip().lower()
    if normalized_declared != detected_mime:
        raise ReceiptValidationError("Declared receipt MIME type does not match file content.")

    return ValidatedReceipt(content=content, mime_type=detected_mime, extension=extension)
