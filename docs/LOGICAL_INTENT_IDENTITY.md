# Mobile financial logical-intent identity

FinanceFlow separates three identities that must not be conflated:

1. **User intent identity** — an explicit client `intentId` created when the user starts one non-convergent financial action.
2. **Transport replay identity** — the `Idempotency-Key` persisted for that intent.
3. **Server payload identity** — the canonical payload fingerprint derived by PostgreSQL for same-key replay/conflict validation.

The four scoped operations are ordinary bill creation, income creation, reserve addition, and recurring-template creation.

## Core invariant

One unresolved explicit user intent owns one owner-scoped persisted record containing its `intentId`, `Idempotency-Key`, complete original first-submission payload, and pending metadata.

Retry/reconnect/restart/background reconciliation for that same `intentId` reuses the same key and original payload. A **new explicit user intent gets a new `intentId` and a new key even if its business payload is identical to an older unresolved intent**. Payload equality is never the definition of user-intent identity.

`canonicalPayload` / `payloadFingerprint` remain integrity/evidence metadata; pending selection uses explicit `intentId` equality only.

## UI lifecycle

- A financial form allocates its explicit intent handle on first submission.
- Retry while that form/intention remains active reuses the handle.
- After an ambiguous result, fields are locked so retry cannot silently substitute recomputed/edited values for the persisted original payload.
- Cancelling/leaving/resetting the form clears the local UI handle. Any ambiguous persisted record remains encrypted for reconciliation; a later form is a new explicit user intent.
- Definitive success or definitive non-auth client rejection closes the persisted intent.
- Timeout, response loss, network loss, 5xx, 408/425/429, and auth/session loss retain the ambiguous intent.

## Restart / foreground reconciliation

Session restore, successful sign-in, and app foreground enumerate pending records for the authenticated owner. Replay uses each persisted `intentId` and `originalPayload`.

The reconciliation loop is pinned to the same coherent session snapshot that enumerated those records. It never enumerates User A and then recaptures a User B snapshot for transport. If the snapshot stops being current, reconciliation fails closed before sending.

## Account/session boundary

Financial preparation uses one snapshot:

`access token + owner id + session generation`

The same snapshot defines Authorization and pending owner namespace. Validation occurs before and after pending preparation. User B cannot select/replay User A's pending intent.

Normal logout does not erase an ambiguous financial outcome. The record remains encrypted/owner-scoped so the original owner can reconcile it later.

## Storage and migration

Pending financial payloads are private state:

- current storage: owner-scoped SecureStore v3;
- SecureStore v2 records migrate one way to v3;
- historical AsyncStorage v1 records migrate one way and are removed;
- legacy records without `intentId` receive a stable synthetic ID derived from their already-persisted operation key so ambiguous outcomes are not abandoned;
- read/modify/write stays serialized per `owner + operation` so concurrent distinct intents cannot overwrite each other;
- private financial payloads are not logged during reconciliation.

## Server boundary remains unchanged

The client `intentId` does not replace database idempotency. PostgreSQL remains authoritative for:

`auth.uid() + operation + Idempotency-Key + database-derived payload fingerprint + transactional claim + financial effect + durable replay result`.

The explicit mobile ID exists only so the correct server replay identity/original payload is selected for the correct user action.

## Regression evidence

The Mobile auth contract must prove:

- same explicit `intentId` + recomputed retry payload -> same key + original payload;
- distinct explicit `intentId`s + identical payload -> distinct keys;
- income retry across local midnight -> same intent/key/original date;
- deterministic old payload-equality aliasing control;
- deterministic old pending-store last-writer-wins control and fixed preservation of both intents;
- restart persistence;
- logout/account switch isolation;
- session change before preparation -> fail closed before pending creation;
- SecureStore v2 -> v3 migration retaining ambiguous key/payload;
- all four financial screens use the explicit-intent transport boundary;
- restore/sign-in/foreground reconciliation is pinned to the enumerating session snapshot;
- the #37 `America/Sao_Paulo` financial date contract remains green in the same gate.
