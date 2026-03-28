from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
import asyncio

from database import get_supabase_client
from ai_service import extract_invoice_data
from dasmei_scraper import scrape_dasmei
from unopar_scraper import scrape_unopar
from imap_scraper import scrape_vivo_email
from tim_scraper import scrape_tim
# from scheduler import start_scheduler
from typing import Optional

@asynccontextmanager
async def lifespan(app: FastAPI):
    # O scheduler foi temporariamente desativado, junto com o scraping no Frontend.
    # scheduler_task = asyncio.create_task(start_scheduler())
    yield
    # scheduler_task.cancel()

app = FastAPI(
    title="FinanceFlow API",
    description="Backend API para automação e notificação de contas a pagar.",
    version="0.1.0",
    lifespan=lifespan
)

# CORS config to allow mobile app to consume the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restringir em produção
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class HealthResponse(BaseModel):
    status: str
    message: str

class BillCreateRequest(BaseModel):
    description: str
    amount: float
    due_date: str
    barcode: Optional[str] = None
    status: str = "pending"

class BillValidationRequest(BaseModel):
    bill_id: str
    ocr_amount: float | None = None
    ocr_due_date: str | None = None
    ocr_barcode: str | None = None

@app.get("/", tags=["Health"])
async def root():
    return {"message": "Bem-vindo à API do FinanceFlow"}

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """
    Verifica se a API está no ar.
    """
    return HealthResponse(status="ok", message="A API está operante e saudável.")

@app.get("/bills", tags=["Bills"])
async def get_bills():
    """
    Retorna as faturas cadastradas no Supabase.
    Essa rota valida a integração entre a API e o Banco.
    """
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_bills").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        # Pega qualquer erro do Supabase ou de credenciais
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/add-bill", tags=["Bills"])
async def add_bill(req: BillCreateRequest):
    """
    Cadastra uma fatura inteiramente nova extraída via OCR de celular, 
    ou simplesmente criada de modo estritamente manual pelo usuário mobile (Fase 5).
    """
    try:
        supabase = get_supabase_client()
        data = {
            "description": req.description,
            "amount": req.amount,
            "due_date": req.due_date,
            "barcode": req.barcode if req.barcode else None,
            "status": req.status
        }
        response = supabase.table("finance_bills").insert(data).execute()
        return {"status": "success", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/scrape/dasmei", tags=["Scraping"])
async def trigger_dasmei_scraping():
    """
    Aciona a rotina Playwright para buscar faturas pendentes do MEI
    usando a variável TARGET_CNPJ.
    """
    try:
        from datetime import datetime
        supabase = get_supabase_client()
        
        # A cobrança do MEI (que vence no mês atual) refere-se sempre ao mês anterior (Competência)
        now = datetime.now()
        if now.month == 1:
            target_month = 12
            target_year = now.year - 1
        else:
            target_month = now.month - 1
            target_year = now.year
            
        current_month_label = f"Guia DAS MEI - {target_month:02d}/{target_year}"
        
        # Impede redundância verificando se já buscamos a guia neste mês
        existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
        if existing.data:
            return {
                "status": "info",
                "message": f"A {current_month_label} já foi extraída anteriormente e consta no banco de dados."
            }

        resultado = await scrape_dasmei()
        if resultado.get("status") == "error":
            raise HTTPException(status_code=400, detail=resultado.get("message"))
            
        data = {
            "description": resultado.get("description", current_month_label),
            "amount": resultado.get("amount"),
            "due_date": resultado.get("due_date"),
            "barcode": resultado.get("barcode"),
            "status": "pending"
        }
        db_response = supabase.table("finance_bills").insert(data).execute()
        
        return {
            "status": "success", 
            "message": resultado.get("message"),
            "bill_data": db_response.data
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro interno de scraping: {str(e)}")

@app.post("/scrape/unopar", tags=["Scraping"])
async def trigger_unopar_scraping():
    """
    Aciona a rotina Playwright para buscar boletos pendentes da faculdade Unopar
    usando as credenciais do .env.
    """
    try:
        from datetime import datetime
        supabase = get_supabase_client()
        
        now = datetime.now()
        current_month_label = f"Mensalidade Unopar - {now.month:02d}/{now.year}"
        
        # Impede redundância verificando se já buscamos a guia neste mês
        existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
        if existing.data:
            return {
                "status": "info",
                "message": f"A {current_month_label} já foi extraída anteriormente e consta no banco de dados."
            }

        resultado = await scrape_unopar()
        if resultado.get("status") == "error":
            raise HTTPException(status_code=400, detail=resultado.get("message"))
            
        data = {
            "description": resultado.get("description", current_month_label),
            "amount": resultado.get("amount"),
            "due_date": resultado.get("due_date"),
            "barcode": resultado.get("barcode"),
            "status": "pending"
        }
        db_response = supabase.table("finance_bills").insert(data).execute()
        
        return {
            "status": "success", 
            "message": resultado.get("message"),
            "bill_data": db_response.data
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro interno de scraping: {str(e)}")

@app.post("/scrape/email/vivo", tags=["Scraping"])
async def trigger_vivo_email_scraping():
    """
    Aciona a rotina IMAP para buscar faturas na conta de E-mail configurada no .env.
    Lê os não lidos, baixa e descriptografa PDFs (usando os 4 primeiros digitos do CNPJ),
    extrai via Gemini e insere no Supabase.
    """
    resultado = await scrape_vivo_email()
    if resultado.get("status") == "error":
        raise HTTPException(status_code=400, detail=resultado.get("message"))
    return resultado

@app.post("/scrape/tim", tags=["Scraping"])
async def trigger_tim_scraping():
    """
    Aciona a rotina Playwright para buscar faturas pendentes do plano TIM Movel
    usando as credenciais do .env.
    """
    try:
        from datetime import datetime
        supabase = get_supabase_client()

        now = datetime.now()
        current_month_label = f"Conta TIM Movel - {now.month:02d}/{now.year}"

        # Impede redundancia verificando se ja buscamos a conta neste mes
        existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
        if existing.data:
            return {
                "status": "info",
                "message": f"A {current_month_label} ja foi extraida anteriormente e consta no banco de dados."
            }

        resultado = await scrape_tim()

        # Cenario "contas pagas": repassa direto sem inserir no banco
        if resultado.get("status") == "info":
            return resultado

        if resultado.get("status") == "error":
            raise HTTPException(status_code=400, detail=resultado.get("message"))

        data = {
            "description": resultado.get("description", current_month_label),
            "amount": resultado.get("amount"),
            "due_date": resultado.get("due_date"),
            "barcode": resultado.get("barcode"),
            "status": "pending"
        }
        db_response = supabase.table("finance_bills").insert(data).execute()

        return {
            "status": "success",
            "message": resultado.get("message"),
            "bill_data": db_response.data
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro interno de scraping TIM: {str(e)}")

@app.post("/upload-receipt", tags=["Bills", "OCR"])
async def upload_receipt(file: UploadFile = File(...)):
    """
    Recebe um arquivo de imagem ou PDF e envia para a Inteligência Artificial
    realizar o OCR, extraindo valor, data e linha digitável.
    """
    # Validações primárias de segurança
    allowed_types = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Formato de arquivo não suportado. Envie imagens ou PDF.")
    
    try:
        # Ler conteúdo binário do arquivo na memória
        file_bytes = await file.read()
        
        # Repassa o trabalho pesado de IA para o ai_service
        resultado_ocr = extract_invoice_data(file_bytes, mime_type=file.content_type)
        
        if resultado_ocr.get("status") == "error":
            error_details = resultado_ocr.get("details", "Sem detalhes adicionais")
            raise HTTPException(status_code=500, detail=f"{resultado_ocr.get('message')} Erro Técnico: {error_details}")
            
        return {
            "message": "Arquivo processado com sucesso.",
            "filename": file.filename,
            "ocr_result": resultado_ocr["extracted_data"]
        }
        
    except ValueError as ve:
        # Dispara quando a API não está configurada no backend
        raise HTTPException(status_code=500, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro no processamento do arquivo: {str(e)}")

@app.post("/validate-bill", tags=["Bills", "Validation"])
async def validate_bill(req: BillValidationRequest):
    """
    Realiza a validação heurística cruzando os dados extraídos do OCR 
    com os registros oficiais de faturas pendentes no banco de dados (Supabase).
    """
    try:
        supabase = get_supabase_client()
        # Busca o boleto original e fidedigno no banco
        response = supabase.table("finance_bills").select("*").eq("id", req.bill_id).execute()
        
        if not response.data:
            raise HTTPException(status_code=404, detail="Boleto não encontrado no sistema do FinanceFlow.")
            
        bill = response.data[0]
        
        # --- Motor Base de Validação Heurística ---
        is_amount_valid = False
        if req.ocr_amount is not None:
            # Tolerância de 5% sob o valor cheio base para abranger pagamentos com juros pequenos simulados
            val_diff = abs(float(bill["amount"]) - req.ocr_amount)
            if val_diff <= float(bill["amount"]) * 0.05:
                is_amount_valid = True
                
        is_date_valid = False
        if req.ocr_due_date is not None and bill.get("due_date"):
            if req.ocr_due_date == str(bill["due_date"]):
                is_date_valid = True
                
        is_barcode_valid = False
        if req.ocr_barcode and bill.get("barcode"):
            # Limpa as strings removendo traços e espaços que OCRs podem adicionar por alucinação visual
            clean_ocr = "".join(filter(str.isdigit, req.ocr_barcode))
            clean_db = "".join(filter(str.isdigit, str(bill["barcode"])))
            if clean_ocr == clean_db and len(clean_ocr) > 0:
                is_barcode_valid = True
                
        # O Score define se o comprovante cobriu as margens estritas o suficiente para ser considerado pago.
        confidence_score = 0
        if is_amount_valid: confidence_score += 40
        if is_date_valid: confidence_score += 30
        if is_barcode_valid: confidence_score += 30
            
        # Limiar de aprovação
        is_approved = confidence_score >= 60

        return {
            "status": "success",
            "bill_id": req.bill_id,
            "confidence_score": confidence_score,
            "is_approved": is_approved,
            "details": {
                "amount_match": is_amount_valid,
                "date_match": is_date_valid,
                "barcode_match": is_barcode_valid
            }
        }
    except HTTPException:
        # Preserva HTTPExceptions lançadas ativamente
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
