import pytest

import ai_service
from ai_service import GeminiOcrProvider, extract_invoice_data, generate_financial_insights
from ocr_service import OcrProviderRateLimited, OcrProviderTimeout, OcrProviderUnavailable


class FakeProvider:
    def __init__(self, raw=None, error=None):
        self.raw = raw
        self.error = error

    def extract(self, _file_bytes: bytes, _mime_type: str) -> str:
        if self.error:
            raise self.error
        return self.raw


class FakeGenAiClient:
    def __init__(self, *, api_key, response_text='{"amount":null,"due_date":null,"barcode":null,"confidence":"1"}', error=None):
        self.api_key = api_key
        self.response_text = response_text
        self.error = error
        self.models = self
        self.calls = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        self.closed = True

    def generate_content(self, *, model, contents, config=None):
        self.calls.append((model, contents, config))
        if self.error:
            raise self.error
        return type("FakeResponse", (), {"text": self.response_text})()


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


def test_gemini_adapter_uses_maintained_client_multimodal_part_and_schema(monkeypatch):
    clients = []

    def fake_client(*, api_key):
        client = FakeGenAiClient(api_key=api_key)
        clients.append(client)
        return client

    monkeypatch.setattr(ai_service.genai, "Client", fake_client)
    provider = GeminiOcrProvider(api_key="synthetic-key")

    raw = provider.extract(b"synthetic-pdf", "application/pdf")

    assert raw.startswith("{")
    assert len(clients) == 1
    assert clients[0].api_key == "synthetic-key"
    assert clients[0].closed is True
    assert len(clients[0].calls) == 1
    model, contents, config = clients[0].calls[0]
    assert model == "gemini-3.6-flash"
    assert contents[0] == ai_service.OCR_PROMPT
    assert len(contents) == 2
    assert config == {
        "response_format": {
            "text": {
                "mime_type": "application/json",
                "schema": ai_service.OCR_RESPONSE_SCHEMA,
            }
        }
    }


def test_gemini_adapter_maps_provider_429_without_detail_leak(monkeypatch):
    rate_limit = type("SyntheticRateLimit", (Exception,), {"code": 429})("secret provider detail")

    def fake_client(*, api_key):
        return FakeGenAiClient(api_key=api_key, error=rate_limit)

    monkeypatch.setattr(ai_service.genai, "Client", fake_client)
    provider = GeminiOcrProvider(api_key="synthetic-key")

    with pytest.raises(OcrProviderRateLimited) as captured:
        provider.extract(b"synthetic-image", "image/png")

    assert "secret provider detail" not in str(captured.value)


def test_financial_insights_use_maintained_client_without_real_provider(monkeypatch):
    clients = []

    def fake_client(*, api_key):
        client = FakeGenAiClient(api_key=api_key, response_text="Recomendação sintética segura.")
        clients.append(client)
        return client

    monkeypatch.setattr(ai_service, "API_KEY", "synthetic-key")
    monkeypatch.setattr(ai_service.genai, "Client", fake_client)

    result = generate_financial_insights(
        {
            "current_balance": 100,
            "estimated_surplus": 25,
            "emergency_fund_goal": 500,
            "emergency_fund_balance": 123,
            "raw_bills": [{"description": "must-not-leak"}],
        },
        explicit_user_action=True,
    )

    assert result == {"status": "success", "insight": "Recomendação sintética segura."}
    assert clients[0].closed is True
    model, contents, config = clients[0].calls[0]
    assert model == "gemini-3.6-flash"
    assert config is None
    assert "100.00" in contents
    assert "25.00" in contents
    assert "500.00" in contents
    assert "123" not in contents
    assert "must-not-leak" not in contents


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
