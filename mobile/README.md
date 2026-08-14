# FinanceFlow Mobile

FinanceFlow Mobile is an Expo-managed React Native application.

## Supported baseline

The portfolio revamp currently targets:

- Expo SDK 57 (`expo ~57.0.12`)
- React Native `0.86.2`
- React `19.2.3`
- TypeScript `~6.0.3`
- Node.js `22.13.x` or newer within the Expo SDK 57 supported range

Keep Expo-managed native packages aligned with the SDK. Do not upgrade React Native independently from Expo or use `npm audit fix --force` to force an incompatible dependency graph.

## Install and validate

Use the committed lockfile for reproducible installs:

```bash
npm ci
npx tsc --noEmit
npx expo-doctor
npx expo config --type public
npx expo export --platform web --output-dir dist-ci
```

The same checks run in GitHub Actions through the `Mobile Expo health` workflow. A clean lockfile install and Expo Doctor are required before treating a dependency migration as valid.

## Authentication and pending financial mutations

Authentication credentials and unresolved financial-mutation state are private device state.

- Session tokens are stored with `expo-secure-store`.
- A financial mutation is prepared from one coherent authenticated-session snapshot containing the access token, authenticated owner id and a local session generation. If the session changes before transport preparation completes, the request fails closed instead of combining one user's namespace with another user's token.
- For bill creation, income creation, reserve addition and recurring-template creation, the first submission persists an owner-scoped pending record **before transport**. That record owns the `Idempotency-Key` and the complete original request payload.
- Ambiguous outcomes such as network loss, timeout and retryable server errors retain the pending record. A reconnect, manual retry or app/module restart reuses the same key and replays the original payload rather than silently rebuilding derived fields from the current clock/UI state.
- Income date is a derived first-submission field for local intent matching. Crossing local midnight while an income outcome is unresolved does not manufacture a second operation; the original date and key are replayed.
- Pending-store read/modify/write operations are serialized per owner + operation so different simultaneous intents cannot overwrite one another.
- Pending financial records are stored owner-scoped in `SecureStore`; the historical AsyncStorage format is migrated one way and removed. Do not log full pending payloads or move them back to unencrypted AsyncStorage.
- Normal logout intentionally retains an ambiguous pending record encrypted under its original owner namespace so that owner can reconcile it later. Another account cannot select or reuse that key/payload. A dedicated purge helper exists for an explicit destructive lifecycle decision.
- Confirmed success or definitive non-retryable 4xx rejection closes the pending identity. A later explicit user action is a new intent and receives a new key.

The PostgreSQL/RLS layer remains the authority for owner isolation and durable replay. Mobile persistence does not replace the database idempotency ledger; it preserves the logical identity needed to use that ledger correctly across uncertain transport outcomes.

## Native/runtime notes

- `react-native-gesture-handler` is imported before application bootstrap because the navigation stack depends on its native initialization.
- Session tokens are stored through `expo-secure-store`; do not replace this with plain AsyncStorage for authentication credentials.
- `expo-notifications` uses explicit date trigger types and the Android `bills` channel. Validate scheduling/cancellation after SDK upgrades.
- `expo-updates`, `runtimeVersion`, EAS project metadata, and build/update channels are configured in `app.json` / `eas.json`; changes to them require build/update validation rather than TypeScript-only evidence.
- The Expo 57 native migration bumps the app version to `1.1.0`. Because `runtimeVersion.policy` is `appVersion`, this creates a new OTA runtime boundary and prevents Expo 57 updates from targeting older Expo 54 binaries.
- The production EAS Update workflow uses Node 22.13 and only injects public runtime configuration. Server/service-role/provider secrets must not be reintroduced into the client bundle.
- Legacy icon/splash declarations that pointed at files with mismatched image content were removed during the SDK 57 migration. New production artwork should only be reintroduced with correctly encoded assets and Expo config validation.

## Dependency security

`npm audit` evidence is captured by CI. The SDK 57 migration removed all critical findings from the previous Expo 54 graph. Residual advisories must be reviewed against the resolved Expo/Metro dependency tree; fixes that require an incompatible Expo/React Native downgrade are documented rather than forced or silently suppressed.

## Environment

Create `mobile/.env` from `.env.example`. Public Expo variables are client-visible by design. Never place Supabase service-role credentials, backend secrets, or provider secrets in `EXPO_PUBLIC_*` variables.
