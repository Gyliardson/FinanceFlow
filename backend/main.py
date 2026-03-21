from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from database import get_supabase_client
from ai_service import extract_invoice_data

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

@app.post("/upload-receipt", tags=["Bills", "OCR"])
async def upload_receipt(file: UploadFile = File(...)):
    """
    Recebe um arquivo de imagem ou PDF e envia para a Inteligência Artificial
    realizar o OCR, extraindo valor, data e linha digitável.
    """
    # Validações primárias de segurança
    allowed_types = ["image/jpeg", "image/png", "image/webp", "application/pdf"]
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Formato de arquivo não suportado. Envie imagens ou PDF.")
    
    try:
        # Ler conteúdo binário do arquivo na memória
        file_bytes = await file.read()
        
        # Repassa o trabalho pesado de IA para o ai_service
        resultado_ocr = extract_invoice_data(file_bytes, mime_type=file.content_type)
        
        if resultado_ocr.get("status") == "error":
            raise HTTPException(status_code=500, detail=resultado_ocr.get("message"))
            
        return {
            "message": "Arquivo processado com sucesso.",
            "filename": file.filename,
            "ocr_result": resultado_ocr["extracted_data"]
        }
        
    except ValueError as ve:
        # Dispara quando a API não está configurada no backend
        raise HTTPException(status_code=500, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Erro no processamento do arquivo: {str(e)}")
