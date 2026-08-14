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

## Native/runtime notes

- `react-native-gesture-handler` is imported before application bootstrap because the navigation stack depends on its native initialization.
- Session tokens are stored through `expo-secure-store`; do not replace this with plain AsyncStorage for authentication credentials.
- `expo-notifications` uses explicit date trigger types and the Android `bills` channel. Validate scheduling/cancellation after SDK upgrades.
- `expo-updates`, `runtimeVersion`, EAS project metadata, and build/update channels are configured in `app.json` / `eas.json`; changes to them require build/update validation rather than TypeScript-only evidence.
- Legacy icon/splash declarations that pointed at files with mismatched image content were removed during the SDK 57 migration. New production artwork should only be reintroduced with correctly encoded assets and Expo config validation.

## Dependency security

`npm audit` evidence is captured by CI. The SDK 57 migration removed all critical findings from the previous Expo 54 graph. Residual advisories must be reviewed against the resolved Expo/Metro dependency tree; fixes that require an incompatible Expo/React Native downgrade are documented rather than forced or silently suppressed.

## Environment

Create `mobile/.env` from `.env.example`. Public Expo variables are client-visible by design. Never place Supabase service-role credentials, backend secrets, or provider secrets in `EXPO_PUBLIC_*` variables.
