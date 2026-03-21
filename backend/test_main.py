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
