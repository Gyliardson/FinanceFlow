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

The reusable bearer-validation and request-context primitives are implemented independently of the legacy middleware so they can be tested before the route migration is complete. Until `main.py` is switched from the legacy global `X-API-KEY` middleware to the verified bearer middleware and owner-aware writes, the PR must remain draft.

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

The completed access flow must be:

1. authorize the caller against the bill owner through the user-scoped/RLS client;
2. upload under an owner-scoped, server-generated object path;
3. persist only that object path;
4. generate bounded private access on demand after authorization;
5. never log temporary access URLs or raw financial-document content.

## Failure behavior

Security-sensitive operations fail closed:

- missing/invalid/expired bearer tokens are rejected without leaking provider errors;
- invalid authentication responses never construct a Data API client;
- missing storage service-role configuration prevents private storage initialization;
- unexpected bucket-management failures abort startup instead of silently weakening privacy;
- unowned historical rows prevent NOT NULL promotion;
- RLS rejects cross-user reads/writes even if a resource identifier is guessed;
- receipt paths outside the authenticated owner/bill namespace are rejected before signed access is created;
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
- private receipt keys are owner/bill scoped and signed URL lifetimes are bounded;
- backend tests, dependency evidence and secret scanning remain green.

This document describes the intended enforced model. A PR must remain draft while any required application-session wiring, private receipt route migration, migration proof or negative authorization test is incomplete.
