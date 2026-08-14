from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import secure_routes
from receipt_access import ReceiptAccessError, ReceiptAccessResult, ReceiptNotFoundError
from receipt_payments import (
    BillAlreadyPaidError,
    BillNotFoundError,
    PaymentPersistenceError,
    ReceiptPaymentResult,
    ReceiptStorageError,
)
from receipt_uploads import MAX_RECEIPT_BYTES, ReceiptValidationError


BILL_ID = "22222222-2222-4222-8222-222222222222"
OWNER_ID = "11111111-1111-4111-8111-111111111111"


class FakeUpload:
    def __init__(self, content=b"receipt", content_type="image/jpeg"):
        self.content = content
        self.content_type = content_type
        self.read_sizes = []

    async def read(self, size=-1):
        self.read_sizes.append(size)
        return self.content[:size] if size >= 0 else self.content


def _install_authenticated_context(monkeypatch):
    data_client = object()
    storage_client = object()
    monkeypatch.setattr(secure_routes, "get_request_user_id", lambda: OWNER_ID)
    monkeypatch.setattr(secure_routes, "get_supabase_client", lambda: data_client)
    monkeypatch.setattr(secure_routes, "get_supabase_storage_client", lambda: storage_client)
    return data_client, storage_client


@pytest.mark.asyncio
async def test_private_payment_route_uses_bounded_read_and_returns_no_receipt_url(monkeypatch):
    data_client, storage_client = _install_authenticated_context(monkeypatch)
    upload = FakeUpload(b"synthetic")
    calls = []

    def fake_persist(**kwargs):
        calls.append(kwargs)
        return ReceiptPaymentResult(
            bill_id=BILL_ID,
            receipt_path=f"{OWNER_ID}/{BILL_ID}/opaque.jpg",
            payment_date="2026-08-14",
        )

    monkeypatch.setattr(secure_routes, "persist_private_receipt_payment", fake_persist)

    response = await secure_routes.pay_bill_with_private_receipt(BILL_ID, upload)

    assert upload.read_sizes == [MAX_RECEIPT_BYTES + 1]
    assert calls == [
        {
            "data_client": data_client,
            "storage_client": storage_client,
            "owner_id": OWNER_ID,
            "bill_id": BILL_ID,
            "content": b"synthetic",
            "declared_mime_type": "image/jpeg",
        }
    ]
    assert response == {
        "status": "success",
        "message": "Fatura marcada como paga com comprovante privado.",
        "payment_date": "2026-08-14",
    }
    assert "url" not in response
    assert "receipt_path" not in response


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "status_code", "public_detail"),
    [
        (ReceiptValidationError("Receipt file exceeds the allowed size."), 400, "Receipt file exceeds the allowed size."),
        (BillNotFoundError("internal scope detail"), 404, "Fatura não encontrada."),
        (BillAlreadyPaidError("internal state detail"), 409, "Esta fatura já foi marcada como paga."),
        (
            ReceiptStorageError("provider secret detail"),
            503,
            "Não foi possível armazenar o comprovante. A fatura não foi marcada como paga.",
        ),
        (
            PaymentPersistenceError("database secret detail"),
            409,
            "O pagamento não pôde ser confirmado. Atualize os dados e tente novamente.",
        ),
    ],
)
async def test_private_payment_route_maps_failures_without_provider_leak(
    monkeypatch, error, status_code, public_detail
):
    _install_authenticated_context(monkeypatch)
    monkeypatch.setattr(
        secure_routes,
        "persist_private_receipt_payment",
        lambda **_kwargs: (_ for _ in ()).throw(error),
    )

    with pytest.raises(HTTPException) as captured:
        await secure_routes.pay_bill_with_private_receipt(BILL_ID, FakeUpload())

    assert captured.value.status_code == status_code
    assert captured.value.detail == public_detail
    assert "secret detail" not in str(captured.value.detail)


@pytest.mark.asyncio
async def test_private_payment_route_fails_closed_without_user_context(monkeypatch):
    monkeypatch.setattr(secure_routes, "get_request_user_id", lambda: None)

    with pytest.raises(HTTPException) as captured:
        await secure_routes.pay_bill_with_private_receipt(BILL_ID, FakeUpload())

    assert captured.value.status_code == 401


def test_private_receipt_access_returns_only_temporary_url_metadata(monkeypatch):
    data_client, _storage_client = _install_authenticated_context(monkeypatch)
    calls = []

    def fake_access(**kwargs):
        calls.append(kwargs)
        return ReceiptAccessResult(
            bill_id=BILL_ID,
            receipt_path=f"{OWNER_ID}/{BILL_ID}/opaque.pdf",
            signed_url="https://signed.invalid/temporary",
            expires_in=300,
        )

    monkeypatch.setattr(secure_routes, "create_authorized_receipt_access", fake_access)

    response = secure_routes.get_private_receipt_access(BILL_ID)

    assert calls == [
        {
            "data_client": data_client,
            "owner_id": OWNER_ID,
            "bill_id": BILL_ID,
        }
    ]
    assert response == {
        "status": "success",
        "url": "https://signed.invalid/temporary",
        "expires_in": 300,
    }
    assert "receipt_path" not in response


@pytest.mark.parametrize(
    ("error", "status_code", "detail"),
    [
        (ReceiptNotFoundError("cross-user detail"), 404, "Comprovante não encontrado."),
        (
            ReceiptAccessError("provider detail"),
            503,
            "Não foi possível gerar acesso temporário ao comprovante.",
        ),
        (
            ValueError("path detail"),
            503,
            "Não foi possível gerar acesso temporário ao comprovante.",
        ),
    ],
)
def test_private_receipt_access_maps_failures_without_internal_detail(
    monkeypatch, error, status_code, detail
):
    _install_authenticated_context(monkeypatch)
    monkeypatch.setattr(
        secure_routes,
        "create_authorized_receipt_access",
        lambda **_kwargs: (_ for _ in ()).throw(error),
    )

    with pytest.raises(HTTPException) as captured:
        secure_routes.get_private_receipt_access(BILL_ID)

    assert captured.value.status_code == status_code
    assert captured.value.detail == detail
    assert "detail" not in captured.value.detail.lower()
