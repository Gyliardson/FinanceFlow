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
        # This indicates a composition/runtime invariant failure. Do not fall back
        # to a shared secret or anonymous client.
        raise HTTPException(status_code=401, detail="Authenticated user context is required.")
    return user_id


async def pay_bill_without_receipt(bill_id: str):
    """Mark an authenticated user's payable bill with compare-and-set idempotency."""
    _authenticated_user_id()
    data_client = get_supabase_client()

    try:
        bill_response = (
            data_client.table("finance_bills")
            .select("id,status,description,is_recurring")
            .eq("id", bill_id)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        logger.error("Receipt-less payment lookup failed")
        raise HTTPException(status_code=503, detail="Não foi possível consultar a fatura.") from exc

    rows = getattr(bill_response, "data", None) or []
    if not rows:
        # RLS intentionally makes a cross-owner identifier indistinguishable
        # from a nonexistent bill.
        raise HTTPException(status_code=404, detail="Fatura não encontrada.")

    bill = rows[0]
    if bill.get("is_recurring") is True:
        raise HTTPException(
            status_code=409,
            detail="Modelos recorrentes não podem ser pagos diretamente.",
        )
    if bill.get("status") == "paid":
        return {"status": "info", "message": "Esta fatura já foi marcada como paga."}

    payment_date = financial_today().isoformat()
    try:
        update_response = (
            data_client.table("finance_bills")
            .update({"status": "paid", "payment_date": payment_date})
            .eq("id", bill_id)
            .eq("is_recurring", False)
            .neq("status", "paid")
            .execute()
        )
    except Exception as exc:
        logger.error("Receipt-less payment persistence failed")
        raise HTTPException(status_code=503, detail="Não foi possível confirmar o pagamento.") from exc

    if not (getattr(update_response, "data", None) or []):
        # Zero rows can mean another request paid the bill, but the additional
        # domain predicate also means it is not safe to infer success. Re-read
        # authoritative owner-scoped state before telling the client anything.
        try:
            reconciled_response = (
                data_client.table("finance_bills")
                .select("id,status,is_recurring")
                .eq("id", bill_id)
                .limit(1)
                .execute()
            )
        except Exception as exc:
            logger.error("Receipt-less payment reconciliation failed")
            raise HTTPException(
                status_code=503,
                detail="Não foi possível confirmar o pagamento.",
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
            return {"status": "info", "message": "Esta fatura já foi marcada como paga."}
        raise HTTPException(
            status_code=409,
            detail="O pagamento não pôde ser confirmado. Atualize os dados e tente novamente.",
        )

    return {
        "status": "success",
        "message": f"Fatura '{bill.get('description', '')}' paga com sucesso!",
        "payment_date": payment_date,
    }


async def pay_bill_with_private_receipt(
    bill_id: str,
    file: UploadFile = File(...),
):
    """Validate, privately store and persist a receipt-backed bill payment."""
    owner_id = _authenticated_user_id()
    # Read at most one byte beyond the policy so oversized uploads are rejected
    # without buffering an unbounded request body in application memory.
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
        # RLS intentionally makes another user's identifier indistinguishable
        # from a nonexistent bill.
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
