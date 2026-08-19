# FinanceFlow security model

This document describes the effective security boundaries of the current FinanceFlow application. It focuses on properties enforced by source, database migrations, and deterministic tests; it does not turn external platform settings or a historical hardening snapshot into timeless security claims.

## Trust model

FinanceFlow assumes all client input, caller-provided identifiers, uploaded files, external-provider output, network outcomes, and third-party integrations can be incomplete, stale, malformed, or adversarial.

The main trust boundaries are:

- Supabase Auth for end-user identity;
- FastAPI request authentication and composition;
- user-scoped Supabase Data API/PostgREST access;
- PostgreSQL RLS and owner-derived database functions;
- server-only private receipt storage capability;
- explicit external OCR/AI calls whose output remains untrusted;
- owner-scoped secure mobile persistence for sensitive local state.

No single layer is treated as a universal security guarantee.

## Authentication

The mobile client signs in with Supabase Auth and sends the current access token to FinanceFlow API routes as a Bearer credential. FastAPI verifies that access token before constructing the authenticated request context.

Important properties:

- missing, malformed, invalid, or expired credentials fail authentication;
- request identity comes from the verified token rather than a caller-supplied owner field;
- session refresh/logout/account-switch paths are explicit;
- the mobile bundle receives only public Supabase configuration, never a service-role key;
- server-only provider/database/storage credentials remain outside the client.

## Ownership and PostgreSQL RLS

Financial tables are owner-scoped. PostgreSQL RLS remains the final cross-user row-isolation boundary for authenticated data access.

A caller cannot gain authority merely by supplying another user's `owner_id`, bill id, settings id, receipt path, or other object identifier. Canonical operations either:

- read through the authenticated user-scoped Data API context and RLS; or
- execute sanctioned database functions that derive ownership from `auth.uid()`.

The current authenticated data plane revokes direct table `INSERT`, `UPDATE`, and `DELETE` for the `authenticated` role on canonical financial tables after the sanctioned write surface is established. Owner-scoped reads remain available where required.

See [Authenticated data plane](../docs/security/AUTHENTICATED_DATA_PLANE.md).

## SECURITY DEFINER functions

The effective database write surface includes narrowly scoped `SECURITY DEFINER` functions. This is a privilege mechanism, not a claim that a function is safe simply because it uses that keyword.

The reviewed boundary depends on the combination of:

- owner derivation from `auth.uid()`;
- rejection of an absent authenticated owner;
- no caller-supplied `owner_id` on the sanctioned functions;
- fixed safe `search_path`;
- restricted execute grants;
- bounded operation-specific parameters;
- database constraints and transactional behavior;
- deterministic positive/negative PostgreSQL tests.

Migration `007_authenticated_data_plane.sql` also converts the four durable financial-idempotency functions introduced by migration 006 from their original `SECURITY INVOKER` form to the effective `SECURITY DEFINER` form needed after direct authenticated table DML is revoked.

## Service-role boundary

`SUPABASE_SERVICE_ROLE_KEY` is server-only. It must never be exposed in the React Native/Expo bundle or any `EXPO_PUBLIC_*` value.

Normal financial Data API operations intentionally use authenticated end-user context so RLS remains active. Service-role capability is isolated to server-side operations that actually require elevated platform authority, principally private storage operations; it is not a shortcut around the user-scoped financial authorization model.

## Financial correctness as a security boundary

FinanceFlow treats several correctness properties as security-relevant because violating them can create unauthorized or duplicated financial effects:

- exact decimal money;
- owner-derived writes;
- financial DATE-only semantics in `America/Sao_Paulo`;
- durable mutation idempotency;
- original-payload replay for ambiguous mobile intents;
- database-owned payment date;
- recurring-instance uniqueness under retry/concurrency.

Pending financial mutation records are not a general offline write queue. They retain the identity of an already-submitted ambiguous operation so the client can replay the same key and original payload rather than manufacture a second effect.

See [FINANCIAL_RULES.md](FINANCIAL_RULES.md) and [Logical intent identity](../docs/architecture/LOGICAL_INTENT_IDENTITY.md).

## Receipt upload boundary

Receipt documents are untrusted uploads.

Before persistence, the backend applies bounded upload validation and verifies actual supported content signatures rather than trusting filename extensions or declared MIME type alone. Object identity is generated by the server under an owner/bill-scoped private path.

The mobile client does not receive permanent public receipt URLs. Authorized reads first resolve an owner-scoped bill/receipt association and then issue bounded signed access to the private object.

## Receipt-backed payment reconciliation

A payment with a receipt crosses two durable systems: private object storage and PostgreSQL financial state. A transport exception after the object upload and payment request begins does **not** prove that the payment failed before commit.

The current implementation is reconciliation-first:

1. upload the validated receipt to its owner/bill-scoped private path;
2. invoke the sanctioned `finance_mark_bill_paid` transition;
3. if transport/RPC response is missing, malformed, or raises an exception, re-read the authoritative bill through the authenticated RLS-scoped data client;
4. if the bill is durably paid with the attempted receipt path, retain that object and return/converge to the committed payment;
5. if authoritative state shows another completed payment owns a different receipt, delete only the losing attempted upload;
6. if authoritative state proves the bill remains unpaid and the attempted object is unreferenced, delete that orphan;
7. if reconciliation cannot be completed, retain the object fail-safe and surface an ambiguous persistence error for later reconciliation.

Therefore, “persistence failed” is not an instruction to immediately delete the uploaded receipt. Cleanup requires authoritative evidence that the attempted object is not referenced by the durable financial state.

This is specifically covered by commit-then-response-loss and failed-reconciliation tests. Preserving a bounded possible orphan is preferable to deleting evidence that an already-committed payment still references.

## Storage-upload failure before payment transition

Storage upload itself is a separate boundary. If the receipt cannot be persisted before the payment RPC starts, the financial transition has not begun. The implementation attempts to remove the exact generated object path in case storage committed but its response was lost, then raises a storage error. This case must not be conflated with a transport exception after the financial RPC has started.

## Receipt authorization

Receipt access is derived from authenticated financial state:

- lookup occurs in the authenticated owner scope;
- the stored object key is validated against the expected owner/bill namespace;
- only then is a short-lived signed URL produced;
- the private bucket itself is not made public.

A guessed object path or bill id is not sufficient authority.

## OCR / AI boundary

External OCR/AI systems are untrusted providers, not authorization or accounting authorities.

- Provider invocation is explicit for supported OCR/insight operations.
- Passive insight reads do not invoke the provider.
- Uploaded content is validated locally before provider use.
- Structured provider output is validated locally before fields are accepted.
- Low-confidence/unreadable OCR requires review instead of silent automatic financial persistence.
- Critical CI does not require a live external-provider call.

See [OCR_SECURITY.md](OCR_SECURITY.md) and [AI privacy](../docs/security/AI_PRIVACY.md).

## Mobile local-state privacy

Sensitive local state is owner-scoped.

- Supabase session material uses secure platform storage through the supported mobile auth boundary.
- Supported offline financial read cache is owner-scoped and treated as replaceable read resilience.
- Ambiguous financial intent records use owner-scoped SecureStore persistence and preserve the original key/payload required for safe replay.
- Account switches/logout do not allow one owner to select another owner's cache or pending mutation.
- Private pending payloads and replay identifiers are not rendered in the global unresolved-operation status.

Corrupt ordinary read cache can be discarded/refetched. Corrupt ambiguous mutation evidence is stricter: it may correspond to a financial effect whose response was lost, so the client fails closed instead of treating unreadable pending state as “nothing pending.”

See [Offline resilience](../docs/architecture/OFFLINE_RESILIENCE.md).

## Experimental integrations

DASMEI, TIM, Unopar, IMAP/PDF, and related scheduler paths are experimental/opt-in boundaries. They do not receive authority to bypass human-verification/access-control systems and do not independently persist authoritative financial records through a hidden production path.

External sites and message formats remain mutable/untrusted. CAPTCHA, human verification, unexpected authentication state, or incompatible response shape must fail closed rather than trigger evasion behavior.

## Secrets and configuration

Repository configuration separates public client configuration from server secrets.

Public-by-design mobile values include the allowed `EXPO_PUBLIC_*` endpoint/publishable-key configuration. Server-only values include service-role, database, deployment, and external-provider credentials.

The repository uses full-history Gitleaks evidence for secret detection, but a green scan does not prove operator-side secret rotation, remote platform permissions, or environment protection. Those remain external controls.

See [Deployment](../docs/operations/DEPLOYMENT.md) and [Secret scan gate](../docs/assurance/SECRET_SCAN_GATE.md).

## Supply-chain / CI boundary

Repository workflows, Dockerfile inventory, pinned tooling, and the independent FinanceFlow Trust Verifier are assurance mechanisms. They reduce specific supply-chain risks but are not claims of complete security.

The external verifier rereads the exact candidate tree and evaluates its independently held `financeflow-trust-policy/v2`. A documentation change should not require a verifier rebaseline unless it actually changes a policy-bound object; accidental bound-blob/workflow/Dockerfile changes should be removed from the candidate instead.

See [Governance](../docs/assurance/GOVERNANCE.md) and [Quality evidence](../docs/assurance/QUALITY_EVIDENCE.md).

## What repository evidence does not prove

A green candidate does not by itself prove:

- current production Supabase/Render/EAS credentials or remote settings;
- organization/account-level GitHub security configuration;
- physical-device behavior that was not exercised;
- continued compatibility of experimental third-party portals;
- absence of every vulnerability in upstream immutable dependencies.

Those boundaries should be re-observed when a release/review decision depends on them rather than represented by stale documentation snapshots.
