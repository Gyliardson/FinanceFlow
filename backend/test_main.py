from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_read_main():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Bem-vindo à API do FinanceFlow"}

def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "message": "A API está operante e saudável."}

def test_get_bills_integration():
    """Testa se a API consegue se conectar ao Supabase e ler a tabela."""
    response = client.get("/bills")
    assert response.status_code == 200, f"Erro na rota: {response.text}"
    
    data = response.json()
    assert "data" in data
    assert isinstance(data["data"], list)

from unittest.mock import patch

@patch("main.extract_invoice_data")
def test_upload_receipt(mock_extract):
    """Testa o endpoint de upload de comprovantes mockando a chamada da IA Gemini."""
    mock_extract.return_value = {
        "status": "success",
        "extracted_data": {
            "amount": 150.00,
            "due_date": "2023-12-01",
            "barcode": "123456789"
        }
    }
    
    file_content = b"fake image content"
    files = {"file": ("receipt.png", file_content, "image/png")}
    
    response = client.post("/upload-receipt", files=files)
    
    assert response.status_code == 200, f"Erro na rota: {response.text}"
    json_resp = response.json()
    assert json_resp["message"] == "Arquivo processado com sucesso."
    assert json_resp["ocr_result"]["amount"] == 150.00
