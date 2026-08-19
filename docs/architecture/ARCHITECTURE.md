# FinanceFlow architecture and trust boundaries

This document maps the production architecture and its principal trust boundaries. It complements the backend domain/security contracts rather than replacing them.

## Production request path

```text
React Native / Expo
  -> Supabase Auth session
  -> Authorization: Bearer <access token>
  -> FastAPI composition root (`backend/runtime.py`)
  -> verified request identity
  -> user-scoped Supabase Data API client
  -> PostgreSQL RLS (`auth.uid()` / `owner_id`)
  -> financial tables
```

The mobile application never receives the Supabase service-role credential. FastAPI verifies the end-user session and performs normal financial Data API operations with authenticated user context so PostgreSQL RLS remains an authorization boundary rather than documentation-only policy.

## Major components

### Mobile

- React Native / Expo SDK 57.
- Supabase session lifecycle with secure local persistence, refresh, and logout.
- Dynamic Bearer token provider for FinanceFlow API requests.
- Owner-scoped read-only financial cache for supported offline behavior.
- Durable owner-scoped pending state only for already-submitted ambiguous non-convergent mutations.
- Local due-date notifications.
- EAS Build / EAS Update configuration for operator-managed distribution.

### Backend

- FastAPI application factory in `backend/runtime.py`.
- Pydantic/API models and explicit domain validation.
- Exact decimal-money helpers; authoritative financial arithmetic avoids binary floating-point semantics.
- Supabase Auth verification and request-scoped identity.
- PostgreSQL/Supabase Data API persistence with RLS.
- Private Supabase Storage for receipt documents.
- External AI/OCR provider behind explicit validation and privacy boundaries.
- Docker image used by the declared backend deployment path.

### PostgreSQL and migrations

Database constraints are part of the correctness model, not only storage details. Important guarantees include:

- owner-scoped rows for financial entities;
- RLS enforcement between users;
- exact numeric financial columns;
- owner-derived sanctioned write RPCs;
- recurring-instance uniqueness under retry/concurrency;
- durable replay for scoped non-convergent financial mutations;
- fail-closed migrations where silently deleting or assigning historical financial data would be unsafe.

See [Financial rules](../../backend/FINANCIAL_RULES.md) and the [Security model](../../backend/SECURITY_MODEL.md).

## Trust boundaries

### Identity and authorization

Supabase Auth establishes end-user identity. FastAPI verifies the Bearer session and binds a user-scoped Data API client to the request. PostgreSQL RLS is the final cross-owner data-isolation boundary. Caller-supplied resource IDs, owner IDs, or financial subtotals are not authority merely because they reached the API.

Security and privilege details are documented in the [Security model](../../backend/SECURITY_MODEL.md) and [Authenticated data plane](../security/AUTHENTICATED_DATA_PLANE.md).

### Money and financial intent

Financial inputs are normalized to fixed-scale decimal semantics and authoritative calculations remain decimal through persistence boundaries. Four non-convergent create/add operations use durable server-side `Idempotency-Key` replay. The mobile client preserves the same key and original payload while an already-submitted outcome remains ambiguous.

This pending state is not a general offline financial-write queue. New financial mutations remain online-only.

See [Financial rules](../../backend/FINANCIAL_RULES.md), [Logical intent identity](./LOGICAL_INTENT_IDENTITY.md), and [Offline resilience](./OFFLINE_RESILIENCE.md).

### Receipt uploads and storage

Receipt documents cross an untrusted upload boundary. The backend validates bounded size and actual content signatures rather than trusting filename extensions or declared MIME alone. Persisted receipt identity is an owner/bill-scoped private object path, not a permanent public URL. Access is granted through bounded signed URLs only after authorization.

A transport or Data API exception after upload is an ambiguous outcome, not proof of rollback. Cleanup is reconciliation-first: an object can be deleted only after authoritative owner-scoped state proves that the attempted object is not referenced.

Service-role access is isolated to server-side storage operations and is not used as a substitute for normal user-scoped financial Data API access.

### OCR / AI

OCR and AI responses are untrusted provider output. Provider responses are locally validated before fields are treated as usable, and low-confidence/unreadable OCR requires review instead of becoming an automatic financial write. Passive insights reads do not invoke the external provider; refresh is explicit.

Critical CI does not depend on a live external AI request. See [OCR security](../../backend/OCR_SECURITY.md) and [AI privacy](../security/AI_PRIVACY.md).

### Offline state

The supported offline read model is deliberately conservative: encrypted owner-scoped cached financial reads with freshness and corruption handling. New financial writes are not queued offline. A separate pending mutation record exists only so an already-submitted ambiguous financial intent can be replayed/reconciled safely with its original identity.

See [Offline resilience](./OFFLINE_RESILIENCE.md).

### Experimental adapters

DASMEI, TIM, Unopar, IMAP/PDF, and the related scheduler are experimental and disabled by default. They are not production availability guarantees. External interfaces are treated as mutable and untrusted; CAPTCHA/human-verification/access-control states fail closed instead of triggering evasion behavior.

Their outputs are candidates requiring validation and they do not independently persist authoritative financial records.

## Deployment boundary

The repository defines reproducible configuration contracts, while external credentials and infrastructure remain operator-managed:

- Render/backend server configuration;
- Supabase project/database/storage configuration and credentials;
- EAS environment values, signing credentials, and store accounts;
- external AI/OCR provider credential.

Client-visible `EXPO_PUBLIC_*` configuration is public by design and must never contain service-role, database, or provider secrets. See [Deployment](../operations/DEPLOYMENT.md).

## Deliberate limitations

- CI does not prove live third-party portals remain compatible.
- CI does not provision or validate real production credentials.
- Remote native EAS builds/signing require operator-controlled external state.
- Repository tests cannot reproduce all GitHub/Expo/Supabase operator settings.
- Physical-device behavior is not claimed unless that exact device flow was exercised.
- Residual upstream Expo/React Native/tooling dependency advisories remain visible when no compatible safe patched path exists; they are not hidden with forced incompatible downgrades.
