# FinanceFlow architecture and trust boundaries

This document is a reviewer-oriented map of the production architecture. It complements the deeper domain/security documents rather than replacing them.

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

The mobile application never receives the Supabase service-role credential. The backend validates the end-user session and performs normal financial Data API operations with that authenticated user context so PostgreSQL RLS remains an authorization boundary rather than documentation-only policy.

## Major components

### Mobile

- React Native / Expo SDK 57.
- Supabase session lifecycle with secure local persistence, refresh and logout.
- Dynamic Bearer token provider for FinanceFlow API requests.
- Owner-scoped read-only financial cache for supported offline behavior.
- Local due-date notifications.
- EAS Build / EAS Update configuration for operator-managed distribution.

### Backend

- FastAPI application factory in `backend/runtime.py`.
- Pydantic/API models and explicit domain validation.
- Exact decimal-money helpers; authoritative financial arithmetic avoids binary floating-point semantics.
- Supabase Auth verification and request-scoped identity.
- PostgreSQL/Supabase Data API persistence with RLS.
- Private Supabase Storage for receipt documents.
- Google GenAI provider behind deterministic validation boundaries for OCR/insights.
- Docker image used by the declared backend deployment path.

### PostgreSQL and migrations

Database constraints are part of the correctness model, not only storage details. Important guarantees include:

- owner-scoped rows for financial entities;
- RLS enforcement between users;
- exact numeric financial columns;
- recurring-instance uniqueness under retry/concurrency;
- fail-closed migrations where silently deleting or assigning historical financial data would be unsafe.

See [`backend/FINANCIAL_RULES.md`](../backend/FINANCIAL_RULES.md) and [`backend/SECURITY_MODEL.md`](../backend/SECURITY_MODEL.md).

## Trust boundaries

### Identity and authorization

Supabase Auth establishes end-user identity. FastAPI verifies the Bearer session and binds a user-scoped Data API client to the request. PostgreSQL RLS is the final data-isolation boundary. A client-supplied resource id, owner id or subtotal is not considered authority merely because it reached the API.

Security details and migration/backfill constraints are documented in [`backend/SECURITY_MODEL.md`](../backend/SECURITY_MODEL.md).

### Money

Financial inputs are normalized to fixed-scale decimal semantics and authoritative calculations remain decimal through persistence boundaries. Recurring generation relies on database uniqueness to make duplicate retry/concurrent insert paths fail safely.

See [`backend/FINANCIAL_RULES.md`](../backend/FINANCIAL_RULES.md).

### Receipt uploads and storage

Receipt documents cross an untrusted upload boundary. The backend validates bounded size and actual content signatures rather than trusting filename extensions or declared MIME alone. Persisted receipt identity is an owner/bill-scoped private object path, not a permanent public URL. Access is granted through bounded signed URLs only after authorization.

Service-role access is isolated to server-side storage operations and is not used as a substitute for normal user-scoped financial Data API access.

### OCR / AI

OCR output is untrusted provider output. The production provider can request schema-constrained structured output, but FinanceFlow still revalidates provider text locally before treating fields as valid. Invalid, unreadable or low-confidence extraction is surfaced for manual correction/review instead of becoming an automatic financial write.

Critical CI does not call a live Gemini service. See [`backend/OCR_SECURITY.md`](../backend/OCR_SECURITY.md).

### Offline state

The supported offline model is deliberately conservative: owner-scoped cached financial reads. Offline financial mutation queues are not claimed because conflict resolution, server idempotency and eventual-consistency semantics would need stronger guarantees first.

Cache envelopes include ownership/freshness metadata, malformed or incompatible data fails closed, and account changes/logout do not reuse another user's cache.

See [`docs/OFFLINE_RESILIENCE.md`](./OFFLINE_RESILIENCE.md).

### Third-party adapters

DASMEI, TIM, Unopar, IMAP/PDF and the related scheduler are experimental and disabled by default. They are not production availability guarantees. External interfaces are treated as mutable and untrusted; CAPTCHA/human-verification/access-control states fail closed instead of triggering evasion behavior.

Their outputs are candidates requiring validation and they do not independently persist authoritative financial records.

## Deployment boundary

The repository defines reproducible configuration contracts, while external credentials and infrastructure remain operator-managed:

- Render/backend server configuration;
- Supabase project/database/storage configuration and credentials;
- EAS environment values, signing credentials and store accounts;
- Gemini server credential.

Client-visible `EXPO_PUBLIC_*` configuration is public by design and must never contain service-role/database/Gemini secrets. See [`docs/DEPLOYMENT.md`](./DEPLOYMENT.md).

## Deliberate limitations

- CI does not prove live third-party portals remain compatible.
- CI does not provision or validate real production credentials.
- Remote native EAS builds/signing require operator-controlled external state.
- The autonomous workflow can review source/diffs/build evidence but cannot claim visual approval of native React Native screens without inspectable rendered evidence.
- Residual upstream Expo/React Native/tooling dependency advisories remain visible when no compatible safe patched path exists; they are not hidden with forced incompatible downgrades.
