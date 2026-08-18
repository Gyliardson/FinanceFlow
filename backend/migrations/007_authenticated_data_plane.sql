-- Migration 007: least-privilege authenticated financial data plane.
--
-- This migration is deliberately staged. It first converts canonical write
-- operations to narrowly scoped owner-derived RPCs. Direct financial table DML
-- is revoked only after every production write path has a sanctioned function
-- and the PostgreSQL verification probe has been converted to denial tests.
--
-- SECURITY DEFINER is used only for functions whose complete mutation surface is
-- encoded below. Caller identity always comes from auth.uid(); no function accepts
-- owner_id. PUBLIC/anon execution is explicitly revoked and search_path is fixed.

-- Migration 006 functions used SECURITY INVOKER while authenticated still had
-- direct table DML. Harden them now so they continue to operate after table DML
-- is eventually revoked. Their bodies already derive owner exclusively from
-- auth.uid(), validate the financial payload, and atomically write the private
-- idempotency ledger plus the financial effect.
ALTER FUNCTION public.finance_idempotent_add_bill(TEXT, TEXT, TEXT, DATE, TEXT)
    SECURITY DEFINER;
ALTER FUNCTION public.finance_idempotent_add_bill(TEXT, TEXT, TEXT, DATE, TEXT)
    SET search_path TO pg_catalog, public, financeflow_private;

ALTER FUNCTION public.finance_idempotent_add_income(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, BOOLEAN)
    SECURITY DEFINER;
ALTER FUNCTION public.finance_idempotent_add_income(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, BOOLEAN)
    SET search_path TO pg_catalog, public, financeflow_private;

ALTER FUNCTION public.finance_idempotent_add_reserve(TEXT, TEXT)
    SECURITY DEFINER;
ALTER FUNCTION public.finance_idempotent_add_reserve(TEXT, TEXT)
    SET search_path TO pg_catalog, public, financeflow_private;

ALTER FUNCTION public.finance_idempotent_create_recurring_template(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, INTEGER)
    SECURITY DEFINER;
ALTER FUNCTION public.finance_idempotent_create_recurring_template(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, INTEGER)
    SET search_path TO pg_catalog, public, financeflow_private;

REVOKE ALL ON financeflow_private.idempotency_operations FROM authenticated;
REVOKE EXECUTE ON FUNCTION financeflow_private.payload_fingerprint(JSONB) FROM authenticated;
REVOKE USAGE ON SCHEMA financeflow_private FROM authenticated;

-- Full settings replacement is an intended user operation, but it may only
-- modify the three fields accepted by the FastAPI SettingsUpdateRequest. Reserve
-- balance and persisted insight fields are intentionally preserved on update.
CREATE OR REPLACE FUNCTION public.finance_replace_settings(
    p_initial_balance TEXT,
    p_initial_balance_date DATE,
    p_emergency_fund_goal TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_initial_balance NUMERIC;
    v_goal NUMERIC;
    v_settings public.finance_user_settings%ROWTYPE;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;

    v_initial_balance := p_initial_balance::NUMERIC;
    v_goal := p_emergency_fund_goal::NUMERIC;
    IF v_initial_balance < -1000000.00 OR v_initial_balance > 1000000.00 THEN
        RAISE EXCEPTION 'initial_balance_out_of_range' USING ERRCODE = '22003';
    END IF;
    IF v_goal < 0 OR v_goal > 1000000.00 THEN
        RAISE EXCEPTION 'emergency_fund_goal_out_of_range' USING ERRCODE = '22003';
    END IF;

    INSERT INTO public.finance_user_settings(
        owner_id,
        initial_balance,
        initial_balance_date,
        emergency_fund_goal,
        updated_at
    ) VALUES (
        v_owner,
        v_initial_balance,
        p_initial_balance_date,
        v_goal,
        now()
    )
    ON CONFLICT (owner_id) WHERE owner_id IS NOT NULL
    DO UPDATE SET
        initial_balance = EXCLUDED.initial_balance,
        initial_balance_date = EXCLUDED.initial_balance_date,
        emergency_fund_goal = EXCLUDED.emergency_fund_goal,
        updated_at = now()
    RETURNING * INTO v_settings;

    RETURN jsonb_build_object('status', 'success', 'data', to_jsonb(v_settings));
END;
$$;

-- The goal editor must not have write access to unrelated settings fields.
CREATE OR REPLACE FUNCTION public.finance_update_emergency_fund_goal(
    p_emergency_fund_goal TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_goal NUMERIC;
    v_settings public.finance_user_settings%ROWTYPE;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;

    v_goal := p_emergency_fund_goal::NUMERIC;
    IF v_goal < 0 OR v_goal > 1000000.00 THEN
        RAISE EXCEPTION 'emergency_fund_goal_out_of_range' USING ERRCODE = '22003';
    END IF;

    UPDATE public.finance_user_settings
    SET emergency_fund_goal = v_goal,
        updated_at = now()
    WHERE owner_id = v_owner
    RETURNING * INTO v_settings;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'settings_not_found' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object('status', 'success', 'data', to_jsonb(v_settings));
END;
$$;

-- Persisted AI insight is non-authoritative presentation state. This RPC is
-- field-specific so it cannot alter balances, goals, dates or ownership. The
-- FastAPI route remains the only production path that invokes the external AI
-- provider; direct RPC invocation cannot trigger provider/network activity.
CREATE OR REPLACE FUNCTION public.finance_store_insight(
    p_insight_text TEXT,
    p_insight_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_settings public.finance_user_settings%ROWTYPE;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;
    IF p_insight_text IS NULL OR btrim(p_insight_text) = '' OR char_length(p_insight_text) > 10000 THEN
        RAISE EXCEPTION 'insight_text_invalid' USING ERRCODE = '22023';
    END IF;

    UPDATE public.finance_user_settings
    SET latest_insight_text = p_insight_text,
        latest_insight_date = p_insight_date,
        updated_at = now()
    WHERE owner_id = v_owner
    RETURNING * INTO v_settings;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'settings_not_found' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object('status', 'success', 'data', to_jsonb(v_settings));
END;
$$;

REVOKE ALL ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_update_emergency_fund_goal(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_store_insight(TEXT, DATE) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_update_emergency_fund_goal(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_store_insight(TEXT, DATE) TO authenticated;

-- IMPORTANT: do not revoke INSERT/UPDATE/DELETE on the three financial tables in
-- this staged commit. Payment and recurring-child writes are converted in the
-- next part of this migration before the final privilege revocation is added.
