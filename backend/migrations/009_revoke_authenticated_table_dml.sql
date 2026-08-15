-- Migration 009: close the authenticated direct-DML bypass.
--
-- All canonical production writes have sanctioned owner-derived RPCs by this
-- point. Keep owner-scoped SELECT policies for authenticated reads, but remove
-- direct INSERT/UPDATE/DELETE privileges and mutation policies. SECURITY DEFINER
-- RPCs in migrations 007/008 are the only intended authenticated write surface.

REVOKE INSERT, UPDATE, DELETE ON public.finance_bills FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.finance_incomes FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.finance_user_settings FROM authenticated;

DROP POLICY IF EXISTS finance_bills_owner_insert ON public.finance_bills;
DROP POLICY IF EXISTS finance_bills_owner_update ON public.finance_bills;
DROP POLICY IF EXISTS finance_bills_owner_delete ON public.finance_bills;

DROP POLICY IF EXISTS finance_incomes_owner_insert ON public.finance_incomes;
DROP POLICY IF EXISTS finance_incomes_owner_update ON public.finance_incomes;
DROP POLICY IF EXISTS finance_incomes_owner_delete ON public.finance_incomes;

DROP POLICY IF EXISTS finance_settings_owner_insert ON public.finance_user_settings;
DROP POLICY IF EXISTS finance_settings_owner_update ON public.finance_user_settings;
DROP POLICY IF EXISTS finance_settings_owner_delete ON public.finance_user_settings;

-- Preserve only owner-scoped reads at the table layer.
GRANT SELECT ON public.finance_bills TO authenticated;
GRANT SELECT ON public.finance_incomes TO authenticated;
GRANT SELECT ON public.finance_user_settings TO authenticated;
