"""Canonical FinanceFlow HTTP handlers used by the production composition root.

This module deliberately contains no FastAPI application object or middleware setup.
Route registration and security policy belong to ``runtime.create_app`` so importing
business handlers cannot construct an alternate application as a side effect.

Handlers that acquired dedicated hardened modules are intentionally not duplicated
here. Keeping only the functions imported by ``runtime.py`` avoids a stale parallel
implementation becoming an accidental future route boundary.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException

from api_models import BillValidationRequest, HealthResponse
from database import ensure_receipts_bucket, get_supabase_client
from financial_math import amounts_within_percentage


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


async def get_incomes():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_incomes").select("*").order("date", desc=True).execute()
        return {"data": response.data}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


async def get_settings():
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_user_settings").select("*").limit(1).execute()
        return {"data": response.data[0] if response.data else None}
    except Exception as exc:
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
