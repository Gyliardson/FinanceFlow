import asyncio
import threading
from types import SimpleNamespace

import ai_service
import insights_routes
import secure_ocr_routes


class _FakeGenAiClient:
    def __init__(self, *, api_key, http_options, response_text):
        self.api_key = api_key
        self.http_options = http_options
        self.models = self
        self._response_text = response_text

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def generate_content(self, **_kwargs):
        return SimpleNamespace(text=self._response_text)


def test_production_genai_clients_use_financeflow_owned_request_deadlines(monkeypatch):
    created = []

    def fake_client(*, api_key, http_options):
        response_text = (
            '{"amount":null,"due_date":null,"barcode":null,"confidence":0.5}'
            if not created
            else "Insight sintético."
        )
        client = _FakeGenAiClient(
            api_key=api_key,
            http_options=http_options,
            response_text=response_text,
        )
        created.append(client)
        return client

    monkeypatch.setattr(ai_service.genai, "Client", fake_client)
    monkeypatch.setattr(ai_service, "API_KEY", "synthetic-insights-key")

    ocr_text = ai_service.GeminiOcrProvider(api_key="synthetic-ocr-key").extract(
        b"synthetic-document",
        "image/png",
    )
    insight = ai_service.generate_financial_insights(
        {
            "current_balance": 100,
            "estimated_surplus": 20,
            "emergency_fund_goal": 500,
        },
        explicit_user_action=True,
    )

    assert "confidence" in ocr_text
    assert insight == {"status": "success", "insight": "Insight sintético."}
    assert len(created) == 2
    assert created[0].http_options.timeout == ai_service.OCR_PROVIDER_TIMEOUT_MS
    assert created[1].http_options.timeout == ai_service.INSIGHTS_PROVIDER_TIMEOUT_MS
    assert ai_service.OCR_PROVIDER_TIMEOUT_MS == 30_000
    assert ai_service.INSIGHTS_PROVIDER_TIMEOUT_MS == 30_000


class _FakeUpload:
    content_type = "image/png"

    async def read(self, _limit):
        return b"synthetic-upload"


def test_ocr_route_runs_synchronous_provider_outside_event_loop_thread(monkeypatch):
    event_loop_thread = threading.get_ident()
    provider_threads = []

    monkeypatch.setattr(
        secure_ocr_routes,
        "validate_receipt_upload",
        lambda _content, _mime: SimpleNamespace(mime_type="image/png"),
    )
    monkeypatch.setattr(
        secure_ocr_routes,
        "sanitize_receipt_for_external_processing",
        lambda _validated: b"metadata-minimized",
    )

    def fake_extract(file_bytes, mime_type):
        provider_threads.append(threading.get_ident())
        assert file_bytes == b"metadata-minimized"
        assert mime_type == "image/png"
        return {
            "status": "success",
            "extracted_data": {
                "amount": None,
                "due_date": None,
                "barcode": None,
                "confidence": 0.5,
            },
        }

    monkeypatch.setattr(secure_ocr_routes, "extract_invoice_data", fake_extract)

    result = asyncio.run(secure_ocr_routes.upload_receipt_for_ocr(_FakeUpload()))

    assert result["ocr_result"]["confidence"] == 0.5
    assert provider_threads
    assert provider_threads[0] != event_loop_thread


class _FakeInsightsSupabase:
    def rpc(self, name, payload):
        assert name == "finance_store_insight"
        assert payload["p_insight_text"] == "Insight sintético."
        return self

    def execute(self):
        return SimpleNamespace(data={"status": "success"})


def test_insights_refresh_runs_synchronous_provider_outside_event_loop_thread(monkeypatch):
    event_loop_thread = threading.get_ident()
    provider_threads = []
    supabase = _FakeInsightsSupabase()

    monkeypatch.setattr(insights_routes, "get_supabase_client", lambda: supabase)
    monkeypatch.setattr(insights_routes, "_load_settings", lambda _client: {})
    monkeypatch.setattr(
        insights_routes,
        "_calculate_financials",
        lambda _client, _settings: {
            "current_balance": 100,
            "estimated_surplus": 20,
            "emergency_fund_goal": 500,
        },
    )

    def fake_generate(_financial_data, *, explicit_user_action):
        provider_threads.append(threading.get_ident())
        assert explicit_user_action is True
        return {"status": "success", "insight": "Insight sintético."}

    monkeypatch.setattr(insights_routes, "generate_financial_insights", fake_generate)

    result = asyncio.run(insights_routes.refresh_insights())

    assert result["data"]["insight"] == "Insight sintético."
    assert provider_threads
    assert provider_threads[0] != event_loop_thread
