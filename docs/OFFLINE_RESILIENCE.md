# Offline and resilience model

FinanceFlow supports a deliberately conservative offline mode for financial data.

## Supported behavior

The mobile app may display the last successfully cached **bill list** for the currently authenticated Supabase user when the API or authentication service is temporarily unreachable.

Financial cache entries are:

- namespaced by authenticated user ID;
- versioned;
- timestamped with the time of the last successful local persistence;
- treated as read-only fallback data;
- rejected when JSON or cache-envelope metadata is malformed;
- removed best-effort when corruption is detected.

The offline banner shows the saved-data timestamp when it is known. Legacy owner-scoped cache entries remain readable for compatibility, but their freshness is reported as unknown until a successful server response rewrites them in the current format.

A cached settings object alone is **not** sufficient to make the dashboard available offline. The bill list is the authoritative dataset for that dashboard. An empty cached bill list is valid data and is distinct from having no usable cache.

## Revalidation

The app re-requests current server data when the dashboard is focused or the user explicitly retries/refreshes. A valid server response immediately becomes authoritative in memory.

Local cache persistence is best-effort: failure to write AsyncStorage after a successful API read must not convert fresh server data into an offline/error response.

## Authentication and ownership

The existing Supabase session boundary remains authoritative:

- sessions are stored in native secure storage;
- transient refresh/network failure may preserve the same user's offline cache;
- invalid/expired refresh credentials clear that user's session and financial cache;
- logout clears the current user's cache;
- account switching cannot reuse another user's financial cache;
- legacy global financial cache keys fail closed unless an explicit owner marker matches during one-time migration.

## Financial writes are online-only

FinanceFlow does **not** queue financial mutations for later synchronization.

While offline, actions that create or mutate financial state — including bills, income, payments and financial settings — require a working authenticated API connection. This is intentional.

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

- versioned cache round-trip and freshness metadata;
- legacy raw owner-scoped cache compatibility;
- malformed JSON and malformed envelopes;
- storage read failure;
- best-effort storage write failure;
- authoritative empty bill lists;
- dashboard wiring that keeps successful network reads authoritative;
- explicit read-only offline UX.
