# FinanceFlow Financial Domain Rules

This document defines the backend invariants for monetary values, financial mutation identity, payments and recurring bills. Tests and database/application concurrency guards must prove these rules before the portfolio revamp can claim financial correctness.

## Money representation

- PostgreSQL `NUMERIC`/`DECIMAL` remains the persistence authority for monetary columns.
- Authoritative Python arithmetic uses `decimal.Decimal`, never binary `float`.
- The canonical currency scale is **2 decimal places**.
- Values are normalized with **`ROUND_HALF_UP`** at the explicit currency boundary.
- API monetary inputs are normalized before product bounds are evaluated. For a positive-money field, a sub-cent input such as `0.004` becomes `0.00` and is rejected rather than being persisted as a zero-valued transaction.
- Persistence payloads use canonical fixed-scale decimal strings such as `"10.00"` so JSON serialization cannot introduce binary floating-point drift before PostgreSQL receives the value.
- Non-finite values (`NaN`, `Infinity`, `-Infinity`) are invalid.
- Existing API product bounds remain in force unless a separate domain decision changes them.

### Rounding examples

| Input | Canonical value |
| --- | --- |
| `0.1 + 0.2` supplied as separate values | `0.30` |
| `10` | `10.00` |
| `1.004` | `1.00` |
| `1.005` | `1.01` |
| `-1.005` | `-1.01` |

Rounding happens at defined boundaries, not repeatedly during intermediate arithmetic.

## Financial calendar and timezone

Date-only financial events must not depend on the timezone configured on the CI runner or deployment host.

- The authoritative backend calendar uses the IANA timezone in `FINANCIAL_TIMEZONE`.
- The portfolio default is `America/Sao_Paulo`, matching the current Brazilian/BRL product baseline.
- Payment dates, recurring target dates, month-end balance horizons, and monthly insight cache dates use the same `financial_today()` boundary.
- Explicit datetime values used by tests must be timezone-aware; naive datetimes are rejected rather than interpreted using the machine locale.
- Mobile values that are semantically `YYYY-MM-DD` are treated as date-only values. They must not be created with UTC `toISOString()` or rendered by parsing `YYYY-MM-DD` through JavaScript `Date`, because either operation can shift the calendar day around timezone boundaries.
- Changing the product/business timezone is an explicit configuration change and must be accompanied by boundary tests around local midnight and month rollover.

## Authoritative balance calculation

For a configured start date:

`current_balance = initial_balance + incomes - paid_bills - emergency_fund_balance`

`estimated_surplus = current_balance - pending_or_overdue_bills_due_through_month_end`

Every operand and intermediate total remains `Decimal` until presentation/serialization. Tests include zero, negative balances, cent values, mixed input representations, large allowed values, and rounding boundaries.

## Durable online mutation idempotency

The following **non-convergent financial POST mutations** use the durable `Idempotency-Key` protocol:

1. reserve addition (`POST /insights/reserve`);
2. ordinary bill creation (`POST /add-bill`);
3. income creation (`POST /incomes`);
4. recurring-template creation (`POST /recurring-bills`).

The logical identity is:

`authenticated owner + operation type + Idempotency-Key`

The backend computes a canonical SHA-256 fingerprint of the validated logical payload. The client never supplies an owner id or trusted fingerprint.

### Transaction boundary

Migration `006_financial_idempotency.sql` provides PostgreSQL RPCs that coordinate three things in the **same transaction**:

1. claim the owner/operation/key row;
2. apply the financial effect;
3. persist the durable result used by later replay.

This deliberately avoids the unsafe pattern `check key -> mutate -> insert replay record` as separate operations.

A transaction that rolls back leaves neither a completed effect nor a durable replay result. If the database transaction commits but the client loses the response, both the financial effect and replay result are already durable; the caller retries the same unresolved intent with the same key and PostgreSQL returns the committed result without another effect.

### Replay contract

- same owner + operation + key + equivalent canonical payload → return the durable result; apply the financial effect once;
- same owner + operation + key + different payload → reject explicitly/fail closed;
- the same opaque key used by another authenticated owner is independent and cannot reveal or deduplicate the first owner's operation;
- a **new key** deliberately represents a new business intent, even when all business values equal a prior completed operation.

The ledger is owner-scoped by RLS and the mutation functions are `SECURITY INVOKER`; `auth.uid()` remains the ownership authority.

### Mobile operation lifecycle

For these four operations the mobile client creates/persists the operation identity **before transport**. Pending records are owner-scoped in AsyncStorage.

- new unresolved user intent → one new operation key;
- concurrent transport attempts for that same unresolved intent → same key;
- timeout, connection reset, app reconnect, HTTP 5xx, `408`, `425`, or `429` → outcome may be ambiguous, so retain the key;
- app/module restart → the unresolved owner-scoped key is loaded again;
- confirmed success → clear the pending identity;
- definitive non-retryable 4xx rejection → close that rejected identity;
- after confirmed completion, intentionally repeating the same business values is a new intent and receives a new key.

The mobile pending-operation retention window is currently 90 days. Server replay records are not automatically deleted by migration 006; they remain durable until an explicit operator-managed lifecycle policy is introduced. The server therefore does not expire a key while a supported mobile pending record can still legitimately retry it.

## Payment convergence and ambiguous receipt commits

Payment endpoints have a **different contract** from the four `Idempotency-Key` mutations above. Do not describe all payment behavior generically as key-based idempotency.

### Receipt-less payment

The target state is `paid`. The final update is compare-and-set constrained by `status != paid`. If another request completes the same bill between lookup and update, the losing request converges to the already-achieved paid state rather than claiming a second financial write.

### Receipt-backed payment

Receipt-backed payment also uses a `status != paid` compare-and-set, but storage makes the failure model different. An exception returned by the Data API is **not proof of database rollback**.

The fail-safe sequence is:

1. validate and upload the private, owner/bill-scoped receipt;
2. attempt the RLS-scoped payment mutation;
3. if the mutation result is lost or otherwise ambiguous, re-read the authoritative RLS-scoped bill;
4. if the bill committed `paid` with this exact `receipt_path`, retain the object and resolve to the committed payment;
5. if reconciliation itself is unavailable or the row still references this object in an unexpected partial state, retain the object rather than destroying possibly committed evidence;
6. delete the uploaded object only after authoritative state proves that this attempt's object is not referenced.

A later retry after `COMMIT -> response failure` converges to the already-committed receipt/payment without a second upload. Tests explicitly distinguish this from `FAIL BEFORE COMMIT`.

RLS-scoped lookup/update remains the ownership authority, so a cross-user bill id is indistinguishable from a nonexistent bill.

## Recurring-bill calendar rule

Recurring templates currently implement **monthly cadence only**. Unsupported frequency labels are rejected at the API boundary instead of being stored and then processed with misleading monthly behavior.

Monthly recurring bills use a configured day from 1 through 31.

- If that day exists in the target month, use it.
- If the month is shorter, clamp to the month's last day.
- If today's financial date is before the current month's target due date, generate for the current month.
- If today is equal to or after the target due date, generate for the next month.
- December-to-January and leap/non-leap February are mandatory regression cases.

Recurring **template creation** uses the durable `Idempotency-Key` contract above. Child generation occurs after the template RPC and is recoverable independently. If child generation fails after template creation, the API reports explicit partial success and generation can be retried without inserting another template with the same unresolved operation identity.

## Generated-child idempotency

Generated recurring children use a separate database invariant and must not be confused with template-creation idempotency.

Generated children are unique by `(parent_bill_id, due_date)` when `parent_bill_id IS NOT NULL` and the row is not itself a recurring template. Migration `002_recurring_instance_uniqueness.sql` enforces this with a partial unique index.

Application pre-checks are an optimization only; PostgreSQL is the final authority.

### Historical duplicates

Migration 002 is deliberately **fail-closed**. If historical duplicate generated rows already exist, the migration raises an error and does not delete financial records automatically. Reconciliation must be explicit and auditable before retrying the migration.

### Concurrent requests and retries

Two concurrent attempts to create the same generated instance may race past an application pre-check. The database unique index allows at most one writer to commit.

A repeated retry of an already-generated `(parent_bill_id, due_date)` must not create another row.

For a multi-row insert, a uniqueness conflict aborts the PostgreSQL statement. Non-conflicting rows from the same failed statement must not be assumed persisted; a later retry recalculates missing instances and safely creates only those still absent.

## Validation evidence

The FinanceFlow gates prove these invariants with:

- exact-money unit tests and canonical API payload tests;
- financial-calendar boundary tests;
- receipt payment tests that distinguish fail-before-commit from commit-then-response-failure and verify signed access to retained evidence;
- a disposable PostgreSQL 16 financial-idempotency contract covering replay, payload mismatch, owner isolation, intentional new-key repetition and concurrent same-key requests for reserve/bill/income/recurring-template mutations;
- backend adapter tests that model commit-before-timeout for all four durable mutation classes;
- a mobile contract proving owner-scoped unresolved key reuse across concurrency, reconnect-style retry and module/app restart;
- PostgreSQL `NUMERIC(...,2)` persistence round-trip checks;
- recurring calendar edge cases, historical-duplicate fail-closed behavior, concurrent generated-child writers, retry uniqueness and bulk-conflict recovery.

Changes that weaken these invariants require an explicit domain decision and corresponding test updates; they must not be made solely to obtain a green CI result.
