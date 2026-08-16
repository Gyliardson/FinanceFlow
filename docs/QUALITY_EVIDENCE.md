# FinanceFlow quality and verification evidence

FinanceFlow treats green CI as evidence for specific properties, not as a blanket claim that every production concern has been proven. This document maps the main risks to the repository gates that exercise them and states important gaps explicitly.

## Gate matrix

| Gate / workflow | What it proves | What it does not prove |
| --- | --- | --- |
| `FinanceFlow CI` | Backend dependency installation, `pip check`, Python compile/tests, PostgreSQL recurring-child uniqueness, PostgreSQL ownership/RLS, mobile TypeScript, dependency-audit evidence and Gitleaks | Live production credentials, native-device behavior, third-party portal availability |
| `Financial idempotency` | PostgreSQL 16 durable replay contract for reserve addition, bill creation, income creation and recurring-template creation, including same-key concurrency, payload mismatch and owner isolation | Mobile logical-intent lifecycle by itself; live production database configuration |
| `Authenticated data plane` | PostgreSQL 16 enforcement of authenticated direct-table DML denial plus sanctioned owner-derived RPC writes, including payment/date/ownership constraints, settings scope, recurring convergence and anonymous denial | Live production database provisioning or external Supabase configuration |
| `Mobile auth contract` | Session restore/refresh/logout/account-switch isolation, owner-scoped offline cache, durable mobile logical-intent identity/original-payload replay, coherent session snapshots and the `America/Sao_Paulo` financial date-only contract | Real Supabase service uptime or every OS keychain implementation |
| `Mobile UX contract` | Source-level regression contracts for critical financial screen states, accessibility semantics, upload guards and fail-closed dashboard behavior | Pixel-perfect visual approval or native assistive-technology behavior on physical devices |
| `Mobile Expo health` | Clean mobile install, TypeScript, Expo Doctor, public config checks, release-env contract and web-export smoke | Signed Android/iOS store builds unless external EAS credentials are supplied |
| `Backend container` | Production Docker image builds and the declared FastAPI factory entrypoint is usable | Render account provisioning or production network/DNS configuration |
| `Supply-chain policy` | Permanent external Actions use immutable full commit SHAs and EAS tooling is exact-version pinned | Upstream compromise of an already reviewed SHA or organization-level GitHub policy |
| `deploy-frontend.yml` preflight | Required public EAS production variables are present before update publication and no server-only secret is intentionally injected | Whether real values point to healthy external services after deployment |

Repository workflow definitions live in [`.github/workflows/`](../.github/workflows/).

## Critical risk coverage

### Financial correctness, logical intent and ambiguous outcomes

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
- mobile pending records persisting the original complete payload and operation key before transport;
- deterministic income-midnight regression proving a retry after date rollover uses the same key and original pre-midnight payload;
- deterministic control proving the historical payload-only matcher would split D vs D+1 into two identities;
- serialized pending-store read/modify/write per owner + operation, plus a control reproducing the historical last-writer-wins loss;
- coherent mobile mutation-session snapshots tying owner, access token and session generation together and failing closed on account switch;
- owner-isolated encrypted pending state across logout/account switch.

The key claim, financial effect and durable replay result share the same PostgreSQL transaction. The mobile layer does not replace that ledger; it preserves the logical identity required to exercise the ledger correctly. Generated recurring-child uniqueness is a separate invariant and is not used as a substitute for recurring-template creation idempotency.

Canonical rules: [`backend/FINANCIAL_RULES.md`](../backend/FINANCIAL_RULES.md).

### Financial date-only semantics

Evidence distinguishes business-calendar dates from timestamps:

- product financial timezone is the IANA zone `America/Sao_Paulo`;
- mobile `financialDateOnly()` derives `YYYY-MM-DD` through `Intl.DateTimeFormat` with that timezone, not device-local getters or UTC slicing;
- the audited instant corresponding to `2026-08-14 22:30 America/Sao_Paulo` has a control value of `2026-08-15` under the historical `toISOString().split('T')[0]` behavior, while the canonical helper returns `2026-08-14`;
- deterministic coverage spans before/exactly/after local midnight, the UTC-next-day window, month rollover and year rollover;
- a historical São Paulo offset case proves the helper relies on IANA rules rather than a hard-coded `-03:00` assumption;
- a static financial-domain guard rejects `toISOString().split('T')[0]` and equivalent UTC slicing in financial date-only screens without banning legitimate timestamp serialization globally;
- backend financial-impact coverage proves `initial_balance_date = D` inclusively counts income/payment records on D and that drifting the boundary to D+1 changes authoritative balances.

User-selected due dates remain calendar-component values, while notification triggers are scheduling instants constructed from an already-authoritative due-date calendar value. This distinction is intentional.

### Authentication, ownership and privacy

Evidence includes:

- missing/malformed/invalid/expired credential paths;
- verified request-scoped user context;
- PostgreSQL RLS tests under a non-owner role;
- cross-user read/update denial and forged-owner rejection;
- anonymous financial-table denial;
- authenticated direct-table INSERT/UPDATE/DELETE denial;
- sanctioned owner-derived financial/settings/payment RPC boundaries;
- private receipt-path authorization and bounded signed access;
- mobile session restore, refresh, logout and account-switch isolation;
- coherent mutation preparation preventing owner-A/token-B or owner-B/token-A combinations;
- unresolved financial payloads stored owner-scoped in `SecureStore`, with one-way removal of the historical AsyncStorage form;
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
- owner-scoped encrypted pending operation records for the four non-convergent financial POST mutations;
- original-payload/key reuse after network loss, timeout, retryable server error, reconnect, app/module restart and local-midnight rollover;
- concurrent different pending intents surviving deterministic read/write interleavings;
- definitive success or non-retryable 4xx closing the pending identity so an intentional later duplicate can receive a new key.

Financial mutations remain online-only; offline cache is display/read resilience, not an offline financial-write queue.

Canonical offline model: [`docs/OFFLINE_RESILIENCE.md`](./OFFLINE_RESILIENCE.md).

### Repository governance and supply chain

The active `Protect main` ruleset is verified through GitHub rather than inferred from documentation. It requires PR promotion, conversation resolution, strict required checks, blocks deletion/non-fast-forward changes and has no bypass actors. Its globally required list includes the always-on `PostgreSQL authenticated write boundary` context in addition to the existing backend, PostgreSQL, mobile auth/UX, dependency and secret gates. Path-filtered release jobs remain release evidence without becoming global required checks that could deadlock unrelated PRs.

A repository-side governance contract verifies that `.github/workflows/authenticated-data-plane.yml` continues to run for pull requests to both `main` and `portfolio/revamp-2026` without a path filter and that governance documentation retains the exact required context name. This contract detects repository drift but does not replace re-reading the remote GitHub ruleset after settings changes.

Permanent external Actions are pinned to reviewed full commit SHAs with version comments. EAS CLI is exact-version pinned. Details and the current required-check set are recorded in [`docs/GOVERNANCE.md`](./GOVERNANCE.md).

### Mobile build/configuration

The current mobile baseline is Expo SDK 57 / React Native 0.86. CI verifies clean dependency installation, TypeScript, Expo Doctor, public configuration and a web export smoke. Release configuration validates the required EAS public environment contract before update publication.

Remote signed Android/iOS builds still depend on operator-controlled EAS credentials and therefore remain a manual/external release step.

### Experimental integrations

DASMEI, TIM, Unopar and IMAP/PDF tests use fixtures/deterministic boundaries. CI does not depend on live portals, private credentials or CAPTCHA/human-verification bypasses. The adapters are opt-in and are not registered as production financial mutation routes. External compatibility is therefore a documented runtime limitation, not a hidden CI assumption.

## Dependency/security evidence

The final program audit consumes the artifacts from the exact integration SHA rather than relying on workflow badges alone. Dependency counts/findings are therefore re-opened after the final remediation integration instead of being assumed from an older certification SHA.

The mobile npm graph keeps residual upstream/tooling advisories visible when no compatible patched Expo/Metro/React Native path exists. The repository does not use `npm audit fix --force`, an incompatible framework downgrade, or a blanket allowlist merely to manufacture a zero-finding result.

Passing Gitleaks reduces the risk of committed secrets but does not replace operator-side secret rotation, least privilege or external platform configuration review.

## Review discipline

An issue is not considered done because one narrow test passed. Relevant work requires code/documentation alignment, exact-head gates, diff review, and integration into `portfolio/revamp-2026`. The final `portfolio/revamp-2026 -> main` promotion remains manual and cannot be performed by automation.

Before that final promotion, the program requires an independent adversarial audit. Internal green CI and internal review can advance the state only to `AWAITING_INDEPENDENT_AUDIT`; they cannot declare `READY FOR MAINTAINER MERGE`.

Visual work has an additional constraint: source-level accessibility/layout defenses and build smoke can be automated, but native visual approval is not claimed unless rendered screenshots/device output can actually be inspected.
