# Authenticated financial data-plane boundary

Issue #91 tracks a domain-integrity gap in the original Supabase privilege model. Row Level Security isolated owners, but the `authenticated` role also had direct table `INSERT`, `UPDATE`, and `DELETE` privileges. Because the mobile client legitimately possesses the project URL, publishable key, and its own end-user JWT for Supabase Auth, those direct Data API mutations were reachable outside FastAPI and could bypass application financial invariants.

The numbered migrations 007–009 implement the least-privilege replacement. **RLS remains the final cross-owner read-isolation authority.** This change restricts self-owned writes; it does not move service-role credentials into the client.

## Effective privilege model

The end-user `authenticated` role retains owner-scoped `SELECT` on `finance_bills`, `finance_incomes`, and `finance_user_settings`. Direct table `INSERT`, `UPDATE`, and `DELETE` are revoked by migration 009 and the corresponding mutation policies are removed.

Supported writes cross narrowly defined `SECURITY DEFINER` functions that:

- derive the owner exclusively from `auth.uid()`;
- reject an absent authenticated owner;
- validate the domain fields exposed by that mutation;
- use a fixed safe `search_path`;
- expose execution only to `authenticated`;
- never accept caller-supplied `owner_id`;
- preserve transactionality, uniqueness, payment convergence, Decimal bounds and financial-date semantics.

PUBLIC and anonymous execution are explicitly revoked. The private idempotency ledger and private financial-timezone configuration are not directly accessible to `authenticated`.

## Canonical production write inventory

| Production write | Sanctioned boundary |
| --- | --- |
| Ordinary bill creation | `finance_idempotent_add_bill` |
| Income creation | `finance_idempotent_add_income` |
| Reserve addition | `finance_idempotent_add_reserve` |
| Recurring template creation | `finance_idempotent_create_recurring_template` |
| Full settings create/update | `finance_replace_settings` |
| Emergency-fund goal update | `finance_update_emergency_fund_goal` |
| Persist generated AI insight | `finance_store_insight` |
| Receipt-less payment | `finance_mark_bill_paid(..., NULL)` |
| Receipt-backed payment | `finance_mark_bill_paid(..., receipt_path)`; private object storage remains server-only |
| Generated recurring child | `finance_generate_recurring_child` |
| Delete financial rows | no canonical production delete route and no sanctioned delete RPC |

`runtime.py` binds full settings writes to `settings_write_routes.update_settings`; settings goal, insight, both payment modes and recurring generation likewise call the sanctioned RPC surface. Legacy non-canonical helpers that still contain direct table mutation code are not runtime routes and become fail-closed after migration 009 because `authenticated` no longer owns table DML.

Experimental collectors/scheduler are collection-only in the production posture and do not gain a write privilege from this boundary.

## Durable idempotency RPC hardening

Migration 006 originally declared the four durable mutation functions `SECURITY INVOKER`, which depended on direct authenticated table DML. Migration 007 converts them to narrow `SECURITY DEFINER` functions with fixed `search_path` while preserving their existing owner derivation, payload validation and transactional idempotency ledger behavior. Direct authenticated access to `financeflow_private.idempotency_operations`, its helper and the private schema is revoked.

The existing Financial idempotency PostgreSQL workflow remains required because migration 007 must not weaken same-key replay, payload conflict detection or atomic ledger/effect semantics.

## Settings and insight boundaries

`finance_replace_settings` accepts only initial balance, initial-balance date and emergency-fund goal. It preserves reserve balance and persisted insight fields on update. `finance_update_emergency_fund_goal` can modify only the goal. `finance_store_insight` can modify only non-authoritative insight text/date and cannot invoke any external provider; explicit AI generation remains a FastAPI action.

All money inputs are parsed as PostgreSQL `NUMERIC` and enforce the same ±1,000,000 / non-negative goal bounds as the API model.

## Payment boundary

`finance_mark_bill_paid` derives owner from `auth.uid()`, row-locks the owner-scoped bill, rejects recurring templates, converges already-paid state, and derives `payment_date` inside PostgreSQL. The date comes from `financeflow_private.runtime_config`, whose default is `America/Sao_Paulo` and which has no authenticated privileges. A client therefore cannot forge the payment date by bypassing FastAPI.

A receipt path, when supplied, must remain under `<owner_id>/<bill_id>/...`. Receipt bytes still use server-only private storage. The application retains ambiguous-outcome reconciliation: transport failure does not prove rollback, and private receipt cleanup occurs only after authoritative state shows whether an uploaded object is referenced.

## Recurring-child boundary

`finance_generate_recurring_child` accepts only a parent bill id. PostgreSQL verifies that the parent belongs to the authenticated owner and is a valid monthly recurring template, then derives amount, description and due date from that parent. The due date clamps short months and treats a due date equal to today as consumed, matching the product recurrence rule. The partial unique index on `(parent_bill_id, due_date)` remains the final retry/concurrency authority; duplicate calls converge to the existing child.

## PostgreSQL verification contract

`.github/workflows/authenticated-data-plane.yml` applies migrations 002–009 to a disposable PostgreSQL 16 Supabase-compatible fixture and proves both denial and positive paths:

- owner-scoped SELECT still works;
- direct authenticated INSERT, UPDATE and DELETE are denied;
- bill/income idempotent RPCs still succeed and replay exactly once;
- settings, goal, insight and reserve writes are owner-scoped and field-limited;
- payment date is database-owned;
- cross-owner payment and recurring-template payment are rejected;
- recurring-child retries produce one derived child;
- anonymous table access and sanctioned RPC execution are denied.

This dedicated gate supplements, rather than replaces, existing ownership/RLS, financial-idempotency, recurring-idempotency, backend, mobile, dependency, secret and build gates.

## Migration sequencing and deployment

The sequence is intentional:

1. migration 007 hardens existing idempotent RPCs and introduces settings/insight functions;
2. migration 008 introduces database-owned payment-date configuration plus payment/recurring-child functions;
3. canonical application call sites move to the sanctioned surface;
4. migration 009 revokes direct table DML and removes mutation policies.

For a release candidate, migrations must be applied in numbered order to the Supabase project. A generic empty PostgreSQL replay remains only focused CI evidence, not a substitute for Supabase provisioning. Promotion of #91 additionally requires all exact-head repository gates to be green and post-merge certification on `portfolio/revamp-2026`.
