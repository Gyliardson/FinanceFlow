# Offline and resilience model

FinanceFlow supports a deliberately conservative offline mode for financial data.

## Supported behavior

The mobile app may display the last successfully cached **bill list** for the currently authenticated Supabase user when the API or authentication service is temporarily unreachable.

Financial cache entries are:

- namespaced by authenticated user ID;
- encrypted at rest through Expo SecureStore;
- split into bounded SecureStore chunks with a small manifest so a large bill list is not written as one oversized secure-storage value;
- serialized per authenticated owner/resource across read, write, migration and destructive cleanup operations so concurrent requests cannot orphan chunk generations or republish data after logout cleanup;
- versioned;
- timestamped with the time of the last successful local persistence;
- treated as read-only fallback data;
- rejected when JSON, manifest, chunk completeness or cache-envelope metadata is malformed;
- removed best-effort when corruption is detected.

The offline banner shows the saved-data timestamp when it is known. Historical owner-scoped AsyncStorage entries are accepted only as a one-way migration source, moved to secure storage and removed from plaintext storage. Their freshness remains unknown until a successful server response rewrites them in the current versioned format. If secure migration cannot be completed, the historical plaintext financial cache is discarded rather than retained indefinitely.

A cached settings object alone is **not** sufficient to make the dashboard available offline. The bill list is the authoritative dataset for that dashboard. An empty cached bill list is valid data and is distinct from having no usable cache.

## Revalidation and failure classification

The app re-requests current server data when the dashboard is focused or the user explicitly retries/refreshes. A valid server response immediately becomes authoritative in memory.

Offline cache is a transport/service resilience mechanism, not a way to hide an authoritative HTTP error. Dashboard cache fallback is allowed for failures with no HTTP response (for example connectivity/timeout), HTTP 5xx, and the explicitly transient HTTP statuses 408, 425 and 429. Other HTTP 4xx responses fail closed instead of substituting stale financial data.

In particular:

- HTTP **401** from the protected FinanceFlow API means the bearer snapshot used by that request was rejected. The app does not read financial cache for that failed request and invalidates that exact session snapshot locally.
- 401 invalidation is bound to user ID, token and session generation, and serialized with session persistence. A delayed rejection from an older request therefore cannot clear a newer login, including a newer session for the same user.
- A successful authenticated response is also bound to the exact request session snapshot before callers can consume/cache its data. A response that arrives after logout, account replacement or a newer same-owner session is classified as `FINANCEFLOW_STALE_AUTH_SESSION`, rejected, and is not eligible for offline-cache substitution.
- HTTP **403** is treated separately as an authorization denial. It does not qualify for offline fallback and does not automatically invalidate an otherwise valid authentication session.
- Network errors and 5xx/transient service responses do **not** invalidate credentials; same-owner read-only cache remains available when present.

Local cache persistence is best-effort: failure to write SecureStore after a successful API read must not convert fresh server data into an offline/error response. It also must not fall back to writing sensitive financial payloads to plaintext AsyncStorage.

The chunked SecureStore protocol is coordinated per `(owner, resource)` inside the application process. This ordering is part of the privacy teardown contract, not merely a performance optimization: a logout cleanup waits for an already-started cache transaction and then removes the published generation, while a transaction queued before cleanup cannot later publish chunks behind that cleanup. Destructive corruption handling is ordered by the same protocol, preventing a stale reader from deleting a newer writer's manifest.

## Authentication and ownership

The existing Supabase session boundary remains authoritative:

- sessions are stored in native secure storage using SecureStore-compatible key namespaces;
- transient refresh/network failure may preserve the same user's encrypted offline cache;
- invalid/expired refresh credentials clear that user's session and financial cache;
- an authoritative protected-API 401 clears only the rejected current owner's session/cache and only if the request snapshot is still current;
- logout clears the current user's cache;
- account switching cannot reuse another user's financial cache;
- legacy global financial cache keys fail closed unless an explicit owner marker matches during one-time migration;
- pending financial mutation state uses the same runtime-safe SecureStore key-character contract and remains owner scoped.

SecureStore is used only behind an explicit storage boundary. The CI mock deliberately models two native constraints relevant to this design: SecureStore keys must use the supported alphanumeric/`.`/`-`/`_` character set, and individual test values are capped at 2048 characters so accidental reintroduction of oversized single-value cache writes fails the contract. Production cache chunks are smaller than that test bound.

## Financial writes are online-only

FinanceFlow does **not** queue new financial mutations for later synchronization.

While offline, actions that create or mutate financial state — including bills, income, payments and financial settings — require a working authenticated API connection. The separate pending-idempotency record exists only to reconcile an already-submitted non-convergent operation whose outcome is ambiguous; it is not a general offline write queue.

A protected-API 401 is intentionally **not** a definitive financial-mutation rejection: unresolved idempotency identity remains durable so the same authenticated owner can reconcile an ambiguous submission after reauthentication. Auth invalidation must not manufacture a second logical financial intent.

Financial settings updates are convergent replacement writes rather than additive creates, so the mobile client does not create a pending replay intent for them. A transport/server error still cannot prove rollback: the server may have committed the settings before the response was lost. The UI therefore reports an **unconfirmed outcome** and instructs the user to reload/reconcile authoritative settings before deciding whether another save is needed.

A goal-only edit uses the authenticated `PATCH /settings/emergency-fund-goal` boundary. It updates only `emergency_fund_goal` server-side instead of performing a client-side GET followed by a full settings replacement; this prevents a stale goal editor snapshot from overwriting a newer initial balance or balance date.

A safe offline mutation queue would require a separately designed server protocol covering at least:

- idempotency keys;
- duplicate-submit detection;
- retries across process/app restarts;
- conflict detection and resolution;
- ordering/dependencies between mutations;
- partial failures;
- observable synchronization state.

Without those guarantees, silently queueing financial writes could create duplicate or stale financial records. Read-only degradation is preferred to unsafe eventual consistency.

## Validation

The mobile auth/cache contract covers session restart, expiry, refresh concurrency, logout, account switching and owner isolation. It also executes the API-rejection and successful-response freshness contracts against production auth/cache helpers, including:

- network and 5xx/transient failures remaining eligible for offline fallback;
- 401/403/non-transient 4xx being ineligible for stale cache substitution;
- current rejected snapshots clearing only their owner and local session;
- stale 401 snapshots being unable to clear a newer same-owner login;
- successful responses from logged-out, replaced-owner or replaced same-owner sessions being rejected before callers can consume/cache them;
- stale-session response failures being ineligible for offline fallback.

The offline cache contract additionally covers:

- encrypted versioned cache round-trip and freshness metadata;
- absence of current financial cache payloads in plaintext AsyncStorage;
- bounded chunking of a cache payload larger than a single secure-storage test value;
- SecureStore key-format enforcement;
- one-way owner-scoped AsyncStorage migration and plaintext cleanup;
- malformed legacy JSON, malformed secure manifests and missing chunks;
- secure-storage read failure with no plaintext fallback;
- best-effort secure-storage write failure without plaintext persistence;
- failed legacy-to-secure migration deleting the plaintext financial cache rather than preserving it indefinitely;
- concurrent same-resource writers being serialized with no superseded generation left orphaned;
- logout cleanup being ordered after in-flight cache writes so no owner generation survives teardown;
- reader/writer interleavings being serialized so destructive stale-reader cleanup cannot delete a newly published manifest;
- authoritative empty bill lists;
- dashboard wiring that keeps successful network reads authoritative and refuses cache fallback before lookup on authoritative HTTP rejection;
- settings-save regression coverage that forbids false rollback claims after ambiguous failures;
- goal-only settings regression coverage that forbids stale full-row read/modify/write;
- explicit read-only offline UX.
