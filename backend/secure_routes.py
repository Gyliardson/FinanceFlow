import logging

from fastapi import File, HTTPException, UploadFile

from database import get_supabase_client, get_supabase_storage_client
from receipt_access import ReceiptAccessError, ReceiptNotFoundError, create_authorized_receipt_access
from receipt_payments import (
    BillAlreadyPaidError,
    BillNotFoundError,
    PaymentPersistenceError,
    ReceiptStorageError,
    RecurringTemplatePaymentError,
    persist_private_receipt_payment,
)
from receipt_uploads import MAX_RECEIPT_BYTES, ReceiptValidationError
from request_context import get_request_user_id

logger = logging.getLogger(__name__)


def _authenticated_user_id() -> str:
    user_id = get_request_user_id()
    if not user_id:
        raise HTTPException(status_code=401, detail="Authenticated user context is required.")
    return user_id


def _rpc_payload(response):
    data = getattr(response, "data", None)
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    return None


def _reconcile_receiptless_payment(data_client, bill_id: str):
    """Resolve an uncertain receipt-less mutation from owner-scoped durable state."""
    try:
        reconciled_response = (
            data_client.table("finance_bills")
            .select("id,status,is_recurring,payment_date")
            .eq("id", bill_id)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.error("Receipt-less payment reconciliation failed")
        raise HTTPException(
            status_code=503,
            detail="Não foi possível confirmar o resultado do pagamento.",
        ) from exc

    reconciled_rows = getattr(reconciled_response, "data", None) or []
    if not reconciled_rows:
        raise HTTPException(status_code=404, detail="Fatura não encontrada.")

    reconciled = reconciled_rows[0]
    if reconciled.get("is_recurring") is True:
        raise HTTPException(
            status_code=409,
            detail="Modelos recorrentes não podem ser pagos diretamente.",
        )
    if reconciled.get("status") == "paid":
        return {
            "status": "info",
            "message": "Esta fatura já foi marcada como paga.",
            "payment_date": reconciled.get("payment_date"),
        }

    raise HTTPException(
        status_code=409,
        detail="O resultado do pagamento não foi confirmado. Atualize os dados antes de tentar novamente.",
    )


async def pay_bill_without_receipt(bill_id: str):
    """Mark an authenticated user's payable bill through the database-owned transition."""
    _authenticated_user_id()
    data_client = get_supabase_client()

    try:
        bill_response = (
            data_client.table("finance_bills")
            .select("id,status,description,is_recurring,payment_date")
            .eq("id", bill_id)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.error("Receipt-less payment lookup failed")
        raise HTTPException(status_code=503, detail="Não foi possível consultar a fatura.") from exc

    rows = getattr(bill_response, "data", None) or []
    if not rows:
        raise HTTPException(status_code=404, detail="Fatura não encontrada.")

    bill = rows[0]
    if bill.get("is_recurring") is True:
        raise HTTPException(
            status_code=409,
            detail="Modelos recorrentes não podem ser pagos diretamente.",
        )
    if bill.get("status") == "paid":
        return {
            "status": "info",
            "message": "Esta fatura já foi marcada como paga.",
            "payment_date": bill.get("payment_date"),
        }

    try:
        rpc_response = data_client.rpc(
            "finance_mark_bill_paid",
            {"p_bill_id": bill_id, "p_receipt_path": None},
        ).execute()
    except Exception:
        return _reconcile_receiptless_payment(data_client, bill_id)

    payload = _rpc_payload(rpc_response)
    authoritative = payload.get("data") if payload else None
    if not isinstance(authoritative, dict) or authoritative.get("status") != "paid":
        return _reconcile_receiptless_payment(data_client, bill_id)

    if payload.get("status") == "info":
        return {
            "status": "info",
            "message": "Esta fatura já foi marcada como paga.",
            "payment_date": authoritative.get("payment_date"),
        }

    return {
        "status": "success",
        "message": f"Fatura '{bill.get('description', '')}' paga com sucesso!",
        "payment_date": authoritative.get("payment_date"),
    }


async def pay_bill_with_private_receipt(
    bill_id: str,
    file: UploadFile = File(...),
):
    """Validate, privately store and persist a receipt-backed bill payment."""
    owner_id = _authenticated_user_id()
    content = await file.read(MAX_RECEIPT_BYTES + 1)

    try:
        result = persist_private_receipt_payment(
            data_client=get_supabase_client(),
            storage_client=get_supabase_storage_client(),
            owner_id=owner_id,
            bill_id=bill_id,
            content=content,
            declared_mime_type=file.content_type,
        )
    except ReceiptValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BillNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Fatura não encontrada.") from exc
    except RecurringTemplatePaymentError as exc:
        raise HTTPException(
            status_code=409,
            detail="Modelos recorrentes não podem ser pagos diretamente.",
        ) from exc
    except BillAlreadyPaidError as exc:
        raise HTTPException(status_code=409, detail="Esta fatura já foi marcada como paga.") from exc
    except ReceiptStorageError as exc:
        logger.error("Private receipt storage failed")
        raise HTTPException(
            status_code=503,
            detail="Não foi possível armazenar o comprovante. A fatura não foi marcada como paga.",
        ) from exc
    except PaymentPersistenceError as exc:
        logger.error("Payment persistence failed")
        raise HTTPException(
            status_code=409,
            detail="O pagamento não pôde ser confirmado. Atualize os dados e tente novamente.",
        ) from exc

    return {
        "status": "success",
        "message": "Fatura marcada como paga com comprovante privado.",
        "payment_date": result.payment_date,
    }


def get_private_receipt_access(bill_id: str):
    """Return bounded temporary receipt access after RLS authorization."""
    owner_id = _authenticated_user_id()
    try:
        access = create_authorized_receipt_access(
            data_client=get_supabase_client(),
            owner_id=owner_id,
            bill_id=bill_id,
        )
    except ReceiptNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Comprovante não encontrado.") from exc
    except (ReceiptAccessError, ValueError) as exc:
        logger.error("Private receipt access generation failed")
        raise HTTPException(
            status_code=503,
            detail="Não foi possível gerar acesso temporário ao comprovante.",
        ) from exc

    return {
        "status": "success",
        "url": access.signed_url,
        "expires_in": access.expires_in,
    }
