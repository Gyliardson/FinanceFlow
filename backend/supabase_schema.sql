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

-- ==========================================================
-- Tabelas para Gestão de Renda e Configurações (Fase 6)
-- ==========================================================

-- Tabela de Receitas / Renda
CREATE TABLE IF NOT EXISTS finance_incomes (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    date DATE NOT NULL,
    type TEXT DEFAULT 'salary' CHECK (type IN ('salary', 'extra', 'adjustment')),
    is_recurring BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE finance_incomes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_mvp_incomes" ON finance_incomes
    FOR ALL USING (true) WITH CHECK (true);

-- Tabela de Configurações do Usuário (Saldo Inicial, Metas)
CREATE TABLE IF NOT EXISTS finance_user_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    initial_balance DECIMAL(10, 2) DEFAULT 0.0,
    initial_balance_date DATE DEFAULT CURRENT_DATE,
    emergency_fund_goal DECIMAL(10, 2) DEFAULT 0.0,
    emergency_fund_balance DECIMAL(10, 2) DEFAULT 0.0,
    latest_insight_text TEXT,
    latest_insight_date DATE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE finance_user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_all_mvp_settings" ON finance_user_settings
    FOR ALL USING (true) WITH CHECK (true);
