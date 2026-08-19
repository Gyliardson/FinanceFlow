# FinanceFlow mobile

React Native / Expo client for FinanceFlow personal-finance workflows.

## Current baseline

The mobile application currently targets:

- Expo `~57.0.14`;
- React Native `0.86.x` as resolved by the current Expo SDK 57 dependency graph;
- Node.js 22.13+ for the repository's current clean-install/CI toolchain.

`mobile/package.json` is the source-controlled package baseline. This document does not authorize dependency upgrades; version changes belong in their own reviewed scope.

## Install and static health

From `mobile/`:

```bash
npm ci
npx tsc --noEmit
npx --yes expo-doctor@1.20.2
```

Repository CI also exercises the release-environment contract and an Expo web-export smoke where defined.

## Android physical-device development

Expo SDK 57 physical-device development uses the project's **Development Build + Metro** workflow. A bare `npx expo start` command is not the complete supported device setup path.

Use the canonical runbook:

[Android local development](../docs/operations/MOBILE_LOCAL_ANDROID.md)

That document covers development-client installation, public environment configuration, Metro startup, network/device considerations, and the evidence boundary between a repository build check and a real physical-device smoke.

## Authentication

The client uses Supabase Auth and persists the supported session through the mobile secure-storage boundary. FinanceFlow API requests use the current Bearer access token; the backend verifies it before constructing user-scoped data access.

Important properties include:

- session restore/refresh is explicit;
- logout/account-switch isolation prevents one owner's local financial state from being selected by another owner;
- mutation preparation binds owner + token + session generation coherently;
- server-only credentials such as `SUPABASE_SERVICE_ROLE_KEY` never belong in the mobile bundle;
- all `EXPO_PUBLIC_*` values are public by design and must contain only client-safe configuration.

See the root [README](../README.md) and [Security model](../backend/SECURITY_MODEL.md).

## Financial dates

The mobile client uses `America/Sao_Paulo` for financial DATE-only semantics. Business dates such as income dates and locally prepared financial “today” values must come from the canonical timezone-aware date helper rather than `Date.toISOString().slice(0, 10)` or equivalent UTC slicing.

This distinction is covered by deterministic tests around local midnight, UTC day rollover, month/year boundaries, and historical IANA timezone behavior.

## Financial mutation identity

Four non-convergent financial actions use the explicit logical-intent boundary:

- ordinary bill creation;
- income creation;
- reserve addition;
- recurring-template creation.

For an explicit intent, the mobile layer persists the `Idempotency-Key` plus the complete original first-submission payload before transport. If the result becomes ambiguous because of timeout, network loss, response loss, or session interruption, retry/reconnect/restart uses the **same key and same original payload**.

A new explicit action receives a new local intent and a new key even when its business payload matches an unresolved older action. Payload equality does not define intent identity.

Pending financial state is **not** a general offline write queue. New financial mutations remain online-only. Pending records exist only to reconcile already-submitted operations whose server outcome may be unknown.

Detailed contract: [Logical intent identity](../docs/architecture/LOGICAL_INTENT_IDENTITY.md).

## Pending-state privacy and corruption behavior

Unresolved financial intent records are owner-scoped in SecureStore. The authenticated UI can surface category/count status, but does not expose amounts, titles, original payloads, idempotency keys, or local intent IDs in the global unresolved-operation indicator.

A normal read cache is replaceable and may be discarded/refetched when corrupt. Ambiguous mutation evidence is different: unreadable pending state may correspond to a committed financial effect whose response was lost. The client therefore fails closed for that owner/operation instead of interpreting corrupt pending state as empty.

Logout or closing the originating form does not prove an ambiguous server effect was cancelled and does not silently erase the durable replay identity.

## Offline read resilience

FinanceFlow supports owner-scoped offline **reads** for selected financial data through encrypted/local cache envelopes with freshness and corruption handling.

Offline behavior intentionally does not create new financial writes while connectivity/auth is unavailable. A pending record may survive offline only because that operation was already submitted before its outcome became ambiguous.

See [Offline resilience](../docs/architecture/OFFLINE_RESILIENCE.md).

## Bills and recurring obligations

The mobile client distinguishes recurring templates from concrete payable child bills.

- An ordinary bill can be created as a financial mutation.
- A recurring template represents monthly scheduling metadata.
- Generated recurring children are the payable instances.
- Templates are not directly markable as paid.
- Recurrence behavior, including short-month clamping, is ultimately protected by backend/database contracts.

## Payments and receipts

Payment flows can complete with or without a receipt. Receipt-backed payments upload a validated document through the backend; the mobile client does not receive service-role storage authority.

Receipt objects remain private and are accessed through authorized bounded signed URLs. If the backend reports an ambiguous persistence outcome, the client must not infer that the uploaded evidence was rolled back; the backend reconciles against authoritative owner-scoped state before cleanup.

See [Security model](../backend/SECURITY_MODEL.md).

## Reserve / emergency fund

The current product supports reserve **addition** and emergency-fund goal tracking. It does not expose a supported reserve withdrawal/decrement endpoint. Mobile presentation and documentation must preserve that boundary.

## OCR and financial insights

OCR-assisted extraction is advisory input, not authoritative financial truth. Upload validation and provider-output validation occur on the backend, and low-confidence/unreadable results require review.

Financial insight reads are passive. External AI/provider invocation occurs only on explicit supported refresh/generation operations rather than every dashboard read.

See [OCR security](../backend/OCR_SECURITY.md) and [AI privacy](../docs/security/AI_PRIVACY.md).

## Local notifications

Due-date reminders are local-device behavior and are intentionally privacy-conscious. Notification bodies should not expose unnecessary sensitive financial details on a locked screen.

See [NOTIFICATIONS.md](NOTIFICATIONS.md).

## Release configuration

The mobile runtime requires the public configuration contract documented in `.env.example` and EAS configuration:

- `EXPO_PUBLIC_API_URL`;
- `EXPO_PUBLIC_SUPABASE_URL`;
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.

These are public bundle values. Never place service-role, database, deployment, or external-provider secrets in them.

Production EAS values, signing credentials, store accounts, and `EXPO_TOKEN` are operator-managed external state. Repository CI can validate configuration shape and build/static contracts without claiming those external credentials are provisioned.

See [Deployment](../docs/operations/DEPLOYMENT.md).

## Quality contracts

The mobile-specific source-defined gates include:

- `Mobile auth contract` / `Auth session, cache and mutation identity`;
- `Mobile UX contract` / `UX state and accessibility contract`;
- `Mobile Expo health` / `Expo Doctor and build smoke`.

These checks cover deterministic source/runtime contracts. They do not replace native visual inspection, signed-store build evidence, or physical-device smoke when those are required by a runtime-changing release.

The hardening branch `portfolio/revamp-2026` is historical: its work is already integrated into `main`. Some workflow definitions still contain historical branch triggers; those triggers remain source-defined compatibility until changed in a separate workflow scope and should not be treated as the forward development model.

For repository-wide evidence, see [Quality evidence](../docs/assurance/QUALITY_EVIDENCE.md) and [Governance](../docs/assurance/GOVERNANCE.md).
