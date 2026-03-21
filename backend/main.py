from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from database import get_supabase_client

app = FastAPI(
    title="FinanceFlow API",
    description="Backend API para automação e notificação de contas a pagar.",
    version="0.1.0"
)

# CORS config to allow mobile app to consume the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restringir em produção
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class HealthResponse(BaseModel):
    status: str
    message: str

@app.get("/", tags=["Health"])
async def root():
    return {"message": "Bem-vindo à API do FinanceFlow"}

@app.get("/health", response_model=HealthResponse, tags=["Health"])
async def health_check():
    """
    Verifica se a API está no ar.
    """
    return HealthResponse(status="ok", message="A API está operante e saudável.")

@app.get("/bills", tags=["Bills"])
async def get_bills():
    """
    Retorna as faturas cadastradas no Supabase.
    Essa rota valida a integração entre a API e o Banco.
    """
    try:
        supabase = get_supabase_client()
        response = supabase.table("finance_bills").select("*").execute()
        return {"data": response.data}
    except Exception as e:
        # Pega qualquer erro do Supabase ou de credenciais
        raise HTTPException(status_code=500, detail=str(e))
