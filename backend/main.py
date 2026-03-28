from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from contextlib import asynccontextmanager
import asyncio
import os
import uuid
import logging
from datetime import datetime, date, timedelta

from database import get_supabase_client
from ai_service import extract_invoice_data
from dasmei_scraper import scrape_dasmei
from unopar_scraper import scrape_unopar
from imap_scraper import scrape_vivo_email
from tim_scraper import scrape_tim
# from scheduler import start_scheduler
from typing import Optional

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # O scheduler foi temporariamente desativado, junto com o scraping no Frontend.
    # scheduler_task = asyncio.create_task(start_scheduler())
    yield
    # scheduler_task.cancel()

app = FastAPI(
    title="FinanceFlow API",
    description="Backend API para automação e notificação de contas a pagar.",
    version="0.2.0",
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

# ===========================================================================
# Models
# ===========================================================================

class HealthResponse(BaseModel):
    status: str
    message: str

class BillCreateRequest(BaseModel):
    description: str
    amount: float
    due_date: str
    barcode: Optional[str] = None
    status: str = "pending"

class RecurringBillCreateRequest(BaseModel):
    """Request body para criar uma conta recorrente (template)."""
    title: str
    description: Optional[str] = None
    amount: float
    recurring_day: int  # Dia do mês (1-31)
    frequency: str = "monthly"  # 'monthly', 'weekly', etc.

class BillValidationRequest(BaseModel):
    bill_id: str
    ocr_amount: Optional[float] = None
    ocr_due_date: Optional[str] = None
    ocr_barcode: Optional[str] = None

# ===========================================================================
# Health & Basic Routes
# ===========================================================================

@app.get("/", tags=["Health"])
async def root():
    return {"message": "Bem-vindo à API do FinanceFlow"}

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """Verifica se a API está no ar."""
    return HealthResponse(status="ok", message="A API está operante e saudável.")

# ===========================================================================
# Bills (CRUD)
# ===========================================================================

@app.get("/bills", tags=["Bills"])
async def get_bills():
    """
    Retorna as faturas cadastradas no Supabase. 
    Inclui tanto avulsas quanto instâncias geradas de recorrentes.
    """
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_bills").select("*").order("due_date", desc=True).execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/bills/pending", tags=["Bills"])
async def get_pending_bills():
    """
    Retorna apenas as faturas pendentes (não pagas) para a tela de conciliação.
    """
    try:
        supabase = get_supabase_client()
        response = (
            supabase.table("finance_bills")
            .select("*")
            .eq("status", "pending")
            .order("due_date", desc=False)
            .execute()
        )
        return {"data": response.data}
    except Exception as e:
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

# ===========================================================================
# Recurring Bills (Contas Recorrentes)
# ===========================================================================

@app.post("/recurring-bills", tags=["Recurring Bills"])
async def create_recurring_bill(req: RecurringBillCreateRequest):
    """
    Cria um template de conta recorrente. Não cria a instância do mês — 
    isso é feito automaticamente via /recurring-bills/generate.
    """
    if req.recurring_day < 1 or req.recurring_day > 31:
        raise HTTPException(status_code=400, detail="O dia deve estar entre 1 e 31.")
    
    try:
        supabase = get_supabase_client()
        
        # Calcula a primeira data de vencimento (próximo mês ou mês atual caso o dia ainda não tenha passado)
        today = date.today()
        try:
            first_due = date(today.year, today.month, req.recurring_day)
        except ValueError:
            # Mês não tem esse dia (ex: 31 em fevereiro): usa último dia do mês
            import calendar
            last_day = calendar.monthrange(today.year, today.month)[1]
            first_due = date(today.year, today.month, last_day)
        
        if first_due < today:
            # Se o dia já passou no mês atual, pula para o próximo mês
            if today.month == 12:
                first_due = date(today.year + 1, 1, min(req.recurring_day, 31))
            else:
                import calendar
                last_day_next = calendar.monthrange(today.year, today.month + 1)[1]
                first_due = date(today.year, today.month + 1, min(req.recurring_day, last_day_next))
        
        data = {
            "description": req.title,
            "amount": req.amount,
            "due_date": str(first_due),
            "barcode": req.description,  # Usar campo barcode para guardar a descrição extra
            "status": "pending",
            "is_recurring": True,
            "frequency": req.frequency,
            "recurring_day": req.recurring_day,
        }
        response = supabase.table("finance_bills").insert(data).execute()
        return {"status": "success", "data": response.data}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/recurring-bills", tags=["Recurring Bills"])
async def get_recurring_bills():
    """
    Retorna os templates de contas recorrentes.
    """
    try:
        supabase = get_supabase_client()
        response = (
            supabase.table("finance_bills")
            .select("*")
            .eq("is_recurring", True)
            .order("recurring_day", desc=False)
            .execute()
        )
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/recurring-bills/generate", tags=["Recurring Bills"])
async def generate_recurring_instances():
    """
    Examina todos os templates recorrentes e gera instâncias pendentes 
    para o mês atual, se ainda não existem.
    """
    try:
        supabase = get_supabase_client()
        today = date.today()
        
        # Buscar todos os templates recorrentes
        templates = (
            supabase.table("finance_bills")
            .select("*")
            .eq("is_recurring", True)
            .execute()
        )
        
        generated = []
        
        for template in templates.data:
            recurring_day = template.get("recurring_day", 1)
            
            # Calcula data de vencimento para o mês atual
            import calendar
            last_day = calendar.monthrange(today.year, today.month)[1]
            due_day = min(recurring_day, last_day)
            
            try:
                month_due = date(today.year, today.month, due_day)
            except ValueError:
                month_due = date(today.year, today.month, last_day)
            
            # Verificar se já existe instância para esse mês
            month_label = f"{template['description']} - {today.month:02d}/{today.year}"
            existing = (
                supabase.table("finance_bills")
                .select("id")
                .eq("description", month_label)
                .execute()
            )
            
            if existing.data:
                continue  # Já existe, pula
            
            # Criar instância do mês
            instance = {
                "description": month_label,
                "amount": template["amount"],
                "due_date": str(month_due),
                "status": "pending",
                "parent_bill_id": template["id"],
                "is_recurring": False,
            }
            result = supabase.table("finance_bills").insert(instance).execute()
            if result.data:
                generated.append(result.data[0])
        
        return {
            "status": "success",
            "message": f"{len(generated)} instância(s) gerada(s) para {today.month:02d}/{today.year}.",
            "generated": generated
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ===========================================================================
# Payment & Receipt (Pagamento e Comprovante)
# ===========================================================================

@app.post("/bills/{bill_id}/pay", tags=["Bills", "Payment"])
async def pay_bill(bill_id: str, file: UploadFile = File(...)):
    """
    Marca uma fatura como paga e faz upload do comprovante no Supabase Storage.
    
    1. Faz upload da imagem para o bucket 'receipts'
    2. Salva a URL no campo receipt_url
    3. Atualiza status para 'paid' e registra payment_date
    """
    try:
        supabase = get_supabase_client()
        
        # Verificar se a fatura existe
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")
        
        bill = bill_resp.data[0]
        if bill.get("status") == "paid":
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}
        
        # Upload do comprovante para o Supabase Storage
        file_bytes = await file.read()
        file_ext = file.filename.split('.')[-1] if file.filename and '.' in file.filename else 'jpg'
        storage_path = f"receipts/{bill_id}_{uuid.uuid4().hex[:8]}.{file_ext}"
        
        try:
            supabase.storage.from_("receipts").upload(
                path=storage_path,
                file=file_bytes,
                file_options={"content-type": file.content_type or "image/jpeg"}
            )
            receipt_url = supabase.storage.from_("receipts").get_public_url(storage_path)
        except Exception as storage_err:
            logger.warning(f"Falha ao fazer upload do comprovante: {storage_err}. Salvando sem imagem.")
            receipt_url = None
        
        # Atualizar a fatura como paga
        today_str = str(date.today())
        update_data = {
            "status": "paid",
            "payment_date": today_str,
        }
        if receipt_url:
            update_data["receipt_url"] = receipt_url
        
        supabase.table("finance_bills").update(update_data).eq("id", bill_id).execute()
        
        return {
            "status": "success",
            "message": f"Fatura '{bill['description']}' marcada como PAGA!",
            "receipt_url": receipt_url,
            "payment_date": today_str
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/bills/{bill_id}/pay-no-receipt", tags=["Bills", "Payment"])
async def pay_bill_no_receipt(bill_id: str):
    """
    Marca uma fatura como paga SEM comprovante (para uso rápido).
    """
    try:
        supabase = get_supabase_client()
        
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")
        
        bill = bill_resp.data[0]
        if bill.get("status") == "paid":
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}
        
        today_str = str(date.today())
        supabase.table("finance_bills").update({
            "status": "paid",
            "payment_date": today_str
        }).eq("id", bill_id).execute()
        
        return {
            "status": "success",
            "message": f"Fatura '{bill['description']}' paga com sucesso!",
            "payment_date": today_str
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ===========================================================================
# Scraping Routes (Desativadas - Portfolio)
# ===========================================================================

@app.post("/scrape/dasmei", tags=["Scraping"])
async def trigger_dasmei_scraping():
    """
    Aciona a rotina Playwright para buscar faturas pendentes do MEI
    usando a variável TARGET_CNPJ.
    """
    try:
        from datetime import datetime
        supabase = get_supabase_client()
        
        now = datetime.now()
        if now.month == 1:
            target_month = 12
            target_year = now.year - 1
        else:
            target_month = now.month - 1
            target_year = now.year
            
        current_month_label = f"Guia DAS MEI - {target_month:02d}/{target_year}"
        
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
    Aciona a rotina Playwright para buscar boletos pendentes da faculdade Unopar.
    """
    try:
        from datetime import datetime
        supabase = get_supabase_client()
        
        now = datetime.now()
        current_month_label = f"Mensalidade Unopar - {now.month:02d}/{now.year}"
        
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
    Aciona a rotina IMAP para buscar faturas na conta de E-mail.
    """
    resultado = await scrape_vivo_email()
    if resultado.get("status") == "error":
        raise HTTPException(status_code=400, detail=resultado.get("message"))
    return resultado

@app.post("/scrape/tim", tags=["Scraping"])
async def trigger_tim_scraping():
    """
    Aciona a rotina Playwright para buscar faturas pendentes do plano TIM Movel.
    """
    try:
        from datetime import datetime
        supabase = get_supabase_client()

        now = datetime.now()
        current_month_label = f"Conta TIM Movel - {now.month:02d}/{now.year}"

        existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
        if existing.data:
            return {
                "status": "info",
                "message": f"A {current_month_label} ja foi extraida anteriormente e consta no banco de dados."
            }

        resultado = await scrape_tim()

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

# ===========================================================================
# OCR Upload & Validation
# ===========================================================================

@app.post("/upload-receipt", tags=["Bills", "OCR"])
async def upload_receipt(file: UploadFile = File(...)):
    """
    Recebe um arquivo de imagem ou PDF e envia para a Inteligência Artificial
    realizar o OCR, extraindo valor, data e linha digitável.
    """
    allowed_types = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Formato de arquivo não suportado. Envie imagens ou PDF.")
    
    try:
        file_bytes = await file.read()
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
        response = supabase.table("finance_bills").select("*").eq("id", req.bill_id).execute()
        
        if not response.data:
            raise HTTPException(status_code=404, detail="Boleto não encontrado no sistema do FinanceFlow.")
            
        bill = response.data[0]
        
        # --- Motor Base de Validação Heurística ---
        is_amount_valid = False
        if req.ocr_amount is not None:
            val_diff = abs(float(bill["amount"]) - req.ocr_amount)
            if val_diff <= float(bill["amount"]) * 0.05:
                is_amount_valid = True
                
        is_date_valid = False
        if req.ocr_due_date is not None and bill.get("due_date"):
            if req.ocr_due_date == str(bill["due_date"]):
                is_date_valid = True
                
        is_barcode_valid = False
        if req.ocr_barcode and bill.get("barcode"):
            clean_ocr = "".join(filter(str.isdigit, req.ocr_barcode))
            clean_db = "".join(filter(str.isdigit, str(bill["barcode"])))
            if clean_ocr == clean_db and len(clean_ocr) > 0:
                is_barcode_valid = True
                
        confidence_score = 0
        if is_amount_valid: confidence_score += 40
        if is_date_valid: confidence_score += 30
        if is_barcode_valid: confidence_score += 30
            
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
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
