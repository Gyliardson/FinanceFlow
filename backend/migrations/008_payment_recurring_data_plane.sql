-- Migration 008: sanctioned payment and recurring-child mutations.
--
-- This is the second stage of the authenticated data-plane hardening. It does
-- not revoke direct table DML yet; the application must first be switched to
-- these RPCs and the PostgreSQL denial/positive-path probe must be updated.

CREATE TABLE IF NOT EXISTS financeflow_private.runtime_config (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    financial_timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo'
);

INSERT INTO financeflow_private.runtime_config(singleton, financial_timezone)
VALUES (TRUE, 'America/Sao_Paulo')
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON financeflow_private.runtime_config FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION financeflow_private.financial_today()
RETURNS DATE
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, financeflow_private
AS $$
    SELECT timezone(financial_timezone, now())::date
    FROM financeflow_private.runtime_config
    WHERE singleton = TRUE
$$;

REVOKE ALL ON FUNCTION financeflow_private.financial_today() FROM PUBLIC, anon, authenticated;

-- Convergent payment transition. The date is derived inside PostgreSQL from
-- operator-owned private configuration, so a direct authenticated RPC caller
-- cannot forge payment_date. Receipt path is optional because receipt-less
-- payment is a supported product operation; when present it must remain inside
-- the authenticated owner/bill namespace.
CREATE OR REPLACE FUNCTION public.finance_mark_bill_paid(
    p_bill_id UUID,
    p_receipt_path TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, financeflow_private
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_bill public.finance_bills%ROWTYPE;
    v_payment_date DATE;
    v_prefix TEXT;
    v_filename TEXT;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_bill
    FROM public.finance_bills
    WHERE id = p_bill_id AND owner_id = v_owner
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'bill_not_found' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(v_bill.is_recurring, FALSE) THEN
        RAISE EXCEPTION 'recurring_template_not_payable' USING ERRCODE = 'P0001';
    END IF;

    IF p_receipt_path IS NOT NULL THEN
        v_prefix := v_owner::TEXT || '/' || p_bill_id::TEXT || '/';
        IF left(p_receipt_path, char_length(v_prefix)) <> v_prefix THEN
            RAISE EXCEPTION 'receipt_path_owner_mismatch' USING ERRCODE = '22023';
        END IF;
        v_filename := substr(p_receipt_path, char_length(v_prefix) + 1);
        IF v_filename = '' OR strpos(v_filename, '/') > 0 OR strpos(v_filename, E'\\') > 0
           OR v_filename IN ('.', '..') OR char_length(v_filename) > 128 THEN
            RAISE EXCEPTION 'receipt_path_invalid' USING ERRCODE = '22023';
        END IF;
    END IF;

    IF v_bill.status = 'paid' THEN
        RETURN jsonb_build_object('status', 'info', 'data', to_jsonb(v_bill));
    END IF;

    v_payment_date := financeflow_private.financial_today();
    IF v_payment_date IS NULL THEN
        RAISE EXCEPTION 'financial_date_unavailable' USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.finance_bills
    SET status = 'paid',
        payment_date = v_payment_date,
        receipt_path = COALESCE(p_receipt_path, receipt_path)
    WHERE id = p_bill_id
      AND owner_id = v_owner
      AND COALESCE(is_recurring, FALSE) = FALSE
      AND status <> 'paid'
    RETURNING * INTO v_bill;

    IF NOT FOUND THEN
        -- The row is locked above, so this indicates an unexpected state change
        -- or constraint interaction. Fail closed rather than infer success.
        RAISE EXCEPTION 'payment_transition_not_confirmed' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object('status', 'success', 'data', to_jsonb(v_bill));
END;
$$;

-- Generate exactly the next child for one owner-scoped recurring template.
-- Every financial field is derived from the authoritative parent; the caller
-- supplies only the parent identifier. The due date follows the same product
-- rule as recurrence.py: clamp to shorter months and treat today as consumed.
CREATE OR REPLACE FUNCTION public.finance_generate_recurring_child(
    p_parent_bill_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, financeflow_private
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_parent public.finance_bills%ROWTYPE;
    v_today DATE;
    v_candidate DATE;
    v_target DATE;
    v_first_of_next DATE;
    v_last_day INTEGER;
    v_child public.finance_bills%ROWTYPE;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_parent
    FROM public.finance_bills
    WHERE id = p_parent_bill_id
      AND owner_id = v_owner
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'recurring_parent_not_found' USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(v_parent.is_recurring, FALSE) IS NOT TRUE
       OR v_parent.frequency IS DISTINCT FROM 'monthly'
       OR v_parent.recurring_day IS NULL
       OR v_parent.recurring_day < 1
       OR v_parent.recurring_day > 31 THEN
        RAISE EXCEPTION 'recurring_parent_invalid' USING ERRCODE = '22023';
    END IF;

    v_today := financeflow_private.financial_today();
    IF v_today IS NULL THEN
        RAISE EXCEPTION 'financial_date_unavailable' USING ERRCODE = 'P0001';
    END IF;

    v_last_day := extract(day FROM (date_trunc('month', v_today)::date + interval '1 month - 1 day'))::INTEGER;
    v_candidate := make_date(
        extract(year FROM v_today)::INTEGER,
        extract(month FROM v_today)::INTEGER,
        least(v_parent.recurring_day, v_last_day)
    );

    IF v_today < v_candidate THEN
        v_target := v_candidate;
    ELSE
        v_first_of_next := (date_trunc('month', v_today)::date + interval '1 month')::date;
        v_last_day := extract(day FROM (v_first_of_next + interval '1 month - 1 day'))::INTEGER;
        v_target := make_date(
            extract(year FROM v_first_of_next)::INTEGER,
            extract(month FROM v_first_of_next)::INTEGER,
            least(v_parent.recurring_day, v_last_day)
        );
    END IF;

    INSERT INTO public.finance_bills(
        owner_id,
        description,
        amount,
        due_date,
        status,
        parent_bill_id,
        is_recurring
    ) VALUES (
        v_owner,
        v_parent.description || ' - ' || to_char(v_target, 'MM/YYYY'),
        v_parent.amount,
        v_target,
        'pending',
        v_parent.id,
        FALSE
    )
    ON CONFLICT (parent_bill_id, due_date)
        WHERE parent_bill_id IS NOT NULL AND COALESCE(is_recurring, FALSE) = FALSE
    DO NOTHING
    RETURNING * INTO v_child;

    IF NOT FOUND THEN
        SELECT * INTO v_child
        FROM public.finance_bills
        WHERE owner_id = v_owner
          AND parent_bill_id = v_parent.id
          AND due_date = v_target
          AND COALESCE(is_recurring, FALSE) = FALSE
        LIMIT 1;
    END IF;

    IF v_child.id IS NULL THEN
        RAISE EXCEPTION 'recurring_child_not_confirmed' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object('status', 'success', 'data', to_jsonb(v_child));
END;
$$;

REVOKE ALL ON FUNCTION public.finance_mark_bill_paid(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_generate_recurring_child(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_mark_bill_paid(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_generate_recurring_child(UUID) TO authenticated;

-- Direct table DML remains temporarily available until application call sites
-- and the real-PostgreSQL verification gate have been migrated to these RPCs.
