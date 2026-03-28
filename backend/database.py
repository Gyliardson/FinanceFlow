import os
import logging
from dotenv import load_dotenv
from supabase import create_client, Client

# Carrega as variáveis de ambiente do .env local
load_dotenv()

logger = logging.getLogger(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

def get_supabase_client() -> Client:
    """
    Inicializa e retorna o client do Supabase (chave pública/anon).
    Usado para operações de leitura/escrita em tabelas.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ValueError("Chaves de ambiente do Supabase ausentes. Por favor, configure SUPABASE_URL e SUPABASE_KEY no arquivo .env.")
    
    return create_client(SUPABASE_URL, SUPABASE_KEY)

def get_supabase_storage_client() -> Client:
    """
    Retorna um client do Supabase com Service Role Key para operações de Storage.
    A chave pública (anon) não tem permissão para criar buckets ou fazer uploads
    sem políticas de Storage explícitas. A Service Role Key bypassa RLS.
    
    Se a Service Role Key não estiver configurada, usa a chave pública como fallback.
    """
    if not SUPABASE_URL:
        raise ValueError("SUPABASE_URL ausente no .env.")
    
    key = SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY
    if not key:
        raise ValueError("Nenhuma chave Supabase configurada no .env.")
    
    if not SUPABASE_SERVICE_ROLE_KEY:
        logger.warning(
            "SUPABASE_SERVICE_ROLE_KEY nao configurada! "
            "Usando chave publica - uploads podem falhar por falta de permissao. "
            "Configure SUPABASE_SERVICE_ROLE_KEY no .env para resolver."
        )
    
    return create_client(SUPABASE_URL, key)

def ensure_receipts_bucket():
    """
    Garante que o bucket 'receipts' exista no Supabase Storage e seja público.
    Deve ser chamado na inicialização da aplicação.
    """
    try:
        storage_client = get_supabase_storage_client()
        storage_client.storage.create_bucket('receipts', options={'public': True})
        logger.info("Bucket 'receipts' criado com sucesso (publico).")
    except Exception as e:
        error_str = str(e)
        if 'already exists' in error_str.lower() or 'duplicate' in error_str.lower() or '409' in error_str:
            logger.info("Bucket 'receipts' ja existe. Garantindo que seja publico...")
            try:
                storage_client = get_supabase_storage_client()
                storage_client.storage.update_bucket('receipts', options={'public': True})
                logger.info("Bucket 'receipts' atualizado para publico.")
            except Exception as update_err:
                logger.warning(f"Nao foi possivel atualizar bucket: {update_err}")
        else:
            logger.error(f"Falha ao criar bucket 'receipts': {e}")
