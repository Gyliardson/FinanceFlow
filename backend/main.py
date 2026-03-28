from fastapi import FastAPI, HTTPException, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager
import asyncio
import os
import uuid
import logging
from datetime import datetime, date, timedelta

from database import get_supabase_client, get_supabase_storage_client, ensure_receipts_bucket
from ai_service import extract_invoice_data, generate_financial_insights
# ===========================================================================
# Módulos de Scraping (Inativos - Apenas para Portfólio/Demonstração)
# ===========================================================================
# from dasmei_scraper import scrape_dasmei
# from unopar_scraper import scrape_unopar
# from imap_scraper import scrape_vivo_email
# from tim_scraper import scrape_tim
# from scheduler import start_scheduler
from typing import Optional

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Garantir que o bucket de comprovantes exista
    ensure_receipts_bucket()
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
    description: str = Field(..., max_length=150)
    amount: float = Field(..., gt=0, le=1000000)
    due_date: str
    barcode: Optional[str] = Field(None, max_length=255)
    status: str = "pending"

class RecurringBillCreateRequest(BaseModel):
    """Request body para criar uma conta recorrente (template)."""
    title: str = Field(..., max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    amount: float = Field(..., gt=0, le=1000000)
    recurring_day: int  # Dia do mês (1-31)
    frequency: str = "monthly"  # 'monthly', 'weekly', etc.

class BillValidationRequest(BaseModel):
    bill_id: str
    ocr_amount: Optional[float] = None
    ocr_due_date: Optional[str] = None
    ocr_barcode: Optional[str] = None

class IncomeCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    amount: float = Field(..., gt=0, le=1000000)
    date: str
    description: Optional[str] = Field(None, max_length=255)
    type: str = "salary"
    is_recurring: bool = False

class SettingsUpdateRequest(BaseModel):
    initial_balance: float = Field(..., ge=-1000000, le=1000000)
    initial_balance_date: str
    emergency_fund_goal: float = Field(..., ge=0, le=1000000)

class ReserveAddRequest(BaseModel):
    amount: float = Field(..., gt=0, le=1000000)


# ===========================================================================
# Health & Basic Routes
# ===========================================================================

@app.get("/", tags=["Health"])
async def root():
    return {"message": "Bem-vindo à API do FinanceFlow"}

@app.get("/healthz", tags=["Health"], response_model=HealthResponse)
async def healthz_check():
    return HealthResponse(status="ok", message="Backend FinanceFlow operando normalmente")

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
async def create_recurring_bill(req: RecurringBillCreateRequest, background_tasks: BackgroundTasks):
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
        
        if first_due <= today:
            # Se o dia já passou no mês atual (ou é hoje), pula para o próximo mês
            # Isso evita que o sistema crie faturas "vencidas" logo no cadastro inicial.
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
        
        # Dispara a geração de instâncias em segundo plano para não travar a UI do celular
        background_tasks.add_task(generate_recurring_instances)
            
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
    Otimizado para evitar múltiplas consultas ao banco dentro de loops (N+1).
    """
    try:
        supabase = get_supabase_client()
        today = date.today()
        month_suffix = f"{today.month:02d}/{today.year}"
        
        # 1. Buscar todos os templates recorrentes
        templates_resp = (
            supabase.table("finance_bills")
            .select("*")
            .eq("is_recurring", True)
            .execute()
        )
        templates = templates_resp.data or []
        
        if not templates:
            return {"status": "success", "message": "Nenhum template recorrente encontrado."}

        # 2. Buscar TODAS as instâncias geradas (para evitar duplicatas independente do mês alvo)
        existing_resp = (
            supabase.table("finance_bills")
            .select("description", "due_date", "parent_bill_id")
            .not_.is_("parent_bill_id", "null")
            .execute()
        )
        # Criar um set de (parent_id, due_date) para busca rápida
        existing_instances = {
            (item["parent_bill_id"], item["due_date"]) 
            for item in (existing_resp.data or [])
        }
        
        generated = []
        to_insert = []
        
        import calendar
        last_day = calendar.monthrange(today.year, today.month)[1]

        # 3. Identificar quais instâncias precisam ser criadas
        for template in templates:
            recurring_day = template.get("recurring_day", 1)
            
            # Verificar data do mês atual
            last_day_this = calendar.monthrange(today.year, today.month)[1]
            due_this_month = date(today.year, today.month, min(recurring_day, last_day_this))
            
            # Regra: se hoje < dia do vencimento, gera para este mês.
            # Se hoje >= dia do vencimento, pula para o próximo mês.
            if today < due_this_month:
                target_date = due_this_month
            else:
                # Calcular próximo mês
                if today.month == 12:
                    y, m = today.year + 1, 1
                else:
                    y, m = today.year, today.month + 1
                last_day_next = calendar.monthrange(y, m)[1]
                target_date = date(y, m, min(recurring_day, last_day_next))

            target_suffix = f"{target_date.month:02d}/{target_date.year}"
            month_label = f"{template['description']} - {target_suffix}"
            
            # Verificar se esta instância específica (mesmo template e mesma data) já existe
            if (template["id"], str(target_date)) not in existing_instances:
                instance = {
                    "description": month_label,
                    "amount": template["amount"],
                    "due_date": str(target_date),
                    "status": "pending",
                    "parent_bill_id": template["id"],
                    "is_recurring": False,
                }
                to_insert.append(instance)

        # 4. Inserção em massa (Bulk Insert) se houver algo novo
        if to_insert:
            result = supabase.table("finance_bills").insert(to_insert).execute()
            generated = result.data or []
        
        return {
            "status": "success",
            "message": f"{len(generated)} nova(s) instância(s) gerada(s) para {month_suffix}.",
            "generated": generated
        }
    except Exception as e:
        logger.error(f"Erro ao gerar instâncias recorrentes: {e}")
        return {"status": "error", "message": str(e)}

# ===========================================================================
# Bill Detail & History
# ===========================================================================

@app.get("/bills/{bill_id}/detail", tags=["Bills"])
async def get_bill_detail(bill_id: str):
    """
    Retorna os detalhes completos de uma fatura e o histórico de pagamentos
    relacionados (mesma descrição base ou parent_bill_id).
    """
    try:
        supabase = get_supabase_client()

        # Buscar a fatura principal
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")

        bill = bill_resp.data[0]

        # Buscar faturas relacionadas (histórico)
        # 1. Pelo parent_bill_id (instâncias de uma recorrente)
        # 2. Pela descrição base (faturas avulsas com nomes parecidos)
        related = []

        parent_id = bill.get("parent_bill_id")
        if parent_id:
            # Buscar todas as instâncias do mesmo template recorrente
            siblings = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", parent_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = [s for s in siblings.data if s["id"] != bill_id]
        elif bill.get("is_recurring"):
            # Se é o próprio template, buscar todas as instâncias geradas
            children = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", bill_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = children.data
        else:
            # Fatura avulsa: buscar por descrição similar (base sem " - MM/YYYY")
            import re
            base_desc = re.sub(r'\s*-\s*\d{2}/\d{4}$', '', bill["description"]).strip()
            if base_desc and len(base_desc) >= 3:
                all_bills = (
                    supabase.table("finance_bills")
                    .select("*")
                    .ilike("description", f"%{base_desc}%")
                    .order("due_date", desc=True)
                    .execute()
                )
                related = [b for b in all_bills.data if b["id"] != bill_id]

        return {
            "bill": bill,
            "history": related,
            "history_count": len(related)
        }
    except HTTPException:
        raise
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
        storage_client = get_supabase_storage_client()
        
        # Verificar se a fatura existe
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")
        
        bill = bill_resp.data[0]
        if bill.get("status") == "paid":
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}
        
        # Upload do comprovante para o Supabase Storage (usando Service Role Key)
        file_bytes = await file.read()
        file_size_kb = len(file_bytes) / 1024
        logger.info(f"Recebido comprovante para fatura {bill_id}: {file.filename} ({file_size_kb:.1f} KB, tipo: {file.content_type})")
        
        file_ext = file.filename.split('.')[-1] if file.filename and '.' in file.filename else 'jpg'
        storage_path = f"{bill_id}_{uuid.uuid4().hex[:8]}.{file_ext}"
        
        receipt_url = None
        try:
            storage_client.storage.from_("receipts").upload(
                path=storage_path,
                file=file_bytes,
                file_options={"content-type": file.content_type or "image/jpeg"}
            )
            receipt_url = storage_client.storage.from_("receipts").get_public_url(storage_path)
            logger.info(f"Upload OK! URL: {receipt_url}")
        except Exception as storage_err:
            logger.error(
                f"FALHA no upload do comprovante para fatura {bill_id}. "
                f"Erro: {storage_err} | Tipo: {type(storage_err).__name__} | "
                f"Arquivo: {file.filename} ({file_size_kb:.1f} KB)"
            )
            # Não engolir o erro silenciosamente — informar o cliente
            raise HTTPException(
                status_code=500,
                detail=(
                    f"Falha ao salvar o comprovante no servidor. "
                    f"Erro: {str(storage_err)[:200]}. "
                    f"A fatura NAO foi marcada como paga. Tente novamente."
                )
            )
        
        # Atualizar a fatura como paga (só chega aqui se o upload funcionou)
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
        logger.error(f"Erro inesperado no pagamento da fatura {bill_id}: {e}")
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
# Incomes & Settings
# ===========================================================================

@app.get("/incomes", tags=["Incomes"])
async def get_incomes():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_incomes").select("*").order("date", desc=True).execute()
        return {"data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/incomes", tags=["Incomes"])
async def add_income(req: IncomeCreateRequest):
    try:
        supabase = get_supabase_client()
        data = req.model_dump()
        response = supabase.table("finance_incomes").insert(data).execute()
        return {"status": "success", "data": response.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/settings", tags=["Settings"])
async def get_settings():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_user_settings").select("*").limit(1).execute()
        if not response.data:
            return {"data": None}
        return {"data": response.data[0]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/settings", tags=["Settings"])
async def update_settings(req: SettingsUpdateRequest):
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_user_settings").select("id").limit(1).execute()
        data = req.model_dump()
        
        # O backend atualiza `updated_at` automaticamente caso pudesse, mas vamo setar manually só p garantir
        data["updated_at"] = str(datetime.now())

        if response.data:
            updated = supabase.table("finance_user_settings").update(data).eq("id", response.data[0]["id"]).execute()
            return {"status": "success", "data": updated.data[0]}
        else:
            inserted = supabase.table("finance_user_settings").insert(data).execute()
            return {"status": "success", "data": inserted.data[0]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def _calculate_financials(supabase, settings):
    initial_balance = float(settings.get("initial_balance", 0.0))
    emergency_fund_goal = float(settings.get("emergency_fund_goal", 0.0))
    emergency_fund_balance = float(settings.get("emergency_fund_balance", 0.0))
    initial_date = settings.get("initial_balance_date", "2000-01-01")
    
    incomes_resp = supabase.table("finance_incomes").select("amount").gte("date", initial_date).execute()
    total_income = sum(float(inc["amount"]) for inc in (incomes_resp.data or []))
    
    paid_bills_resp = supabase.table("finance_bills").select("amount").eq("status", "paid").gte("payment_date", initial_date).execute()
    total_paid = sum(float(b["amount"]) for b in (paid_bills_resp.data or []))
    
    current_balance = initial_balance + total_income - total_paid - emergency_fund_balance
    
    today = date.today()
    import calendar
    last_day = calendar.monthrange(today.year, today.month)[1]
    end_of_month = date(today.year, today.month, last_day)
    
    pending_bills_resp = supabase.table("finance_bills").select("amount").in_("status", ["pending", "overdue"]).lte("due_date", str(end_of_month)).execute()
    total_pending = sum(float(b["amount"]) for b in (pending_bills_resp.data or []))
    
    estimated_surplus = current_balance - total_pending
    return {
        "current_balance": current_balance,
        "estimated_surplus": estimated_surplus,
        "emergency_fund_goal": emergency_fund_goal,
        "emergency_fund_balance": emergency_fund_balance
    }

@app.get("/insights", tags=["Insights"])
async def get_insights():
    """
    Retorna o insight atual. Se não houver insight para o mês, gera um via IA e faz o cache.
    """
    try:
        supabase = get_supabase_client()
        settings_resp = supabase.table("finance_user_settings").select("*").limit(1).execute()
        if not settings_resp.data:
            raise HTTPException(status_code=400, detail="Configurações (Saldo Inicial) não encontradas. Configure o saldo inicial primeiro.")
        
        settings = settings_resp.data[0]
        fin_data = _calculate_financials(supabase, settings)
        
        latest_date_str = settings.get("latest_insight_date")
        latest_text = settings.get("latest_insight_text")
        today = date.today()
        
        # Check cache
        if latest_date_str and latest_text:
            try:
                # Trata datetime ISO se houver, ou apenas date YYYY-MM-DD
                ld = datetime.fromisoformat(latest_date_str)
                if ld.year == today.year and ld.month == today.month:
                    return {
                        "status": "success",
                        "data": {
                            "current_balance": fin_data["current_balance"],
                            "estimated_surplus": fin_data["estimated_surplus"],
                            "emergency_fund_goal": fin_data["emergency_fund_goal"],
                            "emergency_fund_balance": fin_data["emergency_fund_balance"],
                            "insight": latest_text
                        }
                    }
            except Exception as e:
                logger.warning(f"Falha ao interpretar data de insight '{latest_date_str}': {e}")
                
        # Cache nulo ou vencido -> gera novo
        insight_result = generate_financial_insights(fin_data)
        if insight_result.get("status") == "error":
            raise HTTPException(status_code=500, detail=insight_result.get("message"))
            
        new_text = insight_result.get("insight")
        
        # Update Cache
        supabase.table("finance_user_settings").update({
            "latest_insight_text": new_text,
            "latest_insight_date": today.isoformat()
        }).eq("id", settings["id"]).execute()
            
        return {
            "status": "success",
            "data": {
                "current_balance": fin_data["current_balance"],
                "estimated_surplus": fin_data["estimated_surplus"],
                "emergency_fund_goal": fin_data["emergency_fund_goal"],
                "emergency_fund_balance": fin_data["emergency_fund_balance"],
                "insight": new_text
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro no endpoint GET insights: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/insights/refresh", tags=["Insights"])
async def refresh_insights():
    """
    Força a geração de um novo insight via IA, ignorando o cache, e atualiza o banco de dados.
    """
    try:
        supabase = get_supabase_client()
        settings_resp = supabase.table("finance_user_settings").select("*").limit(1).execute()
        if not settings_resp.data:
            raise HTTPException(status_code=400, detail="Configurações (Saldo Inicial) não encontradas.")
        
        settings = settings_resp.data[0]
        fin_data = _calculate_financials(supabase, settings)
        
        insight_result = generate_financial_insights(fin_data)
        if insight_result.get("status") == "error":
            raise HTTPException(status_code=500, detail=insight_result.get("message"))
            
        new_text = insight_result.get("insight")
        today = date.today()
        
        # Update Cache
        supabase.table("finance_user_settings").update({
            "latest_insight_text": new_text,
            "latest_insight_date": today.isoformat()
        }).eq("id", settings["id"]).execute()
            
        return {
            "status": "success",
            "data": {
                "current_balance": fin_data["current_balance"],
                "estimated_surplus": fin_data["estimated_surplus"],
                "emergency_fund_goal": fin_data["emergency_fund_goal"],
                "emergency_fund_balance": fin_data["emergency_fund_balance"],
                "insight": new_text
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Erro no endpoint POST insights/refresh: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/insights/reserve", tags=["Insights"])
async def add_to_reserve(req: ReserveAddRequest):
    """
    Adiciona um valor à reserva de emergência e deduz logicamente do saldo atual.
    """
    try:
        supabase = get_supabase_client()
        settings_resp = supabase.table("finance_user_settings").select("*").limit(1).execute()
        if not settings_resp.data:
            raise HTTPException(status_code=400, detail="Configurações (Saldo Inicial) não encontradas.")
        
        settings = settings_resp.data[0]
        current_reserve = float(settings.get("emergency_fund_balance", 0.0))
        new_reserve = current_reserve + req.amount
        
        updated = supabase.table("finance_user_settings").update({
            "emergency_fund_balance": new_reserve
        }).eq("id", settings["id"]).execute()
        
        return {
            "status": "success",
            "message": "Fundo de reserva atualizado com sucesso.",
            "data": updated.data[0]
        }
    except Exception as e:
        logger.error(f"Erro no endpoint POST insights/reserve: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ===========================================================================
# Scraping Routes (Inativos - Apenas para Portfólio/Demonstração) - Comentadas para deploy v1.00 no Render
# ===========================================================================

# @app.post("/scrape/dasmei", tags=["Scraping"])
# async def trigger_dasmei_scraping():
#     """
#     Aciona a rotina Playwright para buscar faturas pendentes do MEI
#     usando a variável TARGET_CNPJ.
#     """
#     try:
#         from datetime import datetime
#         supabase = get_supabase_client()
#         
#         now = datetime.now()
#         if now.month == 1:
#             target_month = 12
#             target_year = now.year - 1
#         else:
#             target_month = now.month - 1
#             target_year = now.year
#             
#         current_month_label = f"Guia DAS MEI - {target_month:02d}/{target_year}"
#         
#         existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
#         if existing.data:
#             return {
#                 "status": "info",
#                 "message": f"A {current_month_label} já foi extraída anteriormente e consta no banco de dados."
#             }
#
#         resultado = await scrape_dasmei()
#         if resultado.get("status") == "error":
#             raise HTTPException(status_code=400, detail=resultado.get("message"))
#             
#         data = {
#             "description": resultado.get("description", current_month_label),
#             "amount": resultado.get("amount"),
#             "due_date": resultado.get("due_date"),
#             "barcode": resultado.get("barcode"),
#             "status": "pending"
#         }
#         db_response = supabase.table("finance_bills").insert(data).execute()
#         
#         return {
#             "status": "success", 
#             "message": resultado.get("message"),
#             "bill_data": db_response.data
#         }
#     except HTTPException:
#         raise
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"Erro interno de scraping: {str(e)}")
#
# @app.post("/scrape/unopar", tags=["Scraping"])
# async def trigger_unopar_scraping():
#     """
#     Aciona a rotina Playwright para buscar boletos pendentes da faculdade Unopar.
#     """
#     try:
#         from datetime import datetime
#         supabase = get_supabase_client()
#         
#         now = datetime.now()
#         current_month_label = f"Mensalidade Unopar - {now.month:02d}/{now.year}"
#         
#         existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
#         if existing.data:
#             return {
#                 "status": "info",
#                 "message": f"A {current_month_label} já foi extraída anteriormente e consta no banco de dados."
#             }
#
#         resultado = await scrape_unopar()
#         if resultado.get("status") == "error":
#             raise HTTPException(status_code=400, detail=resultado.get("message"))
#             
#         data = {
#             "description": resultado.get("description", current_month_label),
#             "amount": resultado.get("amount"),
#             "due_date": resultado.get("due_date"),
#             "barcode": resultado.get("barcode"),
#             "status": "pending"
#         }
#         db_response = supabase.table("finance_bills").insert(data).execute()
#         
#         return {
#             "status": "success", 
#             "message": resultado.get("message"),
#             "bill_data": db_response.data
#         }
#     except HTTPException:
#         raise
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"Erro interno de scraping: {str(e)}")
#
# @app.post("/scrape/email/vivo", tags=["Scraping"])
# async def trigger_vivo_email_scraping():
#     """
#     Aciona a rotina IMAP para buscar faturas na conta de E-mail.
#     """
#     resultado = await scrape_vivo_email()
#     if resultado.get("status") == "error":
#         raise HTTPException(status_code=400, detail=resultado.get("message"))
#     return resultado
#
# @app.post("/scrape/tim", tags=["Scraping"])
# async def trigger_tim_scraping():
#     """
#     Aciona a rotina Playwright para buscar faturas pendentes do plano TIM Movel.
#     """
#     try:
#         from datetime import datetime
#         supabase = get_supabase_client()
#
#         now = datetime.now()
#         current_month_label = f"Conta TIM Movel - {now.month:02d}/{now.year}"
#
#         existing = supabase.table("finance_bills").select("id").eq("description", current_month_label).execute()
#         if existing.data:
#             return {
#                 "status": "info",
#                 "message": f"A {current_month_label} ja foi extraida anteriormente e consta no banco de dados."
#             }
#
#         resultado = await scrape_tim()
#
#         if resultado.get("status") == "info":
#             return resultado
#
#         if resultado.get("status") == "error":
#             raise HTTPException(status_code=400, detail=resultado.get("message"))
#
#         data = {
#             "description": resultado.get("description", current_month_label),
#             "amount": resultado.get("amount"),
#             "due_date": resultado.get("due_date"),
#             "barcode": resultado.get("barcode"),
#             "status": "pending"
#         }
#         db_response = supabase.table("finance_bills").insert(data).execute()
#
#         return {
#             "status": "success",
#             "message": resultado.get("message"),
#             "bill_data": db_response.data
#         }
#     except HTTPException:
#         raise
#     except Exception as e:
#         raise HTTPException(status_code=500, detail=f"Erro interno de scraping TIM: {str(e)}")

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
