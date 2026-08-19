# FinanceFlow financial rules

This document records the financial invariants implemented by the current FinanceFlow backend and database. It describes the effective post-migration behavior on `main`; historical hardening branches are not a future promotion target.

## Money representation

Authoritative monetary values use decimal semantics end to end.

- API/domain parsing uses `Decimal` rather than binary floating point for financial arithmetic.
- PostgreSQL stores financial values as exact `NUMERIC` values.
- Supported money is normalized to two decimal places using the repository's explicit rounding rules.
- Invalid, non-finite, out-of-range, or unexpectedly precise values are rejected rather than silently converted.
- Financial totals are computed from authoritative persisted data instead of trusting client-provided subtotals.

The current API boundary caps supported absolute monetary magnitude at the repository-defined ±1,000,000 range where negative values are meaningful; non-negative-only fields such as reserve goals/additions enforce the narrower domain appropriate to the operation.

## Financial DATE-only semantics

FinanceFlow distinguishes business-calendar dates from timestamps. The canonical financial timezone is the IANA zone:

`America/Sao_Paulo`

Financial `YYYY-MM-DD` values must be derived with timezone-aware calendar logic. UTC timestamp slicing is not a valid replacement because UTC midnight can fall on a different financial business date.

This boundary applies to user-facing financial dates such as:

- income dates;
- bill due dates;
- payment dates;
- initial-balance dates;
- recurring-generation comparisons.

The payment transition derives its authoritative payment date inside PostgreSQL from private runtime configuration; a client does not get to forge that date through the payment RPC.

## Ownership and authenticated write boundary

Financial rows are owner-scoped. Supabase Auth establishes end-user identity, FastAPI verifies the Bearer access token, and normal Data API access stays bound to that user's context so PostgreSQL RLS remains the final cross-owner isolation boundary.

The effective write model is intentionally narrower than “RLS plus arbitrary self-owned DML”:

- the `authenticated` role retains owner-scoped reads;
- direct authenticated `INSERT`, `UPDATE`, and `DELETE` on the canonical financial tables are revoked;
- sanctioned owner-derived RPCs perform supported writes;
- those RPCs derive owner identity from `auth.uid()` rather than a caller-supplied `owner_id`;
- PUBLIC/anonymous execution is revoked where the migrations define the authenticated financial surface.

See [SECURITY_MODEL.md](SECURITY_MODEL.md) and [Authenticated data plane](../docs/security/AUTHENTICATED_DATA_PLANE.md).

## Durable financial idempotency

Four non-convergent financial operations use a durable PostgreSQL `Idempotency-Key` protocol:

1. ordinary bill creation — `finance_idempotent_add_bill`;
2. income creation — `finance_idempotent_add_income`;
3. reserve addition — `finance_idempotent_add_reserve`;
4. recurring-template creation — `finance_idempotent_create_recurring_template`.

The identity is scoped by authenticated owner + operation + idempotency key. PostgreSQL derives the canonical payload fingerprint and stores the claim/effect/replay result in one transactional boundary. Replaying the same key with the same payload converges to the durable result; reusing the same key for a different payload is a conflict rather than a second financial effect.

### Effective SECURITY DEFINER state

Migration `006_financial_idempotency.sql` originally introduced the four durable mutation functions as `SECURITY INVOKER`. That is **not** their effective current state.

Migration `007_authenticated_data_plane.sql` replaces those functions with narrowly scoped `SECURITY DEFINER` implementations so the application can revoke direct authenticated table DML without losing the supported idempotent write surface. The effective functions:

- derive the owner from `auth.uid()`;
- reject a missing authenticated owner;
- do not accept caller-provided `owner_id`;
- use a fixed safe `search_path`;
- validate the operation-specific payload;
- execute the ledger claim and financial effect transactionally;
- restrict execution to the intended authenticated role and remove direct access to the private idempotency internals.

`SECURITY DEFINER` is **not** a generic security guarantee. The security boundary depends on the reviewed function surface, owner derivation, fixed `search_path`, restricted grants, bounded parameters, RLS/read behavior, and the database tests that exercise replay, conflict, concurrency, and cross-owner isolation.

## Mobile logical-intent identity

Database idempotency protects server effects, but the client must still replay the correct server identity after an ambiguous outcome.

For an explicit non-convergent financial intent, mobile persistence records:

- an explicit local intent identity;
- the `Idempotency-Key`;
- the complete original first-submission payload;
- owner/operation metadata required to find the pending record safely.

If the response is lost, timeout occurs, or the session becomes temporarily unavailable after submission, retry/reconnect/restart reuses the **same key and same original payload**. Recomputed form values are not substituted into an unresolved intent.

A new explicit user action gets a new intent/key even when its business payload happens to equal an older unresolved action. Payload equality is not user-intent identity.

Pending financial state is not a general offline write queue. New financial mutations remain online-only; pending persistence exists to reconcile an already-submitted operation whose outcome is ambiguous.

See [Logical intent identity](../docs/architecture/LOGICAL_INTENT_IDENTITY.md) and [Offline resilience](../docs/architecture/OFFLINE_RESILIENCE.md).

## Bills

An ordinary bill is a payable financial obligation. A recurring template is scheduling metadata and is not itself a payable instance.

Important rules include:

- bill ownership is derived from the authenticated context;
- monetary amount uses the canonical exact-money boundary;
- due date is a financial DATE-only value;
- an ordinary bill creation intent uses durable idempotency;
- a recurring template uses its own idempotent creation operation;
- recurring templates cannot be marked paid as if they were generated child bills.

## Monthly recurring obligations

Recurring templates generate concrete child bills for due periods. The recurrence boundary is deterministic and database-backed.

- Monthly recurrence preserves the intended day where the target month has it.
- Short months clamp to the final valid day.
- Leap-year February is handled by calendar semantics rather than fixed-day arithmetic.
- A due date equal to the financial “today” is treated as consumed when computing the next generated period.
- Generated children carry their parent relationship.
- The database partial uniqueness constraint on `(parent_bill_id, due_date)` is the final retry/concurrency authority for generated children.

Generated-child convergence is distinct from recurring-template creation idempotency; one invariant must not be used as a substitute for the other.

## Income

Income creation uses exact decimal money, financial DATE-only semantics, authenticated ownership, and durable `Idempotency-Key` replay. If a response is lost across local midnight, replay uses the original persisted income date and payload rather than recomputing a new business date.

## Reserve / emergency fund

FinanceFlow currently supports **reserve addition** and emergency-fund goal tracking.

- Reserve addition is a non-negative financial mutation protected by durable idempotency.
- The current product does **not** expose a reserve withdrawal/decrement endpoint.
- Goal updates are field-scoped and do not imply permission to overwrite reserve balance.
- Settings replacement preserves fields that are outside the sanctioned input surface.

Documentation must not imply bidirectional reserve operations until a real supported withdrawal boundary exists.

## Settings and initial balance

The settings write surface is owner-derived and field-limited. Initial balance, initial-balance date, and emergency-fund goal are governed by the sanctioned database function rather than arbitrary authenticated table updates.

The initial-balance date is financially meaningful: authoritative balance calculations include income/payment records according to that date boundary. The database migration chain constrains the sanctioned settings path so an authenticated direct Data API caller cannot use that RPC to place the initial-balance baseline after the canonical financial today.

## Payments

The sanctioned payment transition is `finance_mark_bill_paid`.

The database derives owner identity and authoritative payment date, row-locks the relevant owner-scoped bill, rejects recurring templates, and converges already-completed state. Receipt-less and receipt-backed payments use the same financial transition; only receipt-backed payment supplies a private object path.

### Receipt-backed payment ambiguity

Private receipt bytes are validated and uploaded under an owner/bill-scoped opaque object path before the payment transition references that object.

A transport/Data API exception after the payment request starts is an **ambiguous outcome**, not proof that the database rolled back. The backend therefore follows reconciliation-first semantics:

1. re-read the authoritative owner-scoped bill state through the authenticated/RLS data client;
2. if the committed paid state references the just-uploaded receipt, preserve the object and converge to that durable payment;
3. if another completed payment owns a different receipt, remove only the losing upload after the authoritative state proves it unreferenced;
4. if the bill remains unpaid and the authoritative reread proves the attempted object is not referenced, remove that orphan and return the persistence failure;
5. if reconciliation itself is unavailable or the state is incomplete/ambiguous, retain the private receipt fail-safe for later reconciliation.

This rule intentionally prefers a bounded possible orphan over deleting evidence that a committed payment may still reference.

## Private receipt access

Receipt storage is private. Persisted financial state stores the validated object identity, not a permanent public URL. Authorized access creates a bounded signed URL only after owner-scoped bill lookup and receipt-path validation.

Storage service-role capability is server-only and is not used as a substitute for the normal authenticated financial Data API client.

## OCR and AI

OCR and generated financial insights are provider-assisted outputs, never independent financial authority.

- Uploads are bounded and signature-validated before OCR.
- Declared MIME type or filename extension alone is not trusted.
- Provider output is parsed/validated locally.
- Low-confidence or unreadable OCR requires review rather than automatic financial persistence.
- Passive insight reads do not invoke the external provider; generation/refresh is explicit.

See [OCR_SECURITY.md](OCR_SECURITY.md) and [AI privacy](../docs/security/AI_PRIVACY.md).

## Evidence expectations

Financial correctness claims are tied to deterministic tests and database probes, including:

- decimal rounding/range boundaries;
- financial timezone/date behavior;
- RLS and forged-owner denial;
- direct authenticated table-DML denial;
- same-key sequential and concurrent replay;
- changed-payload conflict;
- cross-owner idempotency isolation;
- commit-then-response-loss retry;
- recurring-child uniqueness/concurrency;
- payment/date ownership inside PostgreSQL;
- receipt payment ambiguity and reconciliation.

The canonical evidence map is [Quality evidence](../docs/assurance/QUALITY_EVIDENCE.md). Green CI proves the scoped contract exercised on the exact candidate SHA; it is not a blanket claim about live third-party infrastructure or operator-managed credentials.
