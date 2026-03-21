import os
import json
import logging
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# Configura a API de Inteligência Artificial usando a GEMINI_API_KEY
API_KEY = os.getenv("GEMINI_API_KEY")
if API_KEY:
    genai.configure(api_key=API_KEY)
else:
    logger.warning("GEMINI_API_KEY não foi encontrada no .env. A integração com IA falhará se chamada em produção.")

def extract_invoice_data(file_bytes: bytes, mime_type: str) -> dict:
    """
    Envia o comprovante (imagem ou PDF) para o modelo Gemini analisar.
    Pede ao modelo para atuar como um extrator de OCR focado em faturas.
    
    Retorna um dicionário padronizado.
    """
    if not API_KEY:
        raise ValueError("Chave de API do Gemini ausente na configuração.")

    try:
        # IMPORTANTE (Manutenção 2026+): A API do Gemini evolui constantemente. Este código usa o `gemini-3-flash-preview` como base atualizada para análise multimodal rápida.
        # Caso você esteja rodando este código no futuro e esse modelo tenha sido depreciado ou substituído,
        # consulte a documentação oficial do Google AI Studio e substitua a string abaixo pela versão 'flash' ou 'pro' mais atual.
        model = genai.GenerativeModel("gemini-3-flash-preview")
        
        prompt = """
        Atue como um sistema financeiro rigoroso de OCR. 
        Analise o documento anexo (que pode ser um boleto ou comprovante de pagamento).
        Extraia as seguintes informações e retorne EXCLUSIVAMENTE um objeto JSON válido, sem marcação markdown e sem textos adicionais:
        {
            "amount": (float) o valor do documento,
            "due_date": "YYYY-MM-DD" a data de vencimento (se for comprovante, a data do pagamento),
            "barcode": (string) a linha digitável ou código de barras
        }
        Se alguma dessas informações não puder ser lida ou for inexistente, defina o campo como nulo (null).
        """
        
        # Envia a instrução de prompt e o binário do arquivo na mesma call
        response = model.generate_content([
            prompt,
            {"mime_type": mime_type, "data": file_bytes}
        ])
        
        # Fazendo o parse do texto recebido como JSON puro
        # O modelo pode eventualmente devolver bordas de markdown (```json ... ```) então limpamos
        cleaned_response = response.text.replace("```json", "").replace("```", "").strip()
        data = json.loads(cleaned_response)
        
        return {
            "status": "success",
            "extracted_data": data
        }
        
    except Exception as e:
        logger.error(f"Erro na extração de OCR via Gemini: {str(e)}")
        return {
            "status": "error",
            "message": "Falha ao processar o documento com IA.",
            "details": str(e)
        }
