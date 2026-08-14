import logging

from fastapi import File, HTTPException, UploadFile

from database import get_supabase_client, get_supabase_storage_client
from receipt_access import ReceiptAccessError, ReceiptNotFoundError, create_authorized_receipt_access
from receipt_payments import (
    BillAlreadyPaidError,
    BillNotFoundError,
    PaymentPersistenceError,
    ReceiptStorageError,
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
    except BillAlreadyPaidError as exc:
        raise HTTPException(status_code=409, detail="Esta fatura já foi marcada como paga.") from exc
    except ReceiptStorageError as exc:
        logger.error("Private receipt storage failed for bill %s", bill_id)
        raise HTTPException(
            status_code=503,
            detail="Não foi possível armazenar o comprovante. A fatura não foi marcada como paga.",
        ) from exc
    except PaymentPersistenceError as exc:
        logger.error("Payment persistence failed for bill %s", bill_id)
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
        logger.error("Private receipt access generation failed for bill %s", bill_id)
        raise HTTPException(
            status_code=503,
            detail="Não foi possível gerar acesso temporário ao comprovante.",
        ) from exc

    return {
        "status": "success",
        "url": access.signed_url,
        "expires_in": access.expires_in,
    }
