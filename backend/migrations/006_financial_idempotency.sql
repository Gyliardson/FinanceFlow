-- Migration 006: durable owner-scoped idempotency for non-convergent financial mutations.
--
-- Property: the idempotency claim and the financial effect commit in the SAME
-- PostgreSQL transaction. A committed effect therefore always has a durable
-- replay record; a rolled-back effect has neither. Concurrent requests with the
-- same owner/operation/key serialize at the composite primary key.
--
-- The request fingerprint is derived INSIDE PostgreSQL from canonical mutation
-- parameters. It is never accepted from the caller, so direct authenticated RPC
-- access cannot forge the payload identity used for replay/conflict detection.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS financeflow_private;
REVOKE ALL ON SCHEMA financeflow_private FROM PUBLIC;
GRANT USAGE ON SCHEMA financeflow_private TO authenticated;

CREATE TABLE IF NOT EXISTS financeflow_private.idempotency_operations (
    owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    operation_type TEXT NOT NULL CHECK (
        operation_type IN (
            'reserve_add',
            'bill_create',
            'income_create',
            'recurring_template_create'
        )
    ),
    idempotency_key TEXT NOT NULL CHECK (
        char_length(idempotency_key) BETWEEN 8 AND 128
        AND idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    ),
    request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, operation_type, idempotency_key)
);

ALTER TABLE financeflow_private.idempotency_operations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finance_idempotency_owner_select
    ON financeflow_private.idempotency_operations;
DROP POLICY IF EXISTS finance_idempotency_owner_insert
    ON financeflow_private.idempotency_operations;
DROP POLICY IF EXISTS finance_idempotency_owner_update
    ON financeflow_private.idempotency_operations;

CREATE POLICY finance_idempotency_owner_select
ON financeflow_private.idempotency_operations FOR SELECT TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_idempotency_owner_insert
ON financeflow_private.idempotency_operations FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

CREATE POLICY finance_idempotency_owner_update
ON financeflow_private.idempotency_operations FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id)
WITH CHECK ((SELECT auth.uid()) IS NOT NULL AND (SELECT auth.uid()) = owner_id);

REVOKE ALL ON financeflow_private.idempotency_operations FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE ON financeflow_private.idempotency_operations TO authenticated;

CREATE OR REPLACE FUNCTION financeflow_private.payload_fingerprint(p_payload JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $$
    SELECT encode(digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex')
$$;

REVOKE ALL ON FUNCTION financeflow_private.payload_fingerprint(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION financeflow_private.payload_fingerprint(JSONB) TO authenticated;

-- The private schema is not part of the normal Data API exposure. The grants above
-- exist so SECURITY INVOKER RPCs can operate under the authenticated role while RLS
-- remains authoritative. Clients receive no owner or fingerprint parameter.

CREATE OR REPLACE FUNCTION public.finance_idempotent_add_bill(
    p_idempotency_key TEXT,
    p_description TEXT,
    p_amount TEXT,
    p_due_date DATE,
    p_barcode TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, financeflow_private, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_amount NUMERIC;
    v_request_fingerprint TEXT;
    v_claimed BOOLEAN := false;
    v_existing_fingerprint TEXT;
    v_existing_result JSONB;
    v_bill finance_bills%ROWTYPE;
    v_result JSONB;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;
    v_amount := p_amount::NUMERIC;
    IF v_amount <= 0 OR v_amount > 1000000.00 THEN
        RAISE EXCEPTION 'bill_amount_out_of_range' USING ERRCODE = '22003';
    END IF;

    v_request_fingerprint := financeflow_private.payload_fingerprint(
        jsonb_build_object(
            'description', p_description,
            'amount', trim_scale(v_amount)::TEXT,
            'due_date', p_due_date::TEXT,
            'barcode', p_barcode
        )
    );

    INSERT INTO financeflow_private.idempotency_operations(
        owner_id, operation_type, idempotency_key, request_fingerprint
    ) VALUES (v_owner, 'bill_create', p_idempotency_key, v_request_fingerprint)
    ON CONFLICT (owner_id, operation_type, idempotency_key) DO NOTHING
    RETURNING true INTO v_claimed;

    IF NOT COALESCE(v_claimed, false) THEN
        SELECT request_fingerprint, result
        INTO v_existing_fingerprint, v_existing_result
        FROM financeflow_private.idempotency_operations
        WHERE owner_id = v_owner
          AND operation_type = 'bill_create'
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;

        IF v_existing_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
            RAISE EXCEPTION 'idempotency_key_payload_mismatch' USING ERRCODE = 'P0001';
        END IF;
        IF v_existing_result IS NULL THEN
            RAISE EXCEPTION 'idempotency_record_incomplete' USING ERRCODE = 'P0001';
        END IF;
        RETURN v_existing_result;
    END IF;

    INSERT INTO finance_bills(
        owner_id, description, amount, due_date, barcode, status
    ) VALUES (
        v_owner, p_description, v_amount, p_due_date, p_barcode, 'pending'
    ) RETURNING * INTO v_bill;

    v_result := jsonb_build_object('status', 'success', 'data', jsonb_build_array(to_jsonb(v_bill)));

    UPDATE financeflow_private.idempotency_operations
    SET result = v_result, completed_at = now()
    WHERE owner_id = v_owner
      AND operation_type = 'bill_create'
      AND idempotency_key = p_idempotency_key;

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_idempotent_add_income(
    p_idempotency_key TEXT,
    p_title TEXT,
    p_amount TEXT,
    p_date DATE,
    p_description TEXT,
    p_type TEXT,
    p_is_recurring BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, financeflow_private, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_amount NUMERIC;
    v_request_fingerprint TEXT;
    v_claimed BOOLEAN := false;
    v_existing_fingerprint TEXT;
    v_existing_result JSONB;
    v_income finance_incomes%ROWTYPE;
    v_result JSONB;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;
    v_amount := p_amount::NUMERIC;
    IF v_amount <= 0 OR v_amount > 1000000.00 THEN
        RAISE EXCEPTION 'income_amount_out_of_range' USING ERRCODE = '22003';
    END IF;
    IF p_type NOT IN ('salary', 'extra', 'adjustment') THEN
        RAISE EXCEPTION 'income_type_invalid' USING ERRCODE = '22023';
    END IF;

    v_request_fingerprint := financeflow_private.payload_fingerprint(
        jsonb_build_object(
            'title', p_title,
            'amount', trim_scale(v_amount)::TEXT,
            'date', p_date::TEXT,
            'description', p_description,
            'type', p_type,
            'is_recurring', p_is_recurring
        )
    );

    INSERT INTO financeflow_private.idempotency_operations(
        owner_id, operation_type, idempotency_key, request_fingerprint
    ) VALUES (v_owner, 'income_create', p_idempotency_key, v_request_fingerprint)
    ON CONFLICT (owner_id, operation_type, idempotency_key) DO NOTHING
    RETURNING true INTO v_claimed;

    IF NOT COALESCE(v_claimed, false) THEN
        SELECT request_fingerprint, result
        INTO v_existing_fingerprint, v_existing_result
        FROM financeflow_private.idempotency_operations
        WHERE owner_id = v_owner
          AND operation_type = 'income_create'
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;

        IF v_existing_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
            RAISE EXCEPTION 'idempotency_key_payload_mismatch' USING ERRCODE = 'P0001';
        END IF;
        IF v_existing_result IS NULL THEN
            RAISE EXCEPTION 'idempotency_record_incomplete' USING ERRCODE = 'P0001';
        END IF;
        RETURN v_existing_result;
    END IF;

    INSERT INTO finance_incomes(
        owner_id, title, amount, date, description, type, is_recurring
    ) VALUES (
        v_owner, p_title, v_amount, p_date, p_description, p_type, p_is_recurring
    ) RETURNING * INTO v_income;

    v_result := jsonb_build_object('status', 'success', 'data', jsonb_build_array(to_jsonb(v_income)));

    UPDATE financeflow_private.idempotency_operations
    SET result = v_result, completed_at = now()
    WHERE owner_id = v_owner
      AND operation_type = 'income_create'
      AND idempotency_key = p_idempotency_key;

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_idempotent_add_reserve(
    p_idempotency_key TEXT,
    p_amount TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, financeflow_private, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_amount NUMERIC;
    v_request_fingerprint TEXT;
    v_claimed BOOLEAN := false;
    v_existing_fingerprint TEXT;
    v_existing_result JSONB;
    v_settings finance_user_settings%ROWTYPE;
    v_result JSONB;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;
    v_amount := p_amount::NUMERIC;
    IF v_amount <= 0 OR v_amount > 1000000.00 THEN
        RAISE EXCEPTION 'reserve_amount_out_of_range' USING ERRCODE = '22003';
    END IF;

    v_request_fingerprint := financeflow_private.payload_fingerprint(
        jsonb_build_object('amount', trim_scale(v_amount)::TEXT)
    );

    INSERT INTO financeflow_private.idempotency_operations(
        owner_id, operation_type, idempotency_key, request_fingerprint
    ) VALUES (v_owner, 'reserve_add', p_idempotency_key, v_request_fingerprint)
    ON CONFLICT (owner_id, operation_type, idempotency_key) DO NOTHING
    RETURNING true INTO v_claimed;

    IF NOT COALESCE(v_claimed, false) THEN
        SELECT request_fingerprint, result
        INTO v_existing_fingerprint, v_existing_result
        FROM financeflow_private.idempotency_operations
        WHERE owner_id = v_owner
          AND operation_type = 'reserve_add'
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;

        IF v_existing_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
            RAISE EXCEPTION 'idempotency_key_payload_mismatch' USING ERRCODE = 'P0001';
        END IF;
        IF v_existing_result IS NULL THEN
            RAISE EXCEPTION 'idempotency_record_incomplete' USING ERRCODE = 'P0001';
        END IF;
        RETURN v_existing_result;
    END IF;

    UPDATE finance_user_settings
    SET emergency_fund_balance = COALESCE(emergency_fund_balance, 0) + v_amount
    WHERE owner_id = v_owner
    RETURNING * INTO v_settings;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'reserve_settings_not_found' USING ERRCODE = 'P0001';
    END IF;

    v_result := jsonb_build_object(
        'status', 'success',
        'message', 'Fundo de reserva atualizado com sucesso.',
        'data', to_jsonb(v_settings)
    );

    UPDATE financeflow_private.idempotency_operations
    SET result = v_result, completed_at = now()
    WHERE owner_id = v_owner
      AND operation_type = 'reserve_add'
      AND idempotency_key = p_idempotency_key;

    RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.finance_idempotent_create_recurring_template(
    p_idempotency_key TEXT,
    p_title TEXT,
    p_amount TEXT,
    p_due_date DATE,
    p_description TEXT,
    p_frequency TEXT,
    p_recurring_day INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, financeflow_private, pg_temp
AS $$
DECLARE
    v_owner UUID := auth.uid();
    v_amount NUMERIC;
    v_request_fingerprint TEXT;
    v_claimed BOOLEAN := false;
    v_existing_fingerprint TEXT;
    v_existing_result JSONB;
    v_bill finance_bills%ROWTYPE;
    v_result JSONB;
BEGIN
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'authenticated_owner_required' USING ERRCODE = 'P0001';
    END IF;
    v_amount := p_amount::NUMERIC;
    IF v_amount <= 0 OR v_amount > 1000000.00 THEN
        RAISE EXCEPTION 'recurring_amount_out_of_range' USING ERRCODE = '22003';
    END IF;
    IF p_frequency <> 'monthly' OR p_recurring_day < 1 OR p_recurring_day > 31 THEN
        RAISE EXCEPTION 'recurring_contract_invalid' USING ERRCODE = '22023';
    END IF;

    -- p_due_date is derived by the backend from the financial calendar and is
    -- deliberately excluded from the logical fingerprint. Retrying the same
    -- unresolved template intent after midnight/month rollover must replay the
    -- already-committed template instead of conflicting on a newly-derived date.
    v_request_fingerprint := financeflow_private.payload_fingerprint(
        jsonb_build_object(
            'title', p_title,
            'amount', trim_scale(v_amount)::TEXT,
            'description', p_description,
            'frequency', p_frequency,
            'recurring_day', p_recurring_day
        )
    );

    INSERT INTO financeflow_private.idempotency_operations(
        owner_id, operation_type, idempotency_key, request_fingerprint
    ) VALUES (v_owner, 'recurring_template_create', p_idempotency_key, v_request_fingerprint)
    ON CONFLICT (owner_id, operation_type, idempotency_key) DO NOTHING
    RETURNING true INTO v_claimed;

    IF NOT COALESCE(v_claimed, false) THEN
        SELECT request_fingerprint, result
        INTO v_existing_fingerprint, v_existing_result
        FROM financeflow_private.idempotency_operations
        WHERE owner_id = v_owner
          AND operation_type = 'recurring_template_create'
          AND idempotency_key = p_idempotency_key
        FOR UPDATE;

        IF v_existing_fingerprint IS DISTINCT FROM v_request_fingerprint THEN
            RAISE EXCEPTION 'idempotency_key_payload_mismatch' USING ERRCODE = 'P0001';
        END IF;
        IF v_existing_result IS NULL THEN
            RAISE EXCEPTION 'idempotency_record_incomplete' USING ERRCODE = 'P0001';
        END IF;
        RETURN v_existing_result;
    END IF;

    INSERT INTO finance_bills(
        owner_id,
        description,
        amount,
        due_date,
        barcode,
        status,
        is_recurring,
        frequency,
        recurring_day
    ) VALUES (
        v_owner,
        p_title,
        v_amount,
        p_due_date,
        p_description,
        'pending',
        true,
        p_frequency,
        p_recurring_day
    ) RETURNING * INTO v_bill;

    v_result := jsonb_build_object('status', 'success', 'data', jsonb_build_array(to_jsonb(v_bill)));

    UPDATE financeflow_private.idempotency_operations
    SET result = v_result, completed_at = now()
    WHERE owner_id = v_owner
      AND operation_type = 'recurring_template_create'
      AND idempotency_key = p_idempotency_key;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.finance_idempotent_add_bill(TEXT, TEXT, TEXT, DATE, TEXT)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_idempotent_add_income(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, BOOLEAN)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_idempotent_add_reserve(TEXT, TEXT)
    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finance_idempotent_create_recurring_template(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.finance_idempotent_add_bill(TEXT, TEXT, TEXT, DATE, TEXT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_idempotent_add_income(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, BOOLEAN)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_idempotent_add_reserve(TEXT, TEXT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.finance_idempotent_create_recurring_template(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, INTEGER)
    TO authenticated;

COMMENT ON TABLE financeflow_private.idempotency_operations IS
'Durable replay ledger for non-convergent financial POST mutations. Records are retained until explicit operator lifecycle cleanup; production policy must keep them for at least the documented retry window.';
