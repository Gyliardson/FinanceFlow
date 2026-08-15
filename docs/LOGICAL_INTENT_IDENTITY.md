# Mobile financial logical-intent identity

FinanceFlow separates three identities that must not be conflated:

1. **User intent identity** — an explicit client `intentId` created when the user starts one non-convergent financial action.
2. **Transport replay identity** — the `Idempotency-Key` persisted for that intent.
3. **Server payload identity** — the canonical payload fingerprint derived by PostgreSQL for same-key replay/conflict validation.

The four scoped operations are ordinary bill creation, income creation, reserve addition, and recurring-template creation.

## Core invariant

One unresolved explicit user intent owns one owner-scoped persisted record containing its `intentId`, `Idempotency-Key`, complete original first-submission payload, and pending metadata.

Retry/reconnect/restart/background reconciliation for that same `intentId` reuses the same key and original payload. A **new explicit user intent gets a new `intentId` and a new key even if its business payload is identical to an older unresolved intent**. Payload equality is never the definition of user-intent identity.

Fresh intent allocation is single-flight per mounted `useFinancialMutation` hook. The hook claims a synchronous re-entrancy guard before any awaited auth/pending-state preflight. React `saving`/loading state remains presentation feedback, not the financial correctness mutex. A second activation while the first submit is still being prepared or transported cannot allocate or persist a second logical intent.

## UI lifecycle

- A financial form allocates its explicit intent handle on first submission.
- Allocation/preparation/transport is single-flight per mounted mutation hook; rapid concurrent activation cannot manufacture two identities before React rerenders.
- Retry while that form/intention remains active reuses the handle and original persisted payload.
- After an ambiguous result, fields are locked so retry cannot silently substitute recomputed/edited values for the persisted original payload.
- Cancelling/leaving/resetting the form clears only the local UI handle. It **does not cancel** an ambiguous server outcome and does not delete the encrypted persisted record.
- The authenticated navigator exposes a privacy-safe unresolved-operation status that survives the originating form being closed. It shows only operation categories/counts; it never renders amounts, titles, original payloads, idempotency keys or intent IDs.
- If a fresh form attempts the same operation type while an older ambiguous record still exists for the authenticated owner, the app requires explicit acknowledgement **before allocating the new identity** that this is an additional financial action and both actions may later appear after reconciliation.
- Definitive success or definitive non-auth client rejection closes the persisted intent and refreshes the unresolved status.
- Timeout, response loss, network loss, 5xx, 408/425/429, and auth/session loss retain the ambiguous intent.
- The single-flight guard releases after every terminal preflight/transport outcome. An intentional later retry is therefore allowed, and an ambiguous retry still reuses the retained identity instead of creating another one.

This model deliberately avoids a misleading local “cancel pending write” action. Once transport outcome is unknown, deleting the durable record could abandon a mutation that already committed on the server. The safe choices are same-intent replay/reconciliation or an explicitly acknowledged additional intent.

## Restart / foreground reconciliation

Session restore, successful sign-in, and app foreground enumerate pending records for the authenticated owner. Replay uses each persisted `intentId` and `originalPayload`.

Reconciliation triggers are serialized. If a trigger arrives while another pass is active, it receives a subsequent pass rather than being dropped. Each pass resolves and validates the current coherent session snapshot before enumerating records. The loop never enumerates User A and then recaptures User B credentials for transport; if its captured snapshot stops being current, it fails closed before the next send.

## Account/session boundary

Financial preparation uses one snapshot:

`access token + owner id + session generation`

The same snapshot defines Authorization and pending owner namespace. Validation occurs before and after pending preparation. User B cannot select/replay User A's pending intent.

Normal logout does not erase an ambiguous financial outcome. The record remains encrypted/owner-scoped so the original owner can reconcile it later. Global unresolved-status reads are owner-scoped and discard late results if the authenticated owner changes.

## Storage and migration

Pending financial payloads are private state:

- current storage: owner-scoped chunked SecureStore namespace;
- historical SecureStore/AsyncStorage records migrate one way where supported and legacy plaintext state is removed after migration;
- legacy records without `intentId` receive a stable synthetic ID derived from their already-persisted operation key so ambiguous outcomes are not abandoned;
- read/modify/write stays serialized per `owner + operation` so concurrent distinct intents cannot overwrite each other;
- structurally valid ambiguous records have **no client-side wall-clock TTL**: age cannot prove whether a lost response hid a committed financial effect, so closure requires authoritative success or a definitive client rejection;
- private financial payloads are not logged during reconciliation;
- user-visible unresolved status exposes category/count only, never the durable payload or replay identifiers.

## Server boundary remains unchanged

The client `intentId` does not replace database idempotency. PostgreSQL remains authoritative for:

`auth.uid() + operation + Idempotency-Key + database-derived payload fingerprint + transactional claim + financial effect + durable replay result`.

The explicit mobile ID exists only so the correct server replay identity/original payload is selected for the correct user action.

## Regression evidence

The mobile auth/UX contracts must prove or enforce:

- same explicit `intentId` + recomputed retry payload -> same key + original payload;
- distinct explicit `intentId`s + identical payload -> distinct keys;
- fresh intent allocation claims its synchronous single-flight guard before the first async preflight and releases it in `finally`;
- a concurrent same-hook submit cannot allocate/persist another intent while the first is in flight;
- income retry across local midnight -> same intent/key/original date;
- an unresolved intent survives a restart/read after more than 90 days and still reuses its original key/payload rather than being silently aged out;
- deterministic old payload-equality aliasing control;
- deterministic old pending-store last-writer-wins control and fixed preservation of both intents;
- restart persistence;
- logout/account switch isolation;
- session change before preparation -> fail closed before pending creation;
- supported legacy pending-state migration retaining ambiguous key/payload;
- all four financial screens use the explicit-intent transport boundary;
- restore/sign-in/foreground reconciliation is serialized and pinned to the enumerating session snapshot;
- closing the originating form cannot make an ambiguous operation disappear from authenticated UI status;
- unresolved status is owner-scoped and privacy-safe;
- a fresh same-operation intent waits for explicit additional-operation acknowledgement before a new identity is allocated;
- definitive closure refreshes the unresolved status;
- the `America/Sao_Paulo` financial date contract from #37 remains green in the same gate.
