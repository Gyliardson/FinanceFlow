# FinanceFlow Financial Domain Rules

This document defines the backend invariants for monetary values and generated recurring bills. It is intentionally implementation-oriented: tests and database constraints must prove these rules before the portfolio revamp can claim financial correctness.

## Money representation

- PostgreSQL `NUMERIC`/`DECIMAL` remains the persistence authority for monetary columns.
- Authoritative Python arithmetic uses `decimal.Decimal`, never binary `float`.
- The canonical currency scale is **2 decimal places**.
- Values are normalized with **`ROUND_HALF_UP`** at the explicit currency boundary.
- Persistence payloads should use canonical fixed-scale decimal strings such as `"10.00"` so JSON serialization cannot introduce binary floating-point drift before PostgreSQL receives the value.
- Non-finite values (`NaN`, `Infinity`, `-Infinity`) are invalid.
- Existing API product bounds remain in force unless a separate domain decision changes them: positive bill/income/reserve additions and bounded settings values.

### Rounding examples

| Input | Canonical value |
| --- | --- |
| `0.1 + 0.2` supplied as separate values | `0.30` |
| `10` | `10.00` |
| `1.004` | `1.00` |
| `1.005` | `1.01` |
| `-1.005` | `-1.01` |

Rounding should happen at defined boundaries, not repeatedly during intermediate arithmetic.

## Authoritative balance calculation

For a configured start date:

`current_balance = initial_balance + incomes - paid_bills - emergency_fund_balance`

`estimated_surplus = current_balance - pending_or_overdue_bills_due_through_month_end`

Every operand and intermediate total must remain `Decimal` until presentation/serialization. Tests must include zero, negative balances, cent values, mixed input representations, large allowed values, and rounding boundaries.

## Recurring-bill calendar rule

Monthly recurring bills use a configured day from 1 through 31.

- If that day exists in the target month, use it.
- If the month is shorter, clamp to the month's last day.
- If today's date is before the current month's target due date, generate for the current month.
- If today is equal to or after the target due date, generate for the next month.
- December-to-January and leap/non-leap February are mandatory regression cases.

## Generated-instance idempotency

Application pre-checks are an optimization only. PostgreSQL is the final authority.

Generated children are unique by `(parent_bill_id, due_date)` when `parent_bill_id IS NOT NULL` and the row is not itself a recurring template. Migration `002_recurring_instance_uniqueness.sql` enforces this with a partial unique index.

### Historical duplicates

Migration 002 is deliberately **fail-closed**. If historical duplicate generated rows already exist, the migration raises an error and does not delete financial records automatically. Reconciliation must be explicit and auditable before retrying the migration.

### Concurrent requests and retries

Two concurrent attempts to create the same generated instance may race past an application pre-check. The database unique index must allow at most one writer to commit.

A repeated retry of an already-generated `(parent_bill_id, due_date)` must not create another row.

For a multi-row insert, a uniqueness conflict aborts the PostgreSQL statement. Non-conflicting rows from the same failed statement must not be assumed persisted; a later retry should recalculate missing instances and safely create only those still absent.

## Validation evidence

The FinanceFlow CI should prove these invariants with:

- exact-money unit tests;
- calendar edge-case tests;
- disposable PostgreSQL migration tests;
- historical-duplicate fail-closed behavior;
- concurrent writers for the same generated instance;
- retry idempotency;
- bulk conflict rollback and recovery.

Changes that weaken these invariants require an explicit domain decision and corresponding test updates; they must not be made solely to obtain a green CI result.
