from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError

MAX_RECEIPT_BYTES = 10 * 1024 * 1024
MAX_RECEIPT_IMAGE_PIXELS = 25_000_000
MAX_RECEIPT_PDF_PAGES = 25


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


def _validate_image_structure(content: bytes, mime_type: str) -> None:
    expected_format = {
        "image/jpeg": "JPEG",
        "image/png": "PNG",
        "image/webp": "WEBP",
    }[mime_type]

    try:
        with Image.open(BytesIO(content)) as image:
            if image.format != expected_format:
                raise ReceiptValidationError("Receipt image encoding does not match its signature.")
            width, height = image.size
            if width <= 0 or height <= 0:
                raise ReceiptValidationError("Receipt image dimensions are invalid.")
            if width * height > MAX_RECEIPT_IMAGE_PIXELS:
                raise ReceiptValidationError("Receipt image dimensions exceed the safe processing limit.")
            image.verify()

        # Pillow's verify() intentionally does not decode pixel data. Reopen and load
        # the image so truncated/corrupt streams fail before storage/provider use.
        with Image.open(BytesIO(content)) as image:
            image.load()
    except ReceiptValidationError:
        raise
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        raise ReceiptValidationError("Receipt image is malformed, truncated, or unsafe to decode.") from exc


def _read_pdf_structure(content: bytes) -> PdfReader:
    try:
        reader = PdfReader(BytesIO(content), strict=True)
        if reader.is_encrypted:
            raise ReceiptValidationError("Encrypted receipt PDFs are not supported.")
        page_count = len(reader.pages)
        if page_count == 0:
            raise ReceiptValidationError("Receipt PDF must contain at least one page.")
        if page_count > MAX_RECEIPT_PDF_PAGES:
            raise ReceiptValidationError("Receipt PDF exceeds the allowed page count.")
        # Materialize each page object so broken page-tree references fail here.
        for page in reader.pages:
            _ = page.mediabox
        return reader
    except ReceiptValidationError:
        raise
    except (PdfReadError, OSError, ValueError, TypeError, KeyError) as exc:
        raise ReceiptValidationError("Receipt PDF is malformed or truncated.") from exc


def _validate_document_structure(content: bytes, mime_type: str) -> None:
    if mime_type == "application/pdf":
        _read_pdf_structure(content)
    else:
        _validate_image_structure(content, mime_type)


def validate_receipt_upload(
    content: bytes,
    declared_mime_type: str | None,
    *,
    max_bytes: int = MAX_RECEIPT_BYTES,
) -> ValidatedReceipt:
    """Validate financial-document bytes independently of user-controlled filename.

    The declared MIME type must agree with the file signature. Supported images
    must fully decode inside a bounded pixel budget, and PDFs must parse with a
    bounded page count. Object extensions derive from validated content, never
    from the uploaded filename.
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

    _validate_document_structure(content, detected_mime)
    return ValidatedReceipt(content=content, mime_type=detected_mime, extension=extension)


def sanitize_receipt_for_external_processing(receipt: ValidatedReceipt) -> bytes:
    """Return structurally equivalent bytes with unnecessary metadata removed.

    This transformation is for third-party OCR only. Private receipt storage may
    retain the user's original validated bytes; external processing receives a
    normalized representation without EXIF/XMP/document metadata where practical.
    """
    if receipt.mime_type == "application/pdf":
        reader = _read_pdf_structure(receipt.content)
        writer = PdfWriter()
        for page in reader.pages:
            writer.add_page(page)
        output = BytesIO()
        writer.write(output)
        return output.getvalue()

    try:
        with Image.open(BytesIO(receipt.content)) as source:
            normalized = ImageOps.exif_transpose(source)
            normalized.load()
            output = BytesIO()

            if receipt.mime_type == "image/jpeg":
                if normalized.mode not in ("RGB", "L"):
                    normalized = normalized.convert("RGB")
                normalized.save(output, format="JPEG", quality=95)
            elif receipt.mime_type == "image/png":
                normalized.save(output, format="PNG")
            else:
                if normalized.mode not in ("RGB", "RGBA"):
                    normalized = normalized.convert("RGBA" if "A" in normalized.getbands() else "RGB")
                normalized.save(output, format="WEBP", lossless=True)

            return output.getvalue()
    except (Image.DecompressionBombError, UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        # Validation already decoded these bytes. Treat any later normalization
        # failure as a closed boundary instead of forwarding the original bytes.
        raise ReceiptValidationError("Receipt metadata could not be sanitized safely.") from exc
