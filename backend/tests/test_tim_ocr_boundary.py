from io import BytesIO

from PIL import Image, PngImagePlugin

import tim_scraper


def _png_with_metadata() -> bytes:
    output = BytesIO()
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("private-context", "authenticated-financial-portal")
    Image.new("RGB", (4, 4), (10, 20, 30)).save(output, format="PNG", pnginfo=metadata)
    return output.getvalue()


def test_tim_provider_copy_is_valid_png_and_strips_source_metadata():
    original = _png_with_metadata()

    prepared = tim_scraper._prepare_screenshot_for_external_ocr(original)

    assert prepared is not None
    assert prepared != original
    with Image.open(BytesIO(prepared)) as image:
        image.load()
        assert image.format == "PNG"
        assert "private-context" not in image.info
        assert image.size == (4, 4)


def test_tim_provider_preparation_fails_closed_for_invalid_screenshot(monkeypatch):
    provider_calls = []

    def should_not_be_used(*args, **kwargs):
        provider_calls.append((args, kwargs))
        return b"unexpected"

    monkeypatch.setattr(tim_scraper, "sanitize_receipt_for_external_processing", should_not_be_used)

    prepared = tim_scraper._prepare_screenshot_for_external_ocr(b"not-a-png")

    assert prepared is None
    assert provider_calls == []


def test_tim_provider_preparation_fails_closed_when_sanitizer_fails(monkeypatch):
    original = _png_with_metadata()

    def fail_sanitization(_validated):
        raise RuntimeError("synthetic sanitizer failure")

    monkeypatch.setattr(tim_scraper, "sanitize_receipt_for_external_processing", fail_sanitization)

    assert tim_scraper._prepare_screenshot_for_external_ocr(original) is None
