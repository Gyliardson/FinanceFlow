-- Migration 010: keep initial-balance baselines at or before financial today.
--
-- The settings RPC is callable directly by the authenticated Data API role, so
-- the invariant cannot live only in FastAPI/mobile. Use the same private
-- financial calendar introduced for payment/recurrence semantics.

CREATE OR REPLACE FUNCTION public.finance_replace_settings(
    p_initial_balance TEXT,
    p_initial_balance_date DATE,
    p_emergency_fund_goal TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, financeflow_private
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_initial_balance NUMERIC;
    v_goal NUMERIC;
    v_today DATE;
    v_settings public.finance_user_settings%ROWTYPE;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;

    v_today := financeflow_private.financial_today();
    IF v_today IS NULL THEN
        RAISE EXCEPTION 'financial_date_unavailable' USING ERRCODE = 'P0001';
    END IF;
    IF p_initial_balance_date IS NULL OR p_initial_balance_date > v_today THEN
        RAISE EXCEPTION 'initial_balance_date_in_future' USING ERRCODE = '22023';
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

REVOKE ALL ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) TO authenticated;
