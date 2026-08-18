# Local notification lifecycle

FinanceFlow treats recurring templates and payable bill instances as different domain objects.

## Identity

- A recurring template (`is_recurring=true`) is scheduling metadata and must never own a payable reminder.
- A generated recurring child (`is_recurring=false`, `parent_bill_id=<template id>`) is the payable liability and is the only recurring row whose `id` may be stored in local notification data.
- Payment cancellation uses that same payable child ID.

## Permission and device readiness

Before any local reminder is scheduled, `scheduleNotificationsForBill()` reconciles OS notification permission and the Android `bills` channel through `requestNotificationPermissions()`.

Permission reconciliation is single-flight for concurrent callers, but granted/denied decisions are **not** cached across independent scheduling attempts. Each independent attempt re-reads current OS permission so a change made in device Settings can be observed without restarting the JavaScript process. A known `denied` state fails closed without invoking another permission request; only a requestable/undetermined state may trigger the OS prompt. When permission is currently granted on Android, the `bills` channel is reconciled again before scheduling.

Transient device/channel API failures are not treated as a financial failure. Reminder scheduling simply fails closed for that attempt. Web remains a no-op for local scheduling. Notification permission or channel failure never rolls back, recreates, or retries an already-committed recurring financial operation.

## Retry and reconciliation

`scheduleNotificationsForBill()` uses replace semantics for one bill ID: existing reminders for that bill are enumerated and cancelled before a new set is created. If the existing set cannot be reconciled, the function fails closed and does not add an unknown duplicate set. This makes repeated scheduling of a known child safe for retry/reconciliation.

Recurring creation schedules only children returned by `generation.generated`. A `partial_success` / deferred-generation response has no materialized payable target and therefore schedules no reminder from the template row.

## Authentication boundary

OS-scheduled reminders are device-local state and must not survive the authenticated session that created them. `AuthProvider` registers notification cleanup with the auth-session boundary, and a real transition to an unauthenticated persisted state requests cancellation of all FinanceFlow local reminders.

The cleanup runs under the same persistence lock used for auth-session writes. This matters for account switching: a stale logout or rejected bearer snapshot is not allowed to run global notification cleanup after a newer login becomes current. Local logout still completes if the remote logout endpoint or the device notification API fails.

Unauthenticated initialization also requests cleanup so reminders orphaned by a prior crash/session removal do not remain scheduled indefinitely. This cleanup does not delete another owner's durable pending financial-mutation state; notification lifecycle and owner-scoped financial persistence remain separate concerns.

## Current limitation

Local Expo notifications are device-owned. A recurring child generated later by a server-side/manual generation call on another device or while this device is not participating is **not automatically pushed to this device's local scheduler**. The current production contract guarantees correct identity/cancellation for children that this device receives during recurring creation; it does not claim background push delivery for future server-generated occurrences.

A future cross-device/background reminder feature should reconcile authoritative pending child rows on app foreground/sync or use an authenticated push-notification backend. It must preserve owner isolation, child-ID identity, duplicate-safe replacement, privacy-safe lock-screen copy, payment cancellation semantics, and auth-boundary cleanup.
