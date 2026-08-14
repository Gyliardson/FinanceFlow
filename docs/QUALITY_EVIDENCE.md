# FinanceFlow quality and verification evidence

FinanceFlow treats green CI as evidence for specific properties, not as a blanket claim that every production concern has been proven. This document maps the main risks to the repository gates that exercise them and states important gaps explicitly.

## Gate matrix

| Gate / workflow | What it proves | What it does not prove |
| --- | --- | --- |
| `FinanceFlow CI` | Backend dependency installation, `pip check`, Python compile/tests, disposable PostgreSQL financial/idempotency checks, PostgreSQL ownership/RLS checks, mobile TypeScript, dependency-audit evidence, Gitleaks | Live production credentials, native device behavior, third-party portal availability |
| `Backend container` | Production Docker image builds and the declared FastAPI factory entrypoint is usable | Render account provisioning, production network/DNS configuration |
| `Mobile auth/cache contract` | Session restore/refresh/logout/account-switch invariants and owner-scoped offline-cache contracts using deterministic harnesses | Real Supabase service uptime, OS keychain implementation correctness on every device |
| `Mobile UX contract` | Source-level regression contracts for critical financial screen states, accessibility semantics, upload guards and fail-closed dashboard behavior | Pixel-perfect visual approval or native assistive-technology behavior on physical devices |
| `Mobile Expo health` | Clean mobile install, TypeScript, Expo Doctor, public config checks, release-env contract and web-export smoke | Signed Android/iOS store builds unless external EAS credentials are supplied |
| `deploy-frontend.yml` preflight | Required public EAS production variables are present before update publication and no server-only secret is intentionally injected | Whether real values point to healthy external services after deployment |

Repository workflow definitions live in [`.github/workflows/`](../.github/workflows/).

## Critical risk coverage

### Financial correctness

Evidence includes:

- exact decimal-money unit/domain tests;
- zero, negative, large-value, sub-cent and rounding-boundary scenarios;
- disposable PostgreSQL numeric round trips;
- monthly recurrence edge cases around 28/29/30/31, leap years and year transitions;
- migration behavior that fails closed on unsafe historical duplicate states;
- concurrent recurring-instance insertion proving the database uniqueness boundary;
- retry/bulk-conflict recovery cases.

Canonical rules: [`backend/FINANCIAL_RULES.md`](../backend/FINANCIAL_RULES.md).

### Authentication, ownership and privacy

Evidence includes:

- missing/malformed/invalid/expired credential paths;
- verified request-scoped user context;
- disposable PostgreSQL RLS tests under a non-owner role;
- cross-user read/update denial and forged-owner rejection;
- anonymous financial-table denial;
- private receipt-path authorization and bounded signed access;
- mobile session restore, refresh, logout and account-switch isolation;
- secret scanning.

Canonical security model: [`backend/SECURITY_MODEL.md`](../backend/SECURITY_MODEL.md).

### Upload / OCR boundary

Evidence includes synthetic-only tests for:

- supported content signatures and MIME mismatch;
- empty/oversized/malformed upload input;
- malformed structured output and unsupported fields;
- impossible/noncanonical dates and invalid monetary/confidence ranges;
- timeout, rate limit, outage and unexpected provider failures;
- unreadable/low-confidence extraction requiring manual review;
- deterministic provider tests without live Gemini calls.

Canonical OCR model: [`backend/OCR_SECURITY.md`](../backend/OCR_SECURITY.md).

### Offline resilience

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
- online-only financial mutations.

Canonical offline model: [`docs/OFFLINE_RESILIENCE.md`](./OFFLINE_RESILIENCE.md).

### Mobile build/configuration

The current mobile baseline is Expo SDK 57 / React Native 0.86. CI verifies clean dependency installation, TypeScript, Expo Doctor, public configuration and a web export smoke. Release configuration validates the required EAS public environment contract before update publication.

Remote signed Android/iOS builds still depend on operator-controlled EAS credentials and therefore remain a manual/external release step.

### Experimental integrations

DASMEI, TIM, Unopar and IMAP/PDF tests use fixtures/deterministic boundaries. CI does not depend on live portals, private credentials or CAPTCHA/human-verification bypasses. External compatibility is therefore a documented runtime limitation, not a hidden CI assumption.

## Dependency/security evidence

Python dependency audit is expected to remain clean on the supported backend graph. Mobile dependency audit evidence is preserved rather than force-fixed across incompatible Expo/React Native versions. Residual upstream/tooling findings must stay visible until a compatible patched dependency path exists.

Gitleaks is a repository gate; passing it reduces the risk of committed secrets but does not replace operator-side secret rotation, least privilege or external platform configuration review.

## Review discipline

An issue is not considered done because one narrow test passed. Relevant work requires code/documentation alignment, exact-head gates, diff review, and integration into `portfolio/revamp-2026`. The final `portfolio/revamp-2026 -> main` promotion remains manual.

Visual work has an additional constraint: source-level accessibility/layout defenses and build smoke can be automated, but native visual approval is not claimed unless rendered screenshots/device output can actually be inspected.
