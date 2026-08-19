# FinanceFlow Mobile — Android local development

This runbook is the canonical local smoke path for the current **Expo SDK 57 / React Native 0.86** mobile application.

It is intentionally non-destructive: local development must not remove EAS ownership, the EAS project id, `expo-updates`, the production update URL, or other reviewed release configuration from `app.json`.

## What this path is for

Use it when you want to edit the mobile code on a PC and see changes on a physical Android device through **Development Build + Metro + QR code + Fast Refresh**, while talking to the already-provisioned FinanceFlow backend/Supabase environment.

The repository configuration remains the source of truth. Do not rewrite `app.json` just to make local Metro work.

## 1. Start from a clean clone

From the repository root:

```bash
git status
cd mobile
npm ci
```

If `git status` already shows unrelated local work, preserve it. Do not use a destructive reset as part of this runbook.

The CI baseline is Node `22.13.0`; use a compatible Node 22 installation locally.

## 2. Pull the public runtime configuration

The mobile runtime requires exactly these public values:

```text
EXPO_PUBLIC_API_URL
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

They are client-visible by design. Never put a Supabase service-role/secret key, Render secret, EAS token or other server credential in an `EXPO_PUBLIC_*` variable.

The repository pins EAS CLI `21.8.0` in its release-tooling closure. If you are authenticated to the FinanceFlow EAS project, pull the already-reviewed production environment into the local Expo environment file:

```bash
npx eas-cli@21.8.0 whoami
npx eas-cli@21.8.0 env:pull --environment production --path .env.local
```

`mobile/.gitignore` ignores `.env*.local`; verify that the generated file is not staged:

```bash
git status --short
```

Do not commit `.env.local`.

If EAS authentication is unavailable, create `mobile/.env.local` from `mobile/.env.example` using the same three public production values. Do not copy server-side keys into it.

Validate the resulting configuration without printing the values:

```bash
node scripts/validate-release-env.mjs
```

The validator should finish with:

```text
Required mobile runtime configuration is present and release-safe.
```

## 3. Verify the JavaScript/Expo closure

Before opening the device:

```bash
npx tsc --noEmit
npx expo-doctor
```

Fix real blockers before continuing. Do not downgrade Expo/React Native to force compatibility with a different Expo Go binary.

## 4. Build the Android Development Client once

The repository already contains an EAS `development` profile with `developmentClient: true` and internal distribution. The mobile dependency closure includes the SDK-compatible `expo-dev-client` package required by that profile.

Authenticate if necessary:

```bash
npx eas-cli@21.8.0 whoami
```

Then create the Android development build:

```bash
npx eas-cli@21.8.0 build --platform android --profile development
```

EAS produces an installable Android development artifact. When the build completes, install it on the physical device using the EAS build page/QR code. This installation is normally needed only when the native dependency/configuration surface changes; ordinary TypeScript/JavaScript edits do not require another native build.

If an older FinanceFlow installation on the device predates a deliberate Supabase Auth reset, clear its application data or uninstall it before the first clean-room smoke. A development build may use the same Android application id, so an upgrade can otherwise preserve old secure application state.

## 5. Start Metro and scan the development QR

From `mobile/`, start Metro explicitly for the development client:

```bash
npx expo start --dev-client --clear
```

LAN is the default and preferred path. Keep the PC and phone on the same network, open the installed FinanceFlow development build, and scan the Metro QR code.

If LAN is blocked by the router/firewall, Expo supports an ngrok tunnel fallback. Install the tunnel helper once:

```bash
npm i -g @expo/ngrok
```

Then start Metro with:

```bash
npx expo start --dev-client --clear --tunnel
```

Tunnel is slower and its URL is public-with-entropy, so prefer LAN when it works.

## 6. Expected editing loop

Keep Metro running:

```text
edit file -> save -> Fast Refresh on Android
```

There is no need to rebuild the native development client or publish an EAS Update for ordinary JavaScript/TypeScript edits.

## 7. Authentication after a Supabase reset

FinanceFlow persists a valid-looking mobile session in SecureStore so an offline owner can resume safely. If the Supabase Auth database is deliberately reset while an old access token is still locally unexpired, the first render can temporarily observe that persisted session.

The protected FinanceFlow API remains authoritative. A `401 Unauthorized` for the exact current bearer snapshot is wired through the Axios response interceptor to the auth-session invalidation handler. The current session and that owner's local financial cache are then cleared, which makes `App.tsx` render `LoginScreen`.

For a deterministic clean-room smoke after intentionally resetting Supabase, clear the old FinanceFlow application data before the first launch. Do not clear unrelated Android applications.

A stale Supabase user/token is **not** a reason to bypass Login, add an unauthenticated Home route, remove the existing auth gate, or add a second global 401 interceptor.

If the app receives a protected-endpoint 401 and still remains authenticated after the request finishes, capture the Metro log and treat that as a regression.

## 8. Current login-only test flow

The current mobile UI contains sign-in but no end-user registration screen. After a clean Supabase reset, create a disposable test user through the normal Supabase Authentication admin/dashboard flow, then sign in through FinanceFlow.

Do not seed `auth.users` directly with ad-hoc SQL for this smoke test.

After sign-in, verify the normal API path (for example the pending bills/Home load) rather than inserting financial rows directly in the database. This exercises Bearer validation, owner-scoped RLS and the supported application data plane.

## 9. Do not do these things

For local QR/Fast Refresh troubleshooting, do **not**:

- delete `expo-dev-client` or `expo-updates`;
- delete EAS `owner`, `projectId` or `updates.url` from `app.json`;
- create a replacement `app.json` disconnected from the EAS project;
- downgrade SDK 57 just to force the store version of Expo Go;
- put a Supabase `service_role`/secret key in the mobile environment;
- commit `.env.local`;
- treat browser CORS behavior as proof that the native Android transport is broken.

## 10. Why Development Build is the canonical SDK 57 path

During the current SDK 57 transition, Expo directs physical-device projects away from forcing SDK 57 through Expo Go and documents Development Build as the production-project workflow. A Development Build is the project's own native client: once installed, Metro still provides the QR-code/Fast-Refresh editing loop, while the native dependency and EAS configuration remain under project control.
