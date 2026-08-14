# Offline and resilience model

FinanceFlow supports a deliberately conservative offline mode for financial data.

## Supported behavior

The mobile app may display the last successfully cached **bill list** for the currently authenticated Supabase user when the API or authentication service is temporarily unreachable.

Financial cache entries are:

- namespaced by authenticated user ID;
- encrypted at rest through Expo SecureStore;
- split into bounded SecureStore chunks with a small manifest so a large bill list is not written as one oversized secure-storage value;
- versioned;
- timestamped with the time of the last successful local persistence;
- treated as read-only fallback data;
- rejected when JSON, manifest, chunk completeness or cache-envelope metadata is malformed;
- removed best-effort when corruption is detected.

The offline banner shows the saved-data timestamp when it is known. Historical owner-scoped AsyncStorage entries are accepted only as a one-way migration source, moved to secure storage and removed from plaintext storage. Their freshness remains unknown until a successful server response rewrites them in the current versioned format. If secure migration cannot be completed, the historical plaintext financial cache is discarded rather than retained indefinitely.

A cached settings object alone is **not** sufficient to make the dashboard available offline. The bill list is the authoritative dataset for that dashboard. An empty cached bill list is valid data and is distinct from having no usable cache.

## Revalidation

The app re-requests current server data when the dashboard is focused or the user explicitly retries/refreshes. A valid server response immediately becomes authoritative in memory.

Local cache persistence is best-effort: failure to write SecureStore after a successful API read must not convert fresh server data into an offline/error response. It also must not fall back to writing sensitive financial payloads to plaintext AsyncStorage.

## Authentication and ownership

The existing Supabase session boundary remains authoritative:

- sessions are stored in native secure storage using SecureStore-compatible key namespaces;
- transient refresh/network failure may preserve the same user's encrypted offline cache;
- invalid/expired refresh credentials clear that user's session and financial cache;
- logout clears the current user's cache;
- account switching cannot reuse another user's financial cache;
- legacy global financial cache keys fail closed unless an explicit owner marker matches during one-time migration;
- pending financial mutation state uses the same runtime-safe SecureStore key-character contract and remains owner scoped.

SecureStore is used only behind an explicit storage boundary. The CI mock deliberately models two native constraints relevant to this design: SecureStore keys must use the supported alphanumeric/`.`/`-`/`_` character set, and individual test values are capped at 2048 characters so accidental reintroduction of oversized single-value cache writes fails the contract. Production cache chunks are smaller than that test bound.

## Financial writes are online-only

FinanceFlow does **not** queue new financial mutations for later synchronization.

While offline, actions that create or mutate financial state — including bills, income, payments and financial settings — require a working authenticated API connection. The separate pending-idempotency record exists only to reconcile an already-submitted operation whose outcome is ambiguous; it is not a general offline write queue.

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

The mobile auth/cache contract covers session restart, expiry, refresh concurrency, logout, account switching and owner isolation. The offline cache contract additionally covers:

- encrypted versioned cache round-trip and freshness metadata;
- absence of current financial cache payloads in plaintext AsyncStorage;
- bounded chunking of a cache payload larger than a single secure-storage test value;
- SecureStore key-format enforcement;
- one-way owner-scoped AsyncStorage migration and plaintext cleanup;
- malformed legacy JSON, malformed secure manifests and missing chunks;
- secure-storage read failure with no plaintext fallback;
- best-effort secure-storage write failure without plaintext persistence;
- failed legacy-to-secure migration deleting the plaintext financial cache rather than preserving it indefinitely;
- authoritative empty bill lists;
- dashboard wiring that keeps successful network reads authoritative;
- explicit read-only offline UX.
