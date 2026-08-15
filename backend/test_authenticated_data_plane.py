from pathlib import Path


MIGRATION = Path(__file__).parent / "migrations" / "007_authenticated_data_plane.sql"


def _sql() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def test_existing_idempotent_rpcs_are_hardened_before_dml_revocation():
    sql = _sql()
    signatures = [
        "finance_idempotent_add_bill(TEXT, TEXT, TEXT, DATE, TEXT)",
        "finance_idempotent_add_income(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, BOOLEAN)",
        "finance_idempotent_add_reserve(TEXT, TEXT)",
        "finance_idempotent_create_recurring_template(TEXT, TEXT, TEXT, DATE, TEXT, TEXT, INTEGER)",
    ]

    for signature in signatures:
        assert f"ALTER FUNCTION public.{signature}\n    SECURITY DEFINER" in sql
        assert f"ALTER FUNCTION public.{signature}\n    SET search_path TO pg_catalog, public, financeflow_private" in sql

    assert "REVOKE ALL ON financeflow_private.idempotency_operations FROM authenticated" in sql
    assert "REVOKE USAGE ON SCHEMA financeflow_private FROM authenticated" in sql


def test_settings_rpcs_derive_owner_and_expose_only_sanctioned_fields():
    sql = _sql()

    for name in (
        "finance_replace_settings",
        "finance_update_emergency_fund_goal",
        "finance_store_insight",
    ):
        assert f"FUNCTION public.{name}" in sql

    assert sql.count("v_owner UUID := auth.uid()") >= 3
    assert "p_owner" not in sql
    assert "owner_id = v_owner" in sql
    assert "initial_balance_out_of_range" in sql
    assert "emergency_fund_goal_out_of_range" in sql
    assert "insight_text_invalid" in sql


def test_new_rpcs_are_not_public_or_anonymous():
    sql = _sql()

    assert "REVOKE ALL ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) FROM PUBLIC, anon" in sql
    assert "REVOKE ALL ON FUNCTION public.finance_update_emergency_fund_goal(TEXT) FROM PUBLIC, anon" in sql
    assert "REVOKE ALL ON FUNCTION public.finance_store_insight(TEXT, DATE) FROM PUBLIC, anon" in sql
    assert "GRANT EXECUTE ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) TO authenticated" in sql
    assert "GRANT EXECUTE ON FUNCTION public.finance_update_emergency_fund_goal(TEXT) TO authenticated" in sql
    assert "GRANT EXECUTE ON FUNCTION public.finance_store_insight(TEXT, DATE) TO authenticated" in sql


def test_staged_migration_does_not_revoke_table_dml_before_all_writes_are_converted():
    sql = _sql()
    # The P1 is not closed by this staged commit. Payment and recurring-child
    # mutations still need sanctioned RPCs before table DML can be revoked safely.
    assert "REVOKE INSERT, UPDATE, DELETE ON public.finance_bills" not in sql
    assert "REVOKE INSERT, UPDATE, DELETE ON public.finance_incomes" not in sql
    assert "REVOKE INSERT, UPDATE, DELETE ON public.finance_user_settings" not in sql
