# Local notification lifecycle

FinanceFlow treats recurring templates and payable bill instances as different domain objects.

## Identity

- A recurring template (`is_recurring=true`) is scheduling metadata and must never own a payable reminder.
- A generated recurring child (`is_recurring=false`, `parent_bill_id=<template id>`) is the payable liability and is the only recurring row whose `id` may be stored in local notification data.
- Payment cancellation uses that same payable child ID.

## Retry and reconciliation

`scheduleNotificationsForBill()` uses replace semantics for one bill ID: existing reminders for that bill are enumerated and cancelled before a new set is created. If the existing set cannot be reconciled, the function fails closed and does not add an unknown duplicate set. This makes repeated scheduling of a known child safe for retry/reconciliation.

Recurring creation schedules only children returned by `generation.generated`. A `partial_success` / deferred-generation response has no materialized payable target and therefore schedules no reminder from the template row.

## Current limitation

Local Expo notifications are device-owned. A recurring child generated later by a server-side/manual generation call on another device or while this device is not participating is **not automatically pushed to this device's local scheduler**. The current production contract guarantees correct identity/cancellation for children that this device receives during recurring creation; it does not claim background push delivery for future server-generated occurrences.

A future cross-device/background reminder feature should reconcile authoritative pending child rows on app foreground/sync or use an authenticated push-notification backend. It must preserve owner isolation, child-ID identity, duplicate-safe replacement, privacy-safe lock-screen copy, and payment cancellation semantics.
