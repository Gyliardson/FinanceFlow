import os
from dotenv import load_dotenv
from supabase import create_client, Client

# Carrega as variáveis de ambiente do .env local
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

def get_supabase_client() -> Client:
    """
    Inicializa e retorna o client do Supabase.
    Lança um erro claro caso as chaves não existam.
    """
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ValueError("Chaves de ambiente do Supabase ausentes. Por favor, configure SUPABASE_URL e SUPABASE_KEY no arquivo .env.")
    
    return create_client(SUPABASE_URL, SUPABASE_KEY)
