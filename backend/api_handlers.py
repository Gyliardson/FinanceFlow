"""Canonical FinanceFlow HTTP handlers used by the production composition root.

This module deliberately contains no FastAPI application object or middleware setup.
Route registration and security policy belong to ``runtime.create_app`` so importing
business handlers cannot construct an alternate application as a side effect.
"""

import calendar
import logging
import re
from contextlib import asynccontextmanager
from datetime import date, datetime

from fastapi import FastAPI, HTTPException

from ai_service import generate_financial_insights
from api_models import (
    BillCreateRequest,
    BillValidationRequest,
    HealthResponse,
    IncomeCreateRequest,
    ReserveAddRequest,
    SettingsUpdateRequest,
)
from database import ensure_receipts_bucket, get_supabase_client
from financial_clock import financial_today
from financial_math import (
    add_to_reserve as calculate_reserve_addition,
    amounts_within_percentage,
    calculate_balances,
)
from money import money, money_to_storage

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    ensure_receipts_bucket()
    # External scrapers/scheduler remain intentionally inactive. They are not
    # registered as routes in the portfolio runtime.
    yield


async def root():
    return {"message": "Bem-vindo à API do FinanceFlow"}


async def healthz_check():
    return HealthResponse(status="ok", message="Backend FinanceFlow operando normalmente")


async def health_check():
    return HealthResponse(status="ok", message="A API está operante e saudável.")


async def get_bills():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_bills").select("*").order("due_date", desc=True).execute()
        return {"data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_pending_bills():
    try:
        supabase = get_supabase_client()
        response = (
            supabase.table("finance_bills")
            .select("*")
            .eq("status", "pending")
            .eq("is_recurring", False)
            .order("due_date", desc=False)
            .execute()
        )
        return {"data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
            related = [row for row in (siblings.data or []) if row["id"] != bill_id]
        elif bill.get("is_recurring"):
            children = (
                supabase.table("finance_bills")
                .select("*")
                .eq("parent_bill_id", bill_id)
                .order("due_date", desc=True)
                .execute()
            )
            related = children.data or []
        else:
            base_desc = re.sub(r"\s*-\s*\d{2}/\d{4}$", "", bill["description"]).strip()
            if base_desc and len(base_desc) >= 3:
                all_bills = (
                    supabase.table("finance_bills")
                    .select("*")
                    .ilike("description", f"%{base_desc}%")
                    .order("due_date", desc=True)
                    .execute()
                )
                related = [row for row in (all_bills.data or []) if row["id"] != bill_id]

        return {"bill": bill, "history": related, "history_count": len(related)}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def pay_bill_no_receipt(bill_id: str):
    try:
        supabase = get_supabase_client()
        bill_resp = supabase.table("finance_bills").select("*").eq("id", bill_id).execute()
        if not bill_resp.data:
            raise HTTPException(status_code=404, detail="Fatura não encontrada.")

        bill = bill_resp.data[0]
        if bill.get("is_recurring") is True:
            raise HTTPException(
                status_code=409,
                detail="Modelos recorrentes não podem ser pagos diretamente.",
            )
        if bill.get("status") == "paid":
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}

        today_str = financial_today().isoformat()
        supabase.table("finance_bills").update(
            {"status": "paid", "payment_date": today_str}
        ).eq("id", bill_id).eq("is_recurring", False).execute()
        return {
            "status": "success",
            "message": f"Fatura '{bill['description']}' paga com sucesso!",
            "payment_date": today_str,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_incomes():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_incomes").select("*").order("date", desc=True).execute()
        return {"data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def add_income(req: IncomeCreateRequest):
    try:
        supabase = get_supabase_client()
        data = req.model_dump()
        data["amount"] = money_to_storage(req.amount)
        response = supabase.table("finance_incomes").insert(data).execute()
        return {"status": "success", "data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_settings():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_user_settings").select("*").limit(1).execute()
        return {"data": response.data[0] if response.data else None}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
        .eq("is_recurring", False)
        .gte("payment_date", initial_date)
        .execute()
    )

    today = financial_today()
    end_of_month = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    pending_bills_resp = (
        supabase.table("finance_bills")
        .select("amount")
        .in_("status", ["pending", "overdue"])
        .eq("is_recurring", False)
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
        today = financial_today()

        if latest_date_str and latest_text:
            try:
                latest_date = datetime.fromisoformat(latest_date_str)
                if latest_date.year == today.year and latest_date.month == today.month:
                    return {"status": "success", "data": {**fin_data, "insight": latest_text}}
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
        today = financial_today()
        supabase.table("finance_user_settings").update(
            {"latest_insight_text": new_text, "latest_insight_date": today.isoformat()}
        ).eq("id", settings["id"]).execute()
        return {"status": "success", "data": {**fin_data, "insight": new_text}}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Erro no endpoint POST insights/refresh: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc)) from exc


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
