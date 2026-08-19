# FinanceFlow technical documentation

This directory is the canonical index for FinanceFlow engineering documentation. The root [README](../README.md) is the visitor-facing overview; the documents below describe architecture, security boundaries, operational procedures, and assurance evidence in greater depth.

## Architecture

- [Architecture and trust boundaries](architecture/ARCHITECTURE.md) — production components, request flow, storage boundaries, and the distinction between runtime and external dependencies.
- [Logical intent identity](architecture/LOGICAL_INTENT_IDENTITY.md) — durable mobile intent identity, `Idempotency-Key` replay, original-payload preservation, and ambiguous-outcome convergence.
- [Offline resilience](architecture/OFFLINE_RESILIENCE.md) — owner-scoped read resilience, SecureStore cache behavior, and why pending financial mutations are not a general offline write queue.

## Security

- [Authenticated data plane](security/AUTHENTICATED_DATA_PLANE.md) — least-privilege PostgreSQL write surface, owner-derived RPCs, RLS, and direct-table DML restrictions.
- [AI privacy](security/AI_PRIVACY.md) — explicit AI invocation, data minimization, passive-read behavior, and provider-output trust boundaries.

## Operations

- [Clean-room validation](operations/CLEAN_ROOM.md) — fresh-checkout validation and exact-candidate evidence procedure.
- [Deployment](operations/DEPLOYMENT.md) — Render, Supabase, and EAS configuration ownership and public/server credential boundaries.
- [Android local development](operations/MOBILE_LOCAL_ANDROID.md) — canonical Expo SDK 57 physical-device Development Build + Metro workflow.

## Assurance

- [Governance](assurance/GOVERNANCE.md) — repository-defined controls, CI expectations, and the boundary between source-controlled contracts and operator-managed GitHub settings.
- [Quality evidence](assurance/QUALITY_EVIDENCE.md) — risk-to-gate mapping, exact-SHA evidence expectations, and limitations of CI claims.
- [Secret scan gate](assurance/SECRET_SCAN_GATE.md) — exact-candidate Git-history coverage and fail-closed Gitleaks evidence contract.

## Domain contracts

These documents stay next to the backend code because they specify code-adjacent invariants:

- [Financial rules](../backend/FINANCIAL_RULES.md) — exact money, financial dates, idempotency, payments, and recurring-bill rules.
- [Security model](../backend/SECURITY_MODEL.md) — authentication, ownership/RLS, private receipts, and failure behavior.
- [OCR security](../backend/OCR_SECURITY.md) — upload validation, OCR trust, and manual-review boundaries.

## Mobile contracts

- [Mobile engineering notes](../mobile/README.md) — supported Expo/React Native baseline, auth/pending state, date semantics, and runtime notes.
- [Notifications](../mobile/NOTIFICATIONS.md) — local reminder behavior and privacy constraints.

## Translations

The deep technical documentation remains canonical in English. The project overview is available in:

- [English](../README.md)
- [Português do Brasil](i18n/pt-BR/README.md)
- [日本語](i18n/ja/README.md)
- [Español](i18n/es/README.md)

## Evidence boundary

FinanceFlow distinguishes repository-proven properties from operator-managed or external properties. CI can establish deterministic source, database, build/configuration, and security contracts for an exact candidate SHA. It cannot by itself prove live production credentials, current third-party service availability, remote platform settings, signed store builds, or physical-device behavior that was not actually exercised.

When evidence is external or unavailable, documentation should state that boundary explicitly rather than convert an assumption into a claim.
