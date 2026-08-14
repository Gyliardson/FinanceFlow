from fastapi import File, HTTPException, UploadFile

from ai_service import extract_invoice_data
from receipt_uploads import (
    MAX_RECEIPT_BYTES,
    ReceiptValidationError,
    sanitize_receipt_for_external_processing,
    validate_receipt_upload,
)


async def upload_receipt_for_ocr(file: UploadFile = File(...)):
    """Return non-authoritative OCR suggestions from a bounded validated document."""
    content = await file.read(MAX_RECEIPT_BYTES + 1)
    try:
        validated = validate_receipt_upload(content, file.content_type)
        provider_content = sanitize_receipt_for_external_processing(validated)
    except ReceiptValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    result = extract_invoice_data(provider_content, mime_type=validated.mime_type)
    if result.get("status") == "success":
        return {
            "message": "Documento processado. Revise os dados extraídos antes de confirmar.",
            "ocr_result": result["extracted_data"],
        }

    error_code = result.get("error_code")
    if error_code == "invalid_output":
        raise HTTPException(
            status_code=422,
            detail="O documento não pôde ser interpretado com segurança. Revise-o manualmente.",
        )
    if error_code == "rate_limited":
        raise HTTPException(
            status_code=503,
            detail="O serviço de OCR está temporariamente ocupado. Tente novamente mais tarde.",
            headers={"Retry-After": "60"},
        )
    if error_code == "timeout":
        raise HTTPException(
            status_code=504,
            detail="O serviço de OCR excedeu o tempo de resposta. Tente novamente.",
        )

    raise HTTPException(
        status_code=503,
        detail="O serviço de OCR está temporariamente indisponível.",
    )
