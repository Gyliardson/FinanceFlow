from contextlib import asynccontextmanager
from datetime import date, datetime
from decimal import Decimal
import logging
import os
import uuid
from typing import Annotated, Optional

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, BeforeValidator, Field
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from ai_service import extract_invoice_data, generate_financial_insights
from database import get_supabase_client, get_supabase_storage_client, ensure_receipts_bucket
from financial_math import (
    add_to_reserve as calculate_reserve_addition,
    amounts_within_percentage,
    calculate_balances,
)
from money import money, money_to_storage
from recurrence import recurring_due_date

logger = logging.getLogger(__name__)

API_KEY = os.getenv("API_SECRET_KEY", "")
PUBLIC_PATHS = {"/", "/health", "/healthz", "/docs", "/openapi.json", "/redoc"}
MAX_MONEY = Decimal("1000000.00")
MIN_SIGNED_MONEY = Decimal("-1000000.00")
CanonicalMoney = Annotated[Decimal, BeforeValidator(money)]


class APIKeyMiddleware(BaseHTTPMiddleware):
    """Reject requests without a valid API key, except public health/docs routes."""

    async def dispatch(self, request: Request, call_next):
        if request.url.path in PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        provided_key = request.headers.get("X-API-KEY", "")
        if not API_KEY or provided_key != API_KEY:
            return JSONResponse(
                status_code=401,
                content={"detail": "Unauthorized – invalid or missing API key."},
            )
        return await call_next(request)


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_receipts_bucket()
    # External scrapers/scheduler remain intentionally inactive. They are not
    # registered as routes in the portfolio runtime.
    yield


app = FastAPI(
    title="FinanceFlow API",
    description="Backend API para automação e notificação de contas a pagar.",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restricted-origin policy is tracked with the auth/privacy work in #8.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(APIKeyMiddleware)


class HealthResponse(BaseModel):
    status: str
    message: str


class BillCreateRequest(BaseModel):
    description: str = Field(..., max_length=150)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    due_date: str
    barcode: Optional[str] = Field(None, max_length=255)
    status: str = "pending"


class RecurringBillCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    recurring_day: int = Field(..., ge=1, le=31)
    frequency: str = "monthly"


class BillValidationRequest(BaseModel):
    bill_id: str
    ocr_amount: Optional[CanonicalMoney] = None
    ocr_due_date: Optional[str] = None
    ocr_barcode: Optional[str] = None


class IncomeCreateRequest(BaseModel):
    title: str = Field(..., max_length=100)
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)
    date: str
    description: Optional[str] = Field(None, max_length=255)
    type: str = "salary"
    is_recurring: bool = False


class SettingsUpdateRequest(BaseModel):
    initial_balance: CanonicalMoney = Field(..., ge=MIN_SIGNED_MONEY, le=MAX_MONEY)
    initial_balance_date: str
    emergency_fund_goal: CanonicalMoney = Field(..., ge=Decimal("0.00"), le=MAX_MONEY)


class ReserveAddRequest(BaseModel):
    amount: CanonicalMoney = Field(..., gt=Decimal("0.00"), le=MAX_MONEY)


@app.get("/", tags=["Health"])
async def root():
    return {"message": "Bem-vindo à API do FinanceFlow"}


@app.get("/healthz", tags=["Health"], response_model=HealthResponse)
async def healthz_check():
    return HealthResponse(status="ok", message="Backend FinanceFlow operando normalmente")


@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    return HealthResponse(status="ok", message="A API está operante e saudável.")


@app.get("/bills", tags=["Bills"])
async def get_bills():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_bills").select("*").order("due_date", desc=True).execute()
        return {"data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/bills/pending", tags=["Bills"])
async def get_pending_bills():
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
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/add-bill", tags=["Bills"])
async def add_bill(req: BillCreateRequest):
    try:
        supabase = get_supabase_client()
        data = {
            "description": req.description,
            "amount": money_to_storage(req.amount),
            "due_date": req.due_date,
            "barcode": req.barcode if req.barcode else None,
            "status": req.status,
        }
        response = supabase.table("finance_bills").insert(data).execute()
        return {"status": "success", "data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/recurring-bills", tags=["Recurring Bills"])
async def create_recurring_bill(req: RecurringBillCreateRequest, background_tasks: BackgroundTasks):
    try:
        supabase = get_supabase_client()
        first_due = recurring_due_date(req.recurring_day, date.today())
        data = {
            "description": req.title,
            "amount": money_to_storage(req.amount),
            "due_date": str(first_due),
            "barcode": req.description,
            "status": "pending",
            "is_recurring": True,
            "frequency": req.frequency,
            "recurring_day": req.recurring_day,
        }
        response = supabase.table("finance_bills").insert(data).execute()
        background_tasks.add_task(generate_recurring_instances)
        return {"status": "success", "data": response.data}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/recurring-bills", tags=["Recurring Bills"])
async def get_recurring_bills():
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
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/recurring-bills/generate", tags=["Recurring Bills"])
async def generate_recurring_instances():
    """Generate missing recurring children; PostgreSQL uniqueness is the final idempotency authority."""
    try:
        supabase = get_supabase_client()
        today = date.today()
        templates_resp = (
            supabase.table("finance_bills")
            .select("*")
            .eq("is_recurring", True)
            .execute()
        )
        templates = templates_resp.data or []
        if not templates:
            return {"status": "success", "message": "Nenhum template recorrente encontrado."}

        existing_resp = (
            supabase.table("finance_bills")
            .select("description", "due_date", "parent_bill_id")
            .not_.is_("parent_bill_id", "null")
            .execute()
        )
        existing_instances = {
            (item["parent_bill_id"], item["due_date"])
            for item in (existing_resp.data or [])
        }

        to_insert = []
        for template in templates:
            target_date = recurring_due_date(template.get("recurring_day", 1), today)
            target_suffix = f"{target_date.month:02d}/{target_date.year}"
            if (template["id"], str(target_date)) in existing_instances:
                continue
            to_insert.append(
                {
                    "description": f"{template['description']} - {target_suffix}",
                    "amount": money_to_storage(template["amount"]),
                    "due_date": str(target_date),
                    "status": "pending",
                    "parent_bill_id": template["id"],
                    "is_recurring": False,
                }
            )

        generated = []
        if to_insert:
            result = supabase.table("finance_bills").insert(to_insert).execute()
            generated = result.data or []

        return {
            "status": "success",
            "message": f"{len(generated)} nova(s) instância(s) recorrente(s) gerada(s).",
            "generated": generated,
        }
    except Exception as exc:
        logger.error("Erro ao gerar instâncias recorrentes: %s", exc)
        return {"status": "error", "message": str(exc)}


@app.get("/bills/{bill_id}/detail", tags=["Bills"])
async def get_bill_detail(bill_id: str):
    try:
        supabase = get_supabase_client()
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")

        bill = bill_resp.data[0]
        parent_id = bill.get("parent_bill_id")
        related = []
        if parent_id:
            siblings = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", parent_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = [row for row in siblings.data if row["id"] != bill_id]
        elif bill.get("is_recurring"):
            children = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", bill_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = children.data
        else:
            import re

            base_desc = re.sub(r"\s*-\s*\d{2}/\d{4}$", "", bill["description"]).strip()
            if base_desc and len(base_desc) >= 3:
                all_bills = (
                    supabase.table("finance_bills")
                    .select("*")
                    .ilike("description", f"%{base_desc}%")
                    .order("due_date", desc=True)
                    .execute()
                )
                related = [row for row in all_bills.data if row["id"] != bill_id]

        return {"bill": bill, "history": related, "history_count": len(related)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/bills/{bill_id}/pay", tags=["Bills", "Payment"])
async def pay_bill(bill_id: str, file: UploadFile = File(...)):
    try:
        supabase = get_supabase_client()
        storage_client = get_supabase_storage_client()
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")

        bill = bill_resp.data[0]
        if bill.get("status") == "paid":
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}

        file_bytes = await file.read()
        file_size_kb = len(file_bytes) / 1024
        logger.info(
            "Recebido comprovante para fatura %s: %s (%.1f KB, tipo: %s)",
            bill_id,
            file.filename,
            file_size_kb,
            file.content_type,
        )
        file_ext = file.filename.split(".")[-1] if file.filename and "." in file.filename else "jpg"
        storage_path = f"{bill_id}_{uuid.uuid4().hex[:8]}.{file_ext}"

        try:
            storage_client.storage.from_("receipts").upload(
                path=storage_path,
                file=file_bytes,
                file_options={"content-type": file.content_type or "image/jpeg"},
            )
            receipt_url = storage_client.storage.from_("receipts").get_public_url(storage_path)
            logger.info("Upload OK! URL: %s", receipt_url)
        except Exception as storage_err:
            logger.error(
                "FALHA no upload do comprovante para fatura %s. Erro: %s | Tipo: %s | Arquivo: %s (%.1f KB)",
                bill_id,
                storage_err,
                type(storage_err).__name__,
                file.filename,
                file_size_kb,
            )
            raise HTTPException(
                status_code=500,
                detail=(
                    "Falha ao salvar o comprovante no servidor. "
                    f"Erro: {str(storage_err)[:200]}. "
                    "A fatura NAO foi marcada como paga. Tente novamente."
                ),
            ) from storage_err

        today_str = str(date.today())
        supabase.table("finance_bills").update(
            {"status": "paid", "payment_date": today_str, "receipt_url": receipt_url}
        ).eq("id", bill_id).execute()
        return {
            "status": "success",
            "message": f"Fatura '{bill['description']}' marcada como PAGA!",
            "receipt_url": receipt_url,
            "payment_date": today_str,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Erro inesperado no pagamento da fatura %s: %s", bill_id, exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/bills/{bill_id}/pay-no-receipt", tags=["Bills", "Payment"])
async def pay_bill_no_receipt(bill_id: str):
    try:
        supabase = get_supabase_client()
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")

        bill = bill_resp.data[0]
        if bill.get("status") == "paid":
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}

        today_str = str(date.today())
        supabase.table("finance_bills").update(
            {"status": "paid", "payment_date": today_str}
        ).eq("id", bill_id).execute()
        return {
            "status": "success",
            "message": f"Fatura '{bill['description']}' paga com sucesso!",
            "payment_date": today_str,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/incomes", tags=["Incomes"])
async def get_incomes():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_incomes").select("*").order("date", desc=True).execute()
        return {"data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/incomes", tags=["Incomes"])
async def add_income(req: IncomeCreateRequest):
    try:
        supabase = get_supabase_client()
        data = req.model_dump()
        data["amount"] = money_to_storage(req.amount)
        response = supabase.table("finance_incomes").insert(data).execute()
        return {"status": "success", "data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/settings", tags=["Settings"])
async def get_settings():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_user_settings").select("*").limit(1).execute()
        return {"data": response.data[0] if response.data else None}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/settings", tags=["Settings"])
async def update_settings(req: SettingsUpdateRequest):
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_user_settings").select("id").limit(1).execute()
        data = req.model_dump()
        data["initial_balance"] = money_to_storage(req.initial_balance)
        data["emergency_fund_goal"] = money_to_storage(req.emergency_fund_goal)
        data["updated_at"] = str(datetime.now())

        if response.data:
            updated = (
                supabase.table("finance_user_settings")
                .update(data)
                .eq("id", response.data[0]["id"])
                .execute()
            )
            return {"status": "success", "data": updated.data[0]}

        inserted = supabase.table("finance_user_settings").insert(data).execute()
        return {"status": "success", "data": inserted.data[0]}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _calculate_financials(supabase, settings):
    initial_date = settings.get("initial_balance_date", "2000-01-01")
    emergency_fund_goal = money(settings.get("emergency_fund_goal", "0.00"))
    emergency_fund_balance = money(settings.get("emergency_fund_balance", "0.00"))

    incomes_resp = (
        supabase.table("finance_incomes").select("amount").gte("date", initial_date).execute()
    )
    paid_bills_resp = (
        supabase.table("finance_bills")
        .select("amount")
        .eq("status", "paid")
        .gte("payment_date", initial_date)
        .execute()
    )

    today = date.today()
    import calendar

    end_of_month = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    pending_bills_resp = (
        supabase.table("finance_bills")
        .select("amount")
        .in_("status", ["pending", "overdue"])
        .lte("due_date", str(end_of_month))
        .execute()
    )

    balances = calculate_balances(
        initial_balance=settings.get("initial_balance", "0.00"),
        incomes=[item["amount"] for item in (incomes_resp.data or [])],
        paid_bills=[item["amount"] for item in (paid_bills_resp.data or [])],
        emergency_fund_balance=emergency_fund_balance,
        pending_bills=[item["amount"] for item in (pending_bills_resp.data or [])],
    )
    return {
        "current_balance": balances["current_balance"],
        "estimated_surplus": balances["estimated_surplus"],
        "emergency_fund_goal": emergency_fund_goal,
        "emergency_fund_balance": emergency_fund_balance,
    }


@app.get("/insights", tags=["Insights"])
async def get_insights():
    try:
        supabase = get_supabase_client()
        settings_resp = supabase.table("finance_user_settings").select("*").limit(1).execute()
        if not settings_resp.data:
            raise HTTPException(
                status_code=400,
                detail="Configurações (Saldo Inicial) não encontradas. Configure o saldo inicial primeiro.",
            )

        settings = settings_resp.data[0]
        fin_data = _calculate_financials(supabase, settings)
        latest_date_str = settings.get("latest_insight_date")
        latest_text = settings.get("latest_insight_text")
        today = date.today()

        if latest_date_str and latest_text:
            try:
                latest_date = datetime.fromisoformat(latest_date_str)
                if latest_date.year == today.year and latest_date.month == today.month:
                    return {
                        "status": "success",
                        "data": {**fin_data, "insight": latest_text},
                    }
            except Exception as exc:
                logger.warning("Falha ao interpretar data de insight '%s': %s", latest_date_str, exc)

        insight_result = generate_financial_insights(fin_data)
        if insight_result.get("status") == "error":
            raise HTTPException(status_code=500, detail=insight_result.get("message"))

        new_text = insight_result.get("insight")
        supabase.table("finance_user_settings").update(
            {"latest_insight_text": new_text, "latest_insight_date": today.isoformat()}
        ).eq("id", settings["id"]).execute()
        return {"status": "success", "data": {**fin_data, "insight": new_text}}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Erro no endpoint GET insights: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/insights/refresh", tags=["Insights"])
async def refresh_insights():
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
        supabase.table("finance_user_settings").update(
            {"latest_insight_text": new_text, "latest_insight_date": today.isoformat()}
        ).eq("id", settings["id"]).execute()
        return {"status": "success", "data": {**fin_data, "insight": new_text}}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Erro no endpoint POST insights/refresh: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/insights/reserve", tags=["Insights"])
async def add_to_reserve(req: ReserveAddRequest):
    try:
        supabase = get_supabase_client()
        settings_resp = supabase.table("finance_user_settings").select("*").limit(1).execute()
        if not settings_resp.data:
            raise HTTPException(status_code=400, detail="Configurações (Saldo Inicial) não encontradas.")

        settings = settings_resp.data[0]
        new_reserve = calculate_reserve_addition(
            settings.get("emergency_fund_balance", "0.00"), req.amount
        )
        updated = (
            supabase.table("finance_user_settings")
            .update({"emergency_fund_balance": money_to_storage(new_reserve)})
            .eq("id", settings["id"])
            .execute()
        )
        return {
            "status": "success",
            "message": "Fundo de reserva atualizado com sucesso.",
            "data": updated.data[0],
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Erro no endpoint POST insights/reserve: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/upload-receipt", tags=["Bills", "OCR"])
async def upload_receipt(file: UploadFile = File(...)):
    allowed_types = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail="Formato de arquivo não suportado. Envie imagens ou PDF.",
        )

    try:
        file_bytes = await file.read()
        resultado_ocr = extract_invoice_data(file_bytes, mime_type=file.content_type)
        if resultado_ocr.get("status") == "error":
            error_details = resultado_ocr.get("details", "Sem detalhes adicionais")
            raise HTTPException(
                status_code=500,
                detail=f"{resultado_ocr.get('message')} Erro Técnico: {error_details}",
            )
        return {
            "message": "Arquivo processado com sucesso.",
            "filename": file.filename,
            "ocr_result": resultado_ocr["extracted_data"],
        }
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Erro no processamento do arquivo: {str(exc)}",
        ) from exc


@app.post("/validate-bill", tags=["Bills", "Validation"])
async def validate_bill(req: BillValidationRequest):
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_bills").select("*").eq("id", req.bill_id).execute()
        if not response.data:
            raise HTTPException(status_code=404, detail="Boleto não encontrado no sistema do FinanceFlow.")

        bill = response.data[0]
        is_amount_valid = (
            amounts_within_percentage(bill["amount"], req.ocr_amount)
            if req.ocr_amount is not None
            else False
        )
        is_date_valid = bool(
            req.ocr_due_date is not None
            and bill.get("due_date")
            and req.ocr_due_date == str(bill["due_date"])
        )

        is_barcode_valid = False
        if req.ocr_barcode and bill.get("barcode"):
            clean_ocr = "".join(filter(str.isdigit, req.ocr_barcode))
            clean_db = "".join(filter(str.isdigit, str(bill["barcode"])))
            is_barcode_valid = clean_ocr == clean_db and len(clean_ocr) > 0

        confidence_score = 0
        if is_amount_valid:
            confidence_score += 40
        if is_date_valid:
            confidence_score += 30
        if is_barcode_valid:
            confidence_score += 30

        return {
            "status": "success",
            "bill_id": req.bill_id,
            "confidence_score": confidence_score,
            "is_approved": confidence_score >= 60,
            "details": {
                "amount_match": is_amount_valid,
                "date_match": is_date_valid,
                "barcode_match": is_barcode_valid,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
