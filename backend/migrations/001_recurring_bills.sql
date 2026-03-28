-- ============================================================================
-- Migration 001: Suporte a Faturas Recorrentes e Comprovantes
-- ============================================================================
-- Execute este SQL no "SQL Editor" do Supabase Dashboard.
-- Ele adiciona os campos necessários para contas recorrentes, comprovantes
-- e histórico de pagamentos à tabela `finance_bills`.
-- ============================================================================

-- 1. Novos campos na tabela finance_bills
ALTER TABLE finance_bills 
  ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS frequency TEXT DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS recurring_day INTEGER,
  ADD COLUMN IF NOT EXISTS parent_bill_id UUID REFERENCES finance_bills(id),
  ADD COLUMN IF NOT EXISTS receipt_url TEXT,
  ADD COLUMN IF NOT EXISTS payment_date DATE;

-- 2. Criar bucket para comprovantes no Storage (executar via Dashboard > Storage > New Bucket)
-- Nome: "receipts"
-- Public: false (privado, acesso via token)

-- 3. Índice para buscar faturas recorrentes rapidamente
CREATE INDEX IF NOT EXISTS idx_finance_bills_recurring ON finance_bills(is_recurring) WHERE is_recurring = TRUE;

-- 4. Índice para buscar filhas de um template recorrente
CREATE INDEX IF NOT EXISTS idx_finance_bills_parent ON finance_bills(parent_bill_id) WHERE parent_bill_id IS NOT NULL;

-- 5. Policy para storage (executar no SQL Editor)
-- Permite upload autenticado ou via service_role key
INSERT INTO storage.buckets (id, name, public) 
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;
