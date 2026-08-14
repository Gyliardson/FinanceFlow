from io import BytesIO
import struct
import zlib

from PIL import Image
from pypdf import PdfReader, PdfWriter
import pytest

from receipt_uploads import (
    MAX_RECEIPT_IMAGE_PIXELS,
    ReceiptValidationError,
    sanitize_receipt_for_external_processing,
    validate_receipt_upload,
)


def _image_bytes(image_format: str, *, with_exif: bool = False) -> bytes:
    image = Image.new("RGB", (8, 6), (40, 80, 120))
    output = BytesIO()
    kwargs = {}
    if with_exif:
        exif = Image.Exif()
        exif[0x010E] = "sensitive receipt metadata"
        kwargs["exif"] = exif
    image.save(output, format=image_format, **kwargs)
    return output.getvalue()


def _pdf_bytes(*, pages: int = 1, with_metadata: bool = False) -> bytes:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    if with_metadata:
        writer.add_metadata({"/Author": "Sensitive Author", "/Subject": "Private receipt"})
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def _png_with_dimensions(width: int, height: int) -> bytes:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IEND", b"")


@pytest.mark.parametrize(
    ("content", "mime_type", "extension"),
    [
        (_image_bytes("JPEG"), "image/jpeg", "jpg"),
        (_image_bytes("PNG"), "image/png", "png"),
        (_image_bytes("WEBP"), "image/webp", "webp"),
        (_pdf_bytes(), "application/pdf", "pdf"),
    ],
)
def test_supported_receipts_are_structurally_validated_and_canonicalized(
    content, mime_type, extension
):
    validated = validate_receipt_upload(content, mime_type)

    assert validated.content == content
    assert validated.mime_type == mime_type
    assert validated.extension == extension


def test_mime_parameters_are_normalized():
    validated = validate_receipt_upload(_pdf_bytes(), "application/pdf; charset=binary")
    assert validated.mime_type == "application/pdf"


@pytest.mark.parametrize("declared", [None, "", "image/png", "application/octet-stream"])
def test_spoofed_or_missing_declared_mime_is_rejected(declared):
    with pytest.raises(ReceiptValidationError, match="MIME type"):
        validate_receipt_upload(_image_bytes("JPEG"), declared)


def test_extension_or_filename_cannot_override_content_type():
    with pytest.raises(ReceiptValidationError, match="does not match"):
        validate_receipt_upload(_pdf_bytes(), "image/jpeg")


def test_unknown_content_is_rejected_even_with_allowed_declared_mime():
    with pytest.raises(ReceiptValidationError, match="not a supported"):
        validate_receipt_upload(b"not-an-image", "image/png")


def test_empty_receipt_is_rejected():
    with pytest.raises(ReceiptValidationError, match="empty"):
        validate_receipt_upload(b"", "application/pdf")


def test_oversized_receipt_is_rejected_before_parsing_or_storage():
    with pytest.raises(ReceiptValidationError, match="exceeds"):
        validate_receipt_upload(b"%PDF-" + b"x" * 20, "application/pdf", max_bytes=16)


def test_invalid_size_policy_is_rejected():
    with pytest.raises(ValueError, match="positive"):
        validate_receipt_upload(_pdf_bytes(), "application/pdf", max_bytes=0)


@pytest.mark.parametrize(
    ("content", "mime_type"),
    [
        (b"\xff\xd8\xffnot-a-jpeg", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\nnot-a-png", "image/png"),
        (b"RIFF\x08\x00\x00\x00WEBPbroken", "image/webp"),
        (b"%PDF-1.7\nnot-a-pdf", "application/pdf"),
    ],
)
def test_magic_prefix_alone_is_not_enough(content, mime_type):
    with pytest.raises(ReceiptValidationError, match="malformed|truncated"):
        validate_receipt_upload(content, mime_type)


@pytest.mark.parametrize(
    ("content", "mime_type"),
    [
        (_image_bytes("JPEG")[:-30], "image/jpeg"),
        (_image_bytes("PNG")[:32], "image/png"),
        (_image_bytes("WEBP")[:24], "image/webp"),
        (_pdf_bytes()[:-20], "application/pdf"),
    ],
)
def test_truncated_supported_documents_are_rejected(content, mime_type):
    with pytest.raises(ReceiptValidationError, match="malformed|truncated"):
        validate_receipt_upload(content, mime_type)


def test_image_pixel_budget_rejects_decompression_resource_abuse_before_decode():
    width = 5001
    height = (MAX_RECEIPT_IMAGE_PIXELS // width) + 1
    content = _png_with_dimensions(width, height)

    with pytest.raises(ReceiptValidationError, match="safe processing limit"):
        validate_receipt_upload(content, "image/png")


def test_ocr_image_sanitization_removes_exif_while_storage_bytes_remain_original():
    original = _image_bytes("JPEG", with_exif=True)
    validated = validate_receipt_upload(original, "image/jpeg")
    sanitized = sanitize_receipt_for_external_processing(validated)

    assert validated.content == original
    assert sanitized != original
    with Image.open(BytesIO(original)) as source:
        assert source.getexif().get(0x010E) == "sensitive receipt metadata"
    with Image.open(BytesIO(sanitized)) as cleaned:
        assert cleaned.getexif().get(0x010E) is None
        assert cleaned.size == (8, 6)


def test_ocr_pdf_sanitization_removes_document_metadata_and_preserves_pages():
    original = _pdf_bytes(pages=2, with_metadata=True)
    validated = validate_receipt_upload(original, "application/pdf")
    sanitized = sanitize_receipt_for_external_processing(validated)

    original_reader = PdfReader(BytesIO(original))
    cleaned_reader = PdfReader(BytesIO(sanitized))
    assert original_reader.metadata.author == "Sensitive Author"
    assert cleaned_reader.metadata.author is None
    assert len(cleaned_reader.pages) == 2
