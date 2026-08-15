# Authenticated financial data-plane boundary

Issue #91 tracks a domain-integrity gap in the current Supabase privilege model. Row Level Security correctly isolates owners, but the `authenticated` role also has direct table `INSERT`, `UPDATE`, and `DELETE` privileges. Because the mobile client legitimately possesses the project URL, publishable key, and its own end-user JWT for Supabase Auth, those direct Data API mutations are reachable outside FastAPI and can bypass application financial invariants.

This document is the migration inventory for closing that gap. It is intentionally narrower than the ownership model: **RLS remains the final cross-owner isolation authority.** The change is least privilege for self-owned writes, not a replacement for RLS and not a move of service-role credentials into the client.

## Target privilege model

The end-user `authenticated` role should retain owner-scoped `SELECT` on financial tables because canonical backend reads use the verified end-user JWT with PostgREST/RLS. It must not retain unrestricted table `INSERT`, `UPDATE`, or `DELETE` privileges.

Supported writes must instead cross narrowly defined database functions that:

- derive the owner exclusively from `auth.uid()`;
- reject an absent authenticated owner;
- validate the invariants that would otherwise have existed only in FastAPI;
- use a fixed safe `search_path`;
- expose execution only to `authenticated`;
- never accept a caller-supplied `owner_id`;
- preserve transactionality, uniqueness, payment convergence, Decimal scale, and financial-date semantics.

`SECURITY DEFINER` is acceptable only for those narrowly scoped functions because direct table DML will be revoked from `authenticated`. Every definer function must therefore contain its own owner/domain predicates and must have PUBLIC execution revoked explicitly.

## Production write inventory

| Current production write | Current implementation | Required sanctioned boundary before table DML revocation |
| --- | --- | --- |
| Ordinary bill creation | `finance_idempotent_add_bill` | keep durable idempotency; execute through a hardened owner-derived RPC |
| Income creation | `finance_idempotent_add_income` | keep durable idempotency; execute through a hardened owner-derived RPC |
| Reserve addition | `finance_idempotent_add_reserve` | keep durable idempotency; execute through a hardened owner-derived RPC |
| Recurring template creation | `finance_idempotent_create_recurring_template` | keep durable idempotency; execute through a hardened owner-derived RPC |
| Full settings create/update | `api_handlers.update_settings` direct table insert/update | owner-derived settings upsert RPC with money/date bounds |
| Emergency-fund goal update | `settings_routes.update_emergency_fund_goal` direct update | field-specific owner-derived RPC |
| Persist generated AI insight | `insights_routes.refresh_insights` direct settings update | field-specific owner-derived RPC; generation consent remains in FastAPI |
| Receipt-less payment | `secure_routes.pay_bill_without_receipt` direct compare-and-set update | owner-derived payment CAS RPC using server-supplied financial date |
| Receipt-backed payment | `receipt_payments.persist_private_receipt_payment` direct compare-and-set update | owner-derived receipt-payment CAS RPC; storage remains server-only |
| Generated recurring child | `recurring_service.generate_recurring_instances_for_client` direct insert | owner-derived child-insert RPC that verifies parent ownership/template shape and preserves `(parent_bill_id, due_date)` uniqueness |
| Delete financial rows | no canonical production delete route | no sanctioned RPC; direct table DELETE should be denied |

Experimental collectors/scheduler are collection-only in the production posture and must not gain a write privilege as part of this migration.

## Existing idempotency RPCs

Migration 006 currently declares the four durable mutation functions `SECURITY INVOKER`. That is appropriate only while the calling role also owns table DML privileges. After direct DML is revoked, these functions need a deliberately hardened execution model so their internal writes still work while callers cannot reproduce those writes directly.

The migration must not merely flip the security mode. Before promotion, tests must prove for every function that:

1. unauthenticated execution is denied;
2. owner identity comes from `auth.uid()` and cannot be supplied by the caller;
3. same owner/key/payload replay remains exactly-once;
4. cross-owner rows remain inaccessible;
5. PUBLIC execution is revoked and only the intended role can execute;
6. the function's fixed `search_path` cannot be caller-controlled.

## PostgreSQL verification contract

The ownership gate currently treats direct self-owned authenticated insert as expected behavior. Closing #91 requires replacing that expectation with least-privilege assertions:

- authenticated owner can SELECT own rows but cannot SELECT another owner's rows;
- authenticated direct INSERT into each financial table is denied;
- authenticated direct UPDATE of self-owned amount/status/payment/settings fields is denied;
- authenticated direct DELETE is denied;
- forged owner remains denied;
- anonymous access remains denied;
- sanctioned RPCs continue to mutate only the current owner's rows;
- payment RPC cannot pay a recurring template or overwrite an already-paid winner;
- generated-child RPC cannot use another owner's parent and remains unique under retry/concurrency;
- settings/insight RPCs can only modify their declared fields.

## Migration sequencing

Privilege revocation is the **last** database step after all production write paths have been converted and tested. Applying `REVOKE INSERT, UPDATE, DELETE ... FROM authenticated` before the sanctioned boundaries exist would make the backend fail closed but non-functional.

A clean-room/release run must apply the numbered migration on a disposable database and prove both negative direct-DML cases and positive sanctioned mutations before the change is promoted to `portfolio/revamp-2026`.
