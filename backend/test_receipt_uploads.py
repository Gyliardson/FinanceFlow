import pytest

from receipt_uploads import ReceiptValidationError, validate_receipt_upload


@pytest.mark.parametrize(
    ("content", "mime_type", "extension"),
    [
        (b"\xff\xd8\xffsynthetic-jpeg", "image/jpeg", "jpg"),
        (b"\x89PNG\r\n\x1a\nsynthetic-png", "image/png", "png"),
        (b"RIFF\x04\x00\x00\x00WEBPsynthetic", "image/webp", "webp"),
        (b"%PDF-1.7\nsynthetic", "application/pdf", "pdf"),
    ],
)
def test_supported_receipt_signatures_are_canonicalized(content, mime_type, extension):
    validated = validate_receipt_upload(content, mime_type)

    assert validated.content == content
    assert validated.mime_type == mime_type
    assert validated.extension == extension


def test_mime_parameters_are_normalized():
    validated = validate_receipt_upload(b"%PDF-1.7\nsynthetic", "application/pdf; charset=binary")
    assert validated.mime_type == "application/pdf"


@pytest.mark.parametrize("declared", [None, "", "image/png", "application/octet-stream"])
def test_spoofed_or_missing_declared_mime_is_rejected(declared):
    with pytest.raises(ReceiptValidationError, match="MIME type"):
        validate_receipt_upload(b"\xff\xd8\xffsynthetic-jpeg", declared)


def test_extension_or_filename_cannot_override_content_type():
    with pytest.raises(ReceiptValidationError, match="does not match"):
        validate_receipt_upload(b"%PDF-1.7\nsynthetic", "image/jpeg")


def test_unknown_content_is_rejected_even_with_allowed_declared_mime():
    with pytest.raises(ReceiptValidationError, match="not a supported"):
        validate_receipt_upload(b"not-an-image", "image/png")


def test_empty_receipt_is_rejected():
    with pytest.raises(ReceiptValidationError, match="empty"):
        validate_receipt_upload(b"", "application/pdf")


def test_oversized_receipt_is_rejected_before_storage():
    with pytest.raises(ReceiptValidationError, match="exceeds"):
        validate_receipt_upload(b"%PDF-" + b"x" * 20, "application/pdf", max_bytes=16)


def test_invalid_size_policy_is_rejected():
    with pytest.raises(ValueError, match="positive"):
        validate_receipt_upload(b"%PDF-1.7", "application/pdf", max_bytes=0)
