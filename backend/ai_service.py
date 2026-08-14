import logging
import os

import google.generativeai as genai
from dotenv import load_dotenv

from ocr_service import (
    OcrInvalidOutput,
    OcrProvider,
    OcrProviderRateLimited,
    OcrProviderTimeout,
    OcrProviderUnavailable,
    extract_with_provider,
)

load_dotenv()

logger = logging.getLogger(__name__)
API_KEY = os.getenv("GEMINI_API_KEY")
OCR_MODEL = "gemini-3-flash-preview"


OCR_PROMPT = """
Atue como um extrator OCR de documentos financeiros.
Retorne EXCLUSIVAMENTE um objeto JSON válido, sem texto adicional, com estas chaves:
{
  "amount": string decimal ou null,
  "due_date": "YYYY-MM-DD" ou null,
  "barcode": string ou null,
  "confidence": número entre 0 e 1 ou null
}
Nunca invente campos ilegíveis. Quando houver dúvida relevante, use null e reduza confidence.
""".strip()


class GeminiOcrProvider:
    """Production OCR adapter. Provider responses remain untrusted until parsed."""

    def __init__(self, api_key: str | None = None, model_name: str = OCR_MODEL):
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.model_name = model_name

    def extract(self, file_bytes: bytes, mime_type: str) -> str:
        if not self.api_key:
            raise OcrProviderUnavailable("OCR provider is not configured")

        try:
            genai.configure(api_key=self.api_key)
            model = genai.GenerativeModel(self.model_name)
            response = model.generate_content(
                [OCR_PROMPT, {"mime_type": mime_type, "data": file_bytes}]
            )
            text = getattr(response, "text", None)
            if not isinstance(text, str) or not text.strip():
                raise OcrInvalidOutput("OCR provider returned no text")
            return text
        except OcrInvalidOutput:
            raise
        except TimeoutError as exc:
            raise OcrProviderTimeout("OCR provider timed out") from exc
        except Exception as exc:
            status = getattr(exc, "status_code", None) or getattr(exc, "code", None)
            if status == 429 or str(status) == "429":
                raise OcrProviderRateLimited("OCR provider rate limited the request") from exc
            if "timeout" in type(exc).__name__.lower():
                raise OcrProviderTimeout("OCR provider timed out") from exc
            raise OcrProviderUnavailable("OCR provider is unavailable") from exc


def extract_invoice_data(
    file_bytes: bytes,
    mime_type: str,
    *,
    provider: OcrProvider | None = None,
) -> dict:
    """Return validated OCR suggestions without exposing provider internals."""
    active_provider = provider or GeminiOcrProvider()
    try:
        extraction = extract_with_provider(active_provider, file_bytes, mime_type)
        return {
            "status": "success",
            "extracted_data": extraction.to_public_dict(),
        }
    except OcrInvalidOutput:
        logger.warning("OCR provider returned invalid structured output")
        return {
            "status": "error",
            "error_code": "invalid_output",
            "message": "O documento não pôde ser interpretado com segurança.",
        }
    except OcrProviderTimeout:
        logger.warning("OCR provider timed out")
        return {
            "status": "error",
            "error_code": "timeout",
            "message": "O serviço de OCR excedeu o tempo de resposta.",
        }
    except OcrProviderRateLimited:
        logger.warning("OCR provider rate limited a request")
        return {
            "status": "error",
            "error_code": "rate_limited",
            "message": "O serviço de OCR está temporariamente ocupado.",
        }
    except OcrProviderUnavailable:
        logger.warning("OCR provider is unavailable")
        return {
            "status": "error",
            "error_code": "provider_unavailable",
            "message": "O serviço de OCR está temporariamente indisponível.",
        }


def generate_financial_insights(financial_data: dict) -> dict:
    """Generate concise financial guidance. This is separate from the OCR boundary."""
    if not API_KEY:
        raise ValueError("Chave de API do Gemini ausente na configuração.")

    try:
        model = genai.GenerativeModel(OCR_MODEL)
        prompt = f"""
        Atue como um consultor financeiro institucional e rigoroso.
        Abaixo está o retrato financeiro atual do usuário:

        - Saldo Atual Real: R$ {financial_data.get('current_balance', 0):.2f}
        - Sobra Estimada (após contas pendentes do mês): R$ {financial_data.get('estimated_surplus', 0):.2f}
        - Meta da Reserva de Emergência: R$ {financial_data.get('emergency_fund_goal', 0):.2f}

        Regras de recomendação:
        1. A prioridade absoluta é alcançar a Meta da Reserva de Emergência.
        2. Se o usuário ainda não tiver a segurança necessária, sugira direcionar a maior parte da sobra para a Reserva.
        3. Se a meta estiver atingida ou excedida, sugira alternativas conservadoras de médio/longo prazo.

        Seja profissional, técnico e objetivo. Não use emojis, gírias ou cumprimentos.
        Limite a resposta a 3 ou 4 frases curtas.
        """
        response = model.generate_content(prompt)
        return {"status": "success", "insight": response.text.strip()}
    except Exception:
        logger.error("Financial insight provider failed")
        return {
            "status": "error",
            "message": "Falha ao gerar o insight financeiro.",
        }
