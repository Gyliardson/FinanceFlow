# FinanceFlow Security Model

## Scope

FinanceFlow handles financial records and payment receipts. The portfolio runtime therefore uses a per-user ownership model rather than a shared application secret as the long-term authorization boundary.

## Identity and authorization

- Supabase Auth is the identity authority for end users.
- Protected requests use `Authorization: Bearer <access-token>`; alternate schemes and malformed bearer values fail closed.
- The backend validates the access token with Supabase Auth before constructing a user-scoped Data API client.
- The verified access token is attached to PostgREST so PostgreSQL RLS can evaluate `auth.uid()` for that request.
- Request-scoped user/client context is bound only for the request lifetime and reset afterward.
- Financial tables carry an `owner_id` referencing `auth.users(id)`.
- PostgreSQL Row Level Security is the final data-isolation boundary.
- Authenticated policies permit access only when `owner_id = auth.uid()`.
- Anonymous table access is revoked.
- The backend service-role credential is server-only and must never be exposed through `EXPO_PUBLIC_*`, client bundles, logs, fixtures or screenshots.
- A publishable Supabase key is not an authorization decision by itself; protected requests must carry an authenticated user session before application data is accessed.

Production starts through the Uvicorn factory `runtime:create_app`, not `main:app`. That composition root removes the legacy `X-API-KEY` middleware and wildcard CORS, installs verified Supabase Bearer authentication, preserves only explicit browser origins, and replaces security-sensitive legacy receipt/recurring endpoints with user-scoped implementations. `main.py` remains the legacy route module while the migration is incremental; direct `main:app` execution is not the supported production authorization boundary.

The PR must remain draft until the mobile has a real Supabase session lifecycle and the complete application boundary, cache isolation, deployment/build evidence and remaining negative authorization checks are proven.

## Ownership migration

Migration `003_user_ownership_rls.sql` introduces the owner columns, restrictive policies and authenticated grants. Existing rows intentionally remain unowned when the migration runs without an end-user session and are therefore inaccessible through user-scoped RLS.

Existing production/demo rows must be reconciled explicitly before migration `004_enforce_owner_not_null.sql` is applied. Migration 004 fails closed if any bill, income or settings row still has `owner_id IS NULL`; it never guesses ownership or deletes financial records.

Recommended operator procedure:

1. take a database backup;
2. inventory all rows with `owner_id IS NULL`;
3. determine the correct account for each row through an auditable manual process;
4. update only the reviewed rows using an administrative/server context;
5. verify that no unowned rows remain;
6. apply migration 004;
7. run the ownership/RLS verification gate.

Do not automate ownership guessing from descriptions, e-mail addresses, filenames or other financial metadata.

## Payment receipts

The `receipts` bucket is private. Application startup may create it or force an existing bucket back to `public = false`; it must never make the bucket public.

Migration `005_private_receipt_paths.sql` adds `receipt_path`. The durable database value for new private receipts is the object path, not a public or expiring URL. Existing `receipt_url` values are preserved for explicit reconciliation; no migration silently deletes historical payment evidence.

New receipt object keys use the canonical namespace `<owner_uuid>/<bill_uuid>/<opaque_filename>`. Server helpers reject paths outside that exact owner/bill namespace before the service-role storage client may create temporary access.

Signed receipt URLs are bounded to a maximum of 15 minutes, with a default lifetime of 5 minutes. They are transient response material only and must never be persisted or logged.

The production payment route and reusable payment service enforce these invariants:

- bill lookup and the final payment update use the authenticated RLS-scoped Data API client supplied by the request layer;
- receipt bytes are signature-validated and size-bounded before storage;
- file extension and content type come from validated bytes, never the client filename;
- the final database write is compare-and-set on `status != paid`, so a concurrent second submit cannot silently overwrite the first payment;
- a zero-row compare-and-set is treated as an authorization/race failure;
- if upload succeeds but payment persistence fails, the uploaded object is removed on a best-effort basis so partial failures do not leave unnecessary financial documents behind;
- storage/provider exception details are not propagated as public domain errors;
- the payment response does not expose the durable storage path or a public URL.

Private receipt access is split from privileged storage: the user-scoped Data API client must first return the bill and its `receipt_path`; only then may the server-only storage helper create a bounded signed URL. An RLS-filtered cross-user identifier is therefore handled like a missing receipt and never reaches privileged storage.

The completed access flow is:

1. authorize the caller against the bill owner through the user-scoped/RLS client;
2. upload under an owner-scoped, server-generated object path;
3. persist only that object path;
4. generate bounded private access on demand after authorization;
5. never log temporary access URLs or raw financial-document content.

## Recurring work

Recurring generation in the production composition does not rely on a request `ContextVar` surviving after the response. Both recurring creation and explicit generation receive the already authenticated Data API client and execute within the request lifetime. PostgreSQL uniqueness remains the final idempotency authority for generated instances.

## Failure behavior

Security-sensitive operations fail closed:

- missing/invalid/expired bearer tokens are rejected without leaking provider errors;
- invalid authentication responses never construct a Data API client;
- missing storage service-role configuration prevents private storage initialization;
- unexpected bucket-management failures abort startup instead of silently weakening privacy;
- unowned historical rows prevent NOT NULL promotion;
- RLS rejects cross-user reads/writes even if a resource identifier is guessed;
- receipt paths outside the authenticated owner/bill namespace are rejected before signed access is created;
- receipt MIME spoofing, empty files, unknown formats and oversized uploads are rejected before storage;
- a payment database failure after upload triggers best-effort orphan cleanup;
- a concurrent/zero-row payment update fails closed instead of claiming success;
- production HTTP exceptions with status 5xx are sanitized so provider/database details are not returned to clients;
- authorization failures must not fall back to the legacy static API key.

## CI evidence

The CI security track is expected to prove, with disposable PostgreSQL where applicable:

- bearer parsing rejects missing and malformed credentials;
- invalid/expired auth never reaches the user-scoped data client;
- authenticated request context is reset after every request;
- User A cannot read or mutate User B rows;
- forged `owner_id` inserts are rejected;
- anonymous financial-table access is rejected;
- historical unowned rows make migration 004 fail without deletion;
- explicit backfill allows migration 004 to complete;
- production composition removes the legacy API-key middleware and rejects wildcard CORS;
- security-sensitive receipt and recurring routes replace their legacy implementations exactly once;
- private receipt keys are owner/bill scoped and signed URL lifetimes are bounded;
- receipt payment tests cover MIME spoofing, already-paid state, storage failure, database failure, orphan cleanup and compare-and-set double-submit behavior;
- private receipt access tests prove an unauthorized/missing bill never invokes privileged storage;
- recurring tests prove the authenticated client is passed explicitly instead of being recovered after a background handoff;
- internal HTTP 5xx details are sanitized while client/domain 4xx details remain usable;
- backend tests, dependency evidence and secret scanning remain green.

This document describes the intended enforced model. A PR must remain draft while any required mobile application-session wiring, cache isolation, deployment proof or negative authorization test is incomplete.
