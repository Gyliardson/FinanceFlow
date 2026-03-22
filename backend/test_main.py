from fastapi.testclient import TestClient
from unittest.mock import patch
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

@patch("main.get_supabase_client")
def test_add_bill_record(mock_supabase):
    mock_execute = mock_supabase.return_value.table.return_value.insert.return_value.execute
    mock_execute.return_value.data = [{"id": "abc", "amount": 250.0}]
    
    payload = {"description": "Conta X", "amount": 250.0, "status": "pending", "due_date": "2026-05-10"}
    res = client.post("/add-bill", json=payload)
    assert res.status_code == 200
    r_json = res.json()
    assert r_json["status"] == "success"
    assert r_json["data"][0]["amount"] == 250.0

def test_get_bills_integration():
    """Testa se a API consegue se conectar ao Supabase e ler a tabela."""
    response = client.get("/bills")
    assert response.status_code == 200, f"Erro na rota: {response.text}"
    
    data = response.json()
    assert "data" in data
    assert isinstance(data["data"], list)


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

@patch("main.scrape_unopar")
@patch("main.get_supabase_client")
def test_scrape_unopar_route(mock_supabase, mock_scrape_unopar):
    # Mock supabase existing check
    mock_execute_select = mock_supabase.return_value.table.return_value.select.return_value.eq.return_value.execute
    mock_execute_select.return_value.data = [] # None existing

    # Mock supabase insert
    mock_execute_insert = mock_supabase.return_value.table.return_value.insert.return_value.execute
    mock_execute_insert.return_value.data = [{"id": "uuid-123", "amount": 650.0}]

    mock_scrape_unopar.return_value = {
        "status": "success",
        "description": "Mensalidade Unopar - 03/2026",
        "amount": 650.0,
        "due_date": "2026-03-10",
        "barcode": "34191.09008 00000.000000 00000.000000 1 00000000000000",
        "message": "Boleto lido"
    }

    from main import app
    from fastapi.testclient import TestClient
    c = TestClient(app)
    
    response = c.post("/scrape/unopar")
    assert response.status_code == 200
    res_json = response.json()
    assert res_json["status"] == "success"
    assert res_json["bill_data"][0]["amount"] == 650.0

@patch("main.get_supabase_client")
def test_validate_bill(mock_supabase):
    """Testa adequadamente o motor de tolerância e validação da fatura comparativa (OCR vs DB)."""
    # Mockando a cascata robusta do método de consulta da library do supabase
    mock_execute = mock_supabase.return_value.table.return_value.select.return_value.eq.return_value.execute
    mock_execute.return_value.data = [{
        "id": "123-abc",
        "amount": 100.00,
        "due_date": "2023-10-10",
        "barcode": "111222333"
    }]
    
    # Payload que a IA extrairia do PDF de teste (102.00 está coberto pela margem dos juros de 5% sobre 100.00!)
    payload_aprovado = {
        "bill_id": "123-abc",
        "ocr_amount": 102.00,
        "ocr_due_date": "2023-10-10",
        "ocr_barcode": "111222333"
    }
    
    resp_sucesso = client.post("/validate-bill", json=payload_aprovado)
    assert resp_sucesso.status_code == 200, f"Erro na rota validate-bill: {resp_sucesso.text}"
    
    # O mock deve ser considerado is_approved com confiança 100
    res_sucesso_json = resp_sucesso.json()
    assert res_sucesso_json["is_approved"] is True
    assert res_sucesso_json["confidence_score"] == 100
    assert res_sucesso_json["details"]["amount_match"] is True
    
    # Realoca payload com discrepância imensa em valores para testar reprovação garantida
    payload_reprovado = {
        "bill_id": "123-abc",
        "ocr_amount": 500.00,  # Valor extrapolado fora da janela de multa viável 
        "ocr_due_date": "2020-01-01",
        "ocr_barcode": "0000"
    }
    
    resp_falha = client.post("/validate-bill", json=payload_reprovado)
    res_falha_json = resp_falha.json()
    assert res_falha_json["is_approved"] is False
    assert res_falha_json["confidence_score"] == 0
