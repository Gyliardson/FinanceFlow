-- ============================================================================
-- Migration 002: Idempotência de instâncias recorrentes
-- ============================================================================
-- Garante no PostgreSQL que um template recorrente produza no máximo uma
-- instância para a mesma data de vencimento, inclusive sob retries concorrentes.
--
-- IMPORTANTE: esta migration é fail-closed. Ela nunca apaga silenciosamente
-- registros financeiros históricos para conseguir criar a constraint. Se já
-- existirem duplicatas, a aplicação da migration falha com diagnóstico e exige
-- reconciliação explícita antes de uma nova tentativa.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM finance_bills
    WHERE parent_bill_id IS NOT NULL
      AND COALESCE(is_recurring, FALSE) = FALSE
    GROUP BY parent_bill_id, due_date
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'Duplicate generated recurring bills exist; reconcile them before applying migration 002.',
      HINT = 'Inspect duplicate (parent_bill_id, due_date) groups and resolve them explicitly. No rows were deleted by this migration.';
  END IF;
END
$$;

-- A aplicação ainda pode fazer pre-checks para evitar conflitos comuns, mas
-- este índice no banco é a autoridade final contra double submit/retry race.
CREATE UNIQUE INDEX IF NOT EXISTS ux_finance_bills_generated_parent_due
  ON finance_bills(parent_bill_id, due_date)
  WHERE parent_bill_id IS NOT NULL
    AND COALESCE(is_recurring, FALSE) = FALSE;
