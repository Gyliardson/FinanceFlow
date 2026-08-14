# FinanceFlow quality and verification evidence

FinanceFlow treats green CI as evidence for specific properties, not as a blanket claim that every production concern has been proven. This document maps the main risks to the repository gates that exercise them and states important gaps explicitly.

## Gate matrix

| Gate / workflow | What it proves | What it does not prove |
| --- | --- | --- |
| `FinanceFlow CI` | Backend dependency installation, `pip check`, Python compile/tests, PostgreSQL recurring-child uniqueness, PostgreSQL ownership/RLS, mobile TypeScript, dependency-audit evidence and Gitleaks | Live production credentials, native-device behavior, third-party portal availability |
| `Financial idempotency` | PostgreSQL 16 durable replay contract for reserve addition, bill creation, income creation and recurring-template creation, including same-key concurrency, payload mismatch and owner isolation | Mobile transport lifecycle by itself; live production database configuration |
| `Mobile auth contract` | Session restore/refresh/logout/account-switch isolation, owner-scoped offline cache, and unresolved financial-operation identity reuse across retry/restart | Real Supabase service uptime or every OS keychain implementation |
| `Mobile UX contract` | Source-level regression contracts for critical financial screen states, accessibility semantics, upload guards and fail-closed dashboard behavior | Pixel-perfect visual approval or native assistive-technology behavior on physical devices |
| `Mobile Expo health` | Clean mobile install, TypeScript, Expo Doctor, public config checks, release-env contract and web-export smoke | Signed Android/iOS store builds unless external EAS credentials are supplied |
| `Backend container` | Production Docker image builds and the declared FastAPI factory entrypoint is usable | Render account provisioning or production network/DNS configuration |
| `Supply-chain policy` | Permanent external Actions use immutable full commit SHAs and EAS tooling is exact-version pinned | Upstream compromise of an already reviewed SHA or organization-level GitHub policy |
| `deploy-frontend.yml` preflight | Required public EAS production variables are present before update publication and no server-only secret is intentionally injected | Whether real values point to healthy external services after deployment |

Repository workflow definitions live in [`.github/workflows/`](../.github/workflows/).

## Critical risk coverage

### Financial correctness and ambiguous outcomes

Evidence includes:

- exact decimal-money unit/domain tests;
- zero, negative, large-value, sub-cent and rounding-boundary scenarios;
- PostgreSQL numeric round trips;
- monthly recurrence edge cases around 28/29/30/31, leap years and year transitions;
- migration behavior that fails closed on unsafe historical duplicate states;
- concurrent recurring-instance insertion proving the database uniqueness boundary;
- retry/bulk-conflict recovery cases;
- receipt-backed payment tests that explicitly distinguish `FAIL BEFORE COMMIT` from `COMMIT THEN RESPONSE FAILURE`;
- reconciliation proving a receipt referenced by a committed payment is preserved and remains available through authorized signed access;
- durable `Idempotency-Key` replay for reserve addition, ordinary bill creation, income creation and recurring-template creation;
- same-key sequential and concurrent replay, changed-payload rejection, cross-owner isolation, intentional new-key repetition and commit-response-loss retry;
- mobile persistence of the unresolved logical operation identity across reconnect/retry/module restart.

The key claim, financial effect and durable replay result share the same PostgreSQL transaction. Generated recurring-child uniqueness is a separate invariant and is not used as a substitute for recurring-template creation idempotency.

Canonical rules: [`backend/FINANCIAL_RULES.md`](../backend/FINANCIAL_RULES.md).

### Authentication, ownership and privacy

Evidence includes:

- missing/malformed/invalid/expired credential paths;
- verified request-scoped user context;
- PostgreSQL RLS tests under a non-owner role;
- cross-user read/update denial and forged-owner rejection;
- anonymous financial-table denial;
- private receipt-path authorization and bounded signed access;
- mobile session restore, refresh, logout and account-switch isolation;
- secret scanning.

Canonical security model: [`backend/SECURITY_MODEL.md`](../backend/SECURITY_MODEL.md).

### Receipt/storage integrity

Receipt uploads are bounded and validated from file signatures rather than filename alone. Receipt objects are private and owner/bill-scoped. The payment path treats a Data API exception as an ambiguous outcome rather than proof of rollback, re-reads the RLS-scoped bill, and only deletes an uploaded object after authoritative state proves that object is not referenced.

If reconciliation itself is unavailable, the object is retained fail-safe. A bounded orphan is preferable to a persisted `paid + receipt_path` row whose underlying object was destroyed.

### Upload / OCR boundary

Evidence includes synthetic-only tests for:

- supported content signatures and MIME mismatch;
- empty/oversized/malformed upload input;
- malformed structured output and unsupported fields;
- impossible/noncanonical dates and invalid monetary/confidence ranges;
- timeout, rate limit, outage and unexpected provider failures;
- unreadable/low-confidence extraction requiring manual review;
- deterministic provider tests without live Gemini calls.

OCR output remains a suggestion until locally validated and explicitly confirmed by the user; it is not an authoritative financial write.

Canonical OCR model: [`backend/OCR_SECURITY.md`](../backend/OCR_SECURITY.md).

### Offline resilience and mutation identity

Evidence includes:

- owner-scoped cache keys/envelopes;
- corruption and incompatible payload rejection;
- freshness metadata;
- local read/write failures;
- restart/session restore;
- invalid vs transient auth refresh behavior;
- logout/account-switch isolation;
- authoritative empty bill list handling;
- explicit rule that settings cache cannot masquerade as a financial bills cache;
- owner-scoped pending operation records for the four non-convergent financial POST mutations;
- same unresolved owner/operation/payload reusing the same key after network loss, 5xx, reconnect or app restart;
- definitive success or non-retryable 4xx closing the pending identity so an intentional later duplicate can receive a new key.

Financial mutations remain online-only; offline cache is display/read resilience, not an offline financial-write queue.

Canonical offline model: [`docs/OFFLINE_RESILIENCE.md`](./OFFLINE_RESILIENCE.md).

### Repository governance and supply chain

The active `Protect main` ruleset is verified through GitHub rather than inferred from documentation. It requires PR promotion, conversation resolution, strict required checks, blocks deletion/non-fast-forward changes, has no bypass actors, and deliberately requires only always-on PR checks. Path-filtered release jobs remain release evidence without becoming global required checks that could deadlock unrelated PRs.

Permanent external Actions are pinned to reviewed full commit SHAs with version comments. EAS CLI is exact-version pinned. Details and the current required-check set are recorded in [`docs/GOVERNANCE.md`](./GOVERNANCE.md).

### Mobile build/configuration

The current mobile baseline is Expo SDK 57 / React Native 0.86. CI verifies clean dependency installation, TypeScript, Expo Doctor, public configuration and a web export smoke. Release configuration validates the required EAS public environment contract before update publication.

Remote signed Android/iOS builds still depend on operator-controlled EAS credentials and therefore remain a manual/external release step.

### Experimental integrations

DASMEI, TIM, Unopar and IMAP/PDF tests use fixtures/deterministic boundaries. CI does not depend on live portals, private credentials or CAPTCHA/human-verification bypasses. The adapters are opt-in and are not registered as production financial mutation routes. External compatibility is therefore a documented runtime limitation, not a hidden CI assumption.

## Dependency/security evidence

The final program audit consumes the artifacts from the exact integration SHA rather than relying on workflow badges alone. The current supported backend graph reports **80 Python dependencies with 0 `pip-audit` vulnerabilities**, and the Gitleaks SARIF reports **0 findings**.

The mobile npm graph intentionally keeps residual upstream/tooling advisories visible: **18 total (11 high, 7 moderate, 0 critical)** in the current Expo/Metro/React Native graph. The repository does not use `npm audit fix --force`, an incompatible framework downgrade, or a blanket allowlist merely to manufacture a zero-finding result. These advisories remain residual supply-chain/tooling risk to revisit when a compatible patched path exists.

Passing Gitleaks reduces the risk of committed secrets but does not replace operator-side secret rotation, least privilege or external platform configuration review.

## Review discipline

An issue is not considered done because one narrow test passed. Relevant work requires code/documentation alignment, exact-head gates, diff review, and integration into `portfolio/revamp-2026`. The final `portfolio/revamp-2026 -> main` promotion remains manual and cannot be performed by automation.

Before that final promotion, the program requires an independent adversarial audit. Internal green CI and internal review can advance the state only to `AWAITING_INDEPENDENT_AUDIT`; they cannot declare `READY FOR MAINTAINER MERGE`.

Visual work has an additional constraint: source-level accessibility/layout defenses and build smoke can be automated, but native visual approval is not claimed unless rendered screenshots/device output can actually be inspected.
