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

def generate_financial_insights(financial_data: dict) -> dict:
    """
    Analisa os dados financeiros do usuário (saldo, sobra, metas)
    e gera um conselho de especialista com foco em Reserva de Emergência e CDB.
    """
    if not API_KEY:
        raise ValueError("Chave de API do Gemini ausente na configuração.")

    try:
        model = genai.GenerativeModel("gemini-3-flash-preview")
        
        prompt = f"""
        Atue como um consultor financeiro institucional e rigoroso.
        Abaixo está o retrato financeiro atual do usuário:
        
        - Saldo Atual Real: R$ {financial_data.get('current_balance', 0):.2f}
        - Sobra Estimada (após contas pendentes do mês): R$ {financial_data.get('estimated_surplus', 0):.2f}
        - Meta da Reserva de Emergência: R$ {financial_data.get('emergency_fund_goal', 0):.2f}
        
        Regras de recomendação:
        1. A prioridade absoluta é alcançar a "Meta da Reserva de Emergência".
        2. Se o usuário ainda não tiver a segurança necessária, sugira direcionar a maior parte (ou toda) a sobra para compor a Reserva.
        3. Se a meta da Reserva estiver atingida ou excedida pelo Saldo Atual, sugira colocar a "Sobra Estimada" em investimentos de médio/longo prazo com boa rentabilidade segura, como CDBs.
        
        INSTRUÇÕES DE TOM E FORMATO (OBRIGATÓRIO):
        - Seja estritamente profissional, técnico e objetivo.
        - Não use emojis, gírias ou cumprimentos.
        - Limite a resposta a um MÁXIMO de 3 a 4 frases curtas.
        - Vá direto ao ponto matemático e consultivo.
        """
        
        response = model.generate_content(prompt)
        
        return {
            "status": "success",
            "insight": response.text.strip()
        }
        
    except Exception as e:
        logger.error(f"Erro ao gerar insight financeiro via Gemini: {str(e)}")
        return {
            "status": "error",
            "message": "Falha ao gerar o insight financeiro.",
            "details": str(e)
        }
