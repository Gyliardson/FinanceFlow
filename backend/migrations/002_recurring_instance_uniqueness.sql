-- ============================================================================
-- Migration 002: Idempotência de instâncias recorrentes
-- ============================================================================
-- Garante no PostgreSQL que um template recorrente produza no máximo uma
-- instância para a mesma data de vencimento, inclusive sob retries concorrentes.
-- ============================================================================

-- Remover duplicatas históricas antes de aplicar a garantia de unicidade.
-- O menor UUID é mantido de forma determinística; os demais registros do mesmo
-- (parent_bill_id, due_date) são removidos.
WITH ranked_instances AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY parent_bill_id, due_date
      ORDER BY id
    ) AS duplicate_rank
  FROM finance_bills
  WHERE parent_bill_id IS NOT NULL
    AND COALESCE(is_recurring, FALSE) = FALSE
)
DELETE FROM finance_bills AS bill
USING ranked_instances AS ranked
WHERE bill.id = ranked.id
  AND ranked.duplicate_rank > 1;

-- A aplicação ainda pode fazer pre-checks para evitar conflitos comuns, mas
-- esta constraint no banco é a autoridade final contra double submit/retry race.
CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_bills_generated_parent_due
  ON finance_bills(parent_bill_id, due_date)
  WHERE parent_bill_id IS NOT NULL
    AND COALESCE(is_recurring, FALSE) = FALSE;
