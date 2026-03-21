-- ==========================================================
-- FinanceFlow - Schema Inicial (PostgreSQL / Supabase)
-- Descrição: Tabelas primárias para a funcionalidade da API.
-- Uso: Execute este script no SQL Editor do Supabase antes de rodar a API.
-- ==========================================================

-- Tabela principal de Faturas/Boletos
CREATE TABLE IF NOT EXISTS finance_bills (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    description TEXT NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    due_date DATE NOT NULL,
    barcode TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'overdue')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Ativar Row Level Security (RLS) para proteger acessos
ALTER TABLE finance_bills ENABLE ROW LEVEL SECURITY;

-- Política de acesso público temporária para a Fase de MVP (Ausência de sistema de autenticação focado).
-- Em um ambiente de produção real, é fundamental aplicar restrições vinculadas ao 'auth.uid()'.
CREATE POLICY "allow_all_mvp" ON finance_bills
    FOR ALL
    USING (true)
    WITH CHECK (true);
