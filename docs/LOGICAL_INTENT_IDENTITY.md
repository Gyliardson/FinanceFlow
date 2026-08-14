# Mobile financial logical-intent identity

FinanceFlow separates three identities that must not be conflated:

1. **User intent identity** — an explicit client `intentId` created when the user starts one non-convergent financial action.
2. **Transport replay identity** — the `Idempotency-Key` persisted for that intent.
3. **Server payload identity** — the canonical payload fingerprint derived by PostgreSQL for same-key replay/conflict validation.

The four scoped mobile operations are:

- ordinary bill creation;
- income creation;
- reserve addition;
- recurring-template creation.

## Core invariant

One unresolved explicit user intent owns one persisted record:

```text
intentId
+ authenticated owner
+ operation type
+ Idempotency-Key
+ original first-submission payload
+ created/state metadata
```

Retry/reconnect/restart/background reconciliation for that same `intentId` must reuse the same `Idempotency-Key` and the same original payload.

A **new explicit user intent receives a new `intentId` and therefore a new `Idempotency-Key` even if its business payload is byte-for-byte identical to an older unresolved intent**.

Payload equality is never the definition of user-intent identity.

## Why this is necessary

The previous mobile design could correctly preserve an income across a local-midnight rollover by comparing a reduced logical payload, but that created another ambiguity: a genuinely new user action with equivalent values could alias the older pending operation.

The v3 contract removes that inference entirely. Pending lookup uses `intentId` equality only. `canonicalPayload` / `payloadFingerprint` remain useful evidence/integrity metadata but do not choose which user action a retry belongs to.

## Lifecycle

- A mounted financial form creates an explicit intent handle on first submission.
- Retrying while that form/intention remains active reuses the same handle.
- The pending record is persisted before network transport.
- Timeout, network loss, response loss, 5xx, 408/425/429, and auth/session loss retain the ambiguous intent.
- A definitive success closes the pending record.
- A definitive non-auth client rejection closes that rejected intent.
- Explicitly leaving/resetting a form clears only the UI handle; any ambiguous persisted record remains encrypted for reconciliation.
- A new later form submission creates a new explicit intent, even if all values equal a prior pending operation.
- Session restore, successful sign-in, and app foreground enumerate the authenticated owner's persisted pending records and replay each original payload using its persisted `intentId`.

## Account/session boundary

Financial request preparation captures one coherent snapshot:

```text
access token + owner id + session generation
```

The same snapshot controls Authorization and the pending owner namespace. If the session changes before transport, preparation fails closed. User B cannot select or replay User A's pending intent.

Normal logout does not destroy an ambiguous financial outcome. The pending record remains encrypted and owner-scoped so the same owner can reconcile it after re-authentication.

## Storage and migration

Pending financial payloads are private state.

- Current format: owner-scoped SecureStore v3.
- Previous SecureStore v2 records migrate one way to v3.
- Historical AsyncStorage v1 records also migrate one way and are removed.
- A legacy record without an explicit `intentId` receives a synthetic stable ID derived from its already-persisted operation key so the ambiguous operation is not abandoned.
- Store read/modify/write remains serialized per `owner + operation`, preventing last-writer-wins loss between different intents.
- Financial payloads are not written to diagnostic logs.

## Server boundary remains unchanged

The explicit mobile `intentId` does **not** replace PostgreSQL idempotency.

PostgreSQL remains authoritative for:

```text
auth.uid()
+ operation type
+ Idempotency-Key
+ database-derived canonical payload fingerprint
+ transactional key claim
+ financial mutation
+ durable replay result
```

The client intent identifier only ensures the correct durable key/original payload is selected for the correct user action.

## Required regression evidence

The Mobile auth contract must prove at least:

- same `intentId`, changed/recomputed retry payload -> same key + original payload;
- different `intentId`, identical business payload -> different key;
- income retry across local midnight -> same explicit intent/key/original date;
- two different concurrent pending intents -> both persist;
- restart -> persisted intent can be replayed;
- logout/account switch -> owner isolation;
- session change during preparation -> fail closed;
- SecureStore v2 -> v3 migration retains the ambiguous legacy key/payload;
- all four non-convergent screens use the explicit-intent transport boundary;
- restore/sign-in/foreground reconciliation replays persisted intents rather than inferring identity from screen values.
