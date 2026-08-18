# FinanceFlow technical evidence index

Use this index when reviewing FinanceFlow as a portfolio/engineering case. The root [`README.md`](../README.md) presents product capabilities and setup; the documents below capture the deeper invariants, quality evidence and operational boundaries.

## Reviewer path

1. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — production component map, request path and trust boundaries.
2. [`QUALITY_EVIDENCE.md`](./QUALITY_EVIDENCE.md) — risk-to-test/CI evidence matrix, including what each gate does **not** prove.
3. [`CLEAN_ROOM.md`](./CLEAN_ROOM.md) — fresh-clone validation and release-candidate runbook.
4. [`DEPLOYMENT.md`](./DEPLOYMENT.md) — EAS/Render/Supabase configuration ownership and public/server credential boundaries.
5. [`OFFLINE_RESILIENCE.md`](./OFFLINE_RESILIENCE.md) — supported owner-scoped read-only offline model and failure semantics.

## Domain/security deep dives

- [`backend/FINANCIAL_RULES.md`](../backend/FINANCIAL_RULES.md) — exact money, rounding, recurrence and concurrency/idempotency rules.
- [`backend/SECURITY_MODEL.md`](../backend/SECURITY_MODEL.md) — authentication, ownership/RLS, private receipts and authorization boundaries.
- [`backend/OCR_SECURITY.md`](../backend/OCR_SECURITY.md) — upload/OCR trust boundary, deterministic provider testing and manual-review semantics.

## Evidence policy

FinanceFlow intentionally distinguishes repository-proven properties from external/manual properties. CI can prove deterministic code, database, build/configuration and security contracts. It cannot by itself prove production credential provisioning, signed native-store builds, live third-party portal compatibility or native visual approval.

When evidence cannot be produced in the autonomous environment, the project documents the limitation instead of substituting a claim.
