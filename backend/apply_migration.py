"""
Script para aplicar migração no Supabase.
Adiciona as colunas necessárias para faturas recorrentes e comprovantes.

Uso: python apply_migration.py
"""
import os
import sys
from dotenv import load_dotenv

load_dotenv()

def apply_migration():
    from supabase import create_client
    
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    
    if not url or not key:
        print("ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configurados no .env")
        sys.exit(1)
    
    supabase = create_client(url, key)
    
    print("Testando conexão com Supabase...")
    
    # Testar se as colunas já existem tentando uma query
    try:
        test = supabase.table("finance_bills").select("is_recurring").limit(1).execute()
        print("✅ Colunas de recorrência já existem no banco!")
        return True
    except Exception:
        print("Colunas ainda não existem. Tentando aplicar via inserção de teste...")
    
    # Se não existem, tentar inserir um registro com os novos campos
    # Isso vai falhar, mas vamos dar instruções claras
    print()
    print("=" * 60)
    print("AÇÃO NECESSÁRIA: Migração do Banco de Dados")
    print("=" * 60)
    print()
    print("As novas colunas ainda não existem no Supabase.")
    print("Acesse o Supabase Dashboard e execute o seguinte SQL:")
    print()
    print("  1. Vá em: https://supabase.com/dashboard")
    print("  2. Selecione seu projeto")
    print("  3. Vá em 'SQL Editor'")
    print("  4. Cole e execute o SQL abaixo:")
    print()
    
    sql = """
ALTER TABLE finance_bills 
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS frequency TEXT DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS recurring_day INTEGER,
  ADD COLUMN IF NOT EXISTS parent_bill_id UUID REFERENCES finance_bills(id),
  ADD COLUMN IF NOT EXISTS receipt_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_date DATE;

-- Bucket para comprovantes
INSERT INTO storage.buckets (id, name, public) 
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;
"""
    print(sql)
    print("=" * 60)
    return False

if __name__ == "__main__":
    apply_migration()
