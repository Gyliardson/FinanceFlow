from pathlib import Path


MIGRATIONS = Path(__file__).parent / "migrations"


def _sql(name: str) -> str:
    return (MIGRATIONS / name).read_text(encoding="utf-8")


def test_existing_idempotent_rpcs_are_hardened_before_dml_revocation():
    sql = _sql("007_authenticated_data_plane.sql")
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
    sql = _sql("007_authenticated_data_plane.sql")

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


def test_payment_and_recurring_rpcs_derive_authoritative_financial_state():
    sql = _sql("008_payment_recurring_data_plane.sql")

    assert "FUNCTION public.finance_mark_bill_paid" in sql
    assert "FUNCTION public.finance_generate_recurring_child" in sql
    assert sql.count("v_owner UUID := auth.uid()") >= 2
    assert "p_owner" not in sql
    assert "financeflow_private.financial_today()" in sql
    assert "p_payment_date" not in sql
    assert "v_parent.amount" in sql
    assert "v_parent.description" in sql
    assert "least(v_parent.recurring_day, v_last_day)" in sql
    assert "receipt_path_owner_mismatch" in sql


def test_all_sanctioned_rpcs_are_not_public_or_anonymous():
    settings_sql = _sql("007_authenticated_data_plane.sql")
    payment_sql = _sql("008_payment_recurring_data_plane.sql")

    for statement in (
        "REVOKE ALL ON FUNCTION public.finance_replace_settings(TEXT, DATE, TEXT) FROM PUBLIC, anon",
        "REVOKE ALL ON FUNCTION public.finance_update_emergency_fund_goal(TEXT) FROM PUBLIC, anon",
        "REVOKE ALL ON FUNCTION public.finance_store_insight(TEXT, DATE) FROM PUBLIC, anon",
    ):
        assert statement in settings_sql

    assert "REVOKE ALL ON FUNCTION public.finance_mark_bill_paid(UUID, TEXT) FROM PUBLIC, anon" in payment_sql
    assert "REVOKE ALL ON FUNCTION public.finance_generate_recurring_child(UUID) FROM PUBLIC, anon" in payment_sql


def test_final_migration_removes_authenticated_table_mutation_surface():
    sql = _sql("009_revoke_authenticated_table_dml.sql")

    for table in ("finance_bills", "finance_incomes", "finance_user_settings"):
        assert f"REVOKE INSERT, UPDATE, DELETE ON public.{table} FROM authenticated" in sql
        assert f"GRANT SELECT ON public.{table} TO authenticated" in sql

    for policy in (
        "finance_bills_owner_insert",
        "finance_bills_owner_update",
        "finance_bills_owner_delete",
        "finance_incomes_owner_insert",
        "finance_incomes_owner_update",
        "finance_incomes_owner_delete",
        "finance_settings_owner_insert",
        "finance_settings_owner_update",
        "finance_settings_owner_delete",
    ):
        assert f"DROP POLICY IF EXISTS {policy}" in sql


def test_runtime_routes_use_rpc_boundaries_for_sensitive_mutations():
    backend = Path(__file__).parent
    runtime = (backend / "runtime.py").read_text(encoding="utf-8")
    settings = (backend / "settings_write_routes.py").read_text(encoding="utf-8")
    goal = (backend / "settings_routes.py").read_text(encoding="utf-8")
    insights = (backend / "insights_routes.py").read_text(encoding="utf-8")
    payments = (backend / "secure_routes.py").read_text(encoding="utf-8")
    receipt_payments = (backend / "receipt_payments.py").read_text(encoding="utf-8")
    recurring = (backend / "recurring_service.py").read_text(encoding="utf-8")

    assert "from settings_write_routes import update_settings" in runtime
    assert '"finance_replace_settings"' in settings
    assert '"finance_update_emergency_fund_goal"' in goal
    assert '"finance_store_insight"' in insights
    assert '"finance_mark_bill_paid"' in payments
    assert '"finance_mark_bill_paid"' in receipt_payments
    assert '"finance_generate_recurring_child"' in recurring

    assert '.table("finance_user_settings").update(' not in settings
    assert '.table("finance_user_settings").update(' not in goal
    assert '.table("finance_user_settings").update(' not in insights
    assert '.table("finance_bills").update(' not in payments
    assert '.table("finance_bills").update(' not in receipt_payments
    assert '.table("finance_bills").insert(' not in recurring
