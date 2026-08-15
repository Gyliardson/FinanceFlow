# Insights AI privacy boundary

FinanceFlow treats external generative AI as an explicit third-party trust boundary. Opening the Insights screen or calling `GET /insights` does **not** contact the AI provider.

## Passive read

`GET /insights` performs only owner-scoped/RLS-protected database reads and local financial calculations. It returns current balance, estimated monthly surplus, reserve values and the latest insight already persisted for that owner. If no stored insight exists, `insight` is `null`.

The passive route must never call `generate_financial_insights` or any other external AI provider.

## Explicit refresh

The external provider is contacted only by the explicit `POST /insights/refresh` action initiated from the mobile “Atualizar análise” button.

The provider prompt is deliberately minimized to exactly these aggregate categories:

- current balance;
- estimated monthly surplus after commitments;
- emergency-fund goal.

The inspected Insights prompt does not send raw receipts, bill descriptions, filenames, individual transaction rows or the reserve's saved-balance value. The mobile UI discloses the categories sent externally before the refresh action is available.

## Logging and failures

Provider prompts, aggregate financial payloads and raw provider responses/errors must not be logged. Provider exceptions and invalid provider output are converted to stable server-side errors; the canonical runtime's privacy-safe HTTP exception handler prevents 5xx provider/database details from reaching clients.

## Tests

Deterministic backend tests must prove that passive `GET /insights` cannot call the provider, including when the persisted insight is absent or stale, and that explicit refresh can call the provider and persist the newly generated insight. CI must not depend on a live Gemini request.
