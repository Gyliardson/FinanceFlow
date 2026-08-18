# FinanceFlow Mobile — Android local development

This runbook is the canonical local smoke path for the current **Expo SDK 57 / React Native 0.86** mobile application.

It is intentionally non-destructive: local development must not remove EAS ownership, the EAS project id, `expo-updates`, or the production update URL from `app.json`.

## What this path is for

Use it when you want to edit the mobile code on a PC and see changes on a physical Android device through Metro, a QR code and Fast Refresh while talking to the already-provisioned FinanceFlow backend/Supabase environment.

The repository configuration remains the source of truth. Do not rewrite `app.json` just to make local Metro work.

## 1. Start from a clean clone

From the repository root:

```bash
git status
cd mobile
npm ci
```

If `git status` already shows unrelated local work, preserve it. Do not use a destructive reset as part of this runbook.

The supported Node baseline for SDK 57 in this repository is Node 22.13.x or newer within the compatible Node 22 line.

## 2. Pull the public runtime configuration

The mobile runtime requires exactly these public values:

```text
EXPO_PUBLIC_API_URL
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
```

They are client-visible by design. Never put a Supabase service-role/secret key, Render secret, EAS token or other server credential in an `EXPO_PUBLIC_*` variable.

If you are authenticated to the FinanceFlow EAS project, pull the already-reviewed production environment:

```bash
npx eas-cli@latest whoami
npx eas-cli@latest env:pull --environment production
```

EAS writes the local environment file used by Expo. `.env*.local` is ignored by `mobile/.gitignore`; verify that before continuing:

```bash
git status --short
```

Do not commit the generated local environment file.

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

Fix real blockers before continuing. Do not downgrade Expo/React Native just to accommodate a different Expo Go binary.

## 4. Android physical device — SDK 57 Expo Go smoke path

During an Expo SDK transition, the Expo Go version from the Play Store may not match this project's SDK. Android can side-load a matching Expo Go binary without changing the FinanceFlow repository.

Use Expo's `expo-go` CLI to obtain the Android build matching SDK 57 (or use the equivalent SDK 57 download exposed by Expo):

```bash
npx expo-go download android 57.0.0
```

Install that APK on the Android device. This is a device/tooling action only; it does **not** require removing `owner`, `extra.eas.projectId`, `updates.url`, or `expo-updates` from FinanceFlow.

Once the matching Expo Go is installed, start Metro from `mobile/`:

```bash
npx expo start --go --clear
```

Metro uses LAN by default. With the PC and phone on the same network, scan the terminal QR code from Expo Go.

If LAN is blocked by the router/firewall, use Expo's tunnel fallback:

```bash
npm i -g @expo/ngrok
npx expo start --go --clear --tunnel
```

Tunnel is a fallback because it is slower than LAN.

## 5. Expected editing loop

Keep Metro running:

```text
edit file -> save -> Fast Refresh on Android
```

There is no need to rebuild or republish an EAS Update for ordinary JavaScript/TypeScript edits in this smoke loop.

## 6. Authentication after a Supabase reset

FinanceFlow persists a valid-looking mobile session in SecureStore so an offline owner can resume safely. If the Supabase Auth database was reset while an old access token is still locally unexpired, the first render can temporarily observe that persisted session.

The protected FinanceFlow API remains authoritative. A `401 Unauthorized` for the exact current bearer snapshot is wired through the Axios response interceptor to the auth-session invalidation handler. The current session and that owner's local financial cache must then be cleared, which makes `App.tsx` render `LoginScreen`.

For a deterministic clean-room smoke after intentionally resetting Supabase, clear the old FinanceFlow/Expo Go application data before the first launch. Be aware that clearing Expo Go application data can also clear local state for other Expo Go projects on the device.

A stale Supabase user/token is **not** a reason to bypass Login, add an unauthenticated Home route, remove the existing auth gate, or add a second global 401 interceptor.

If the app receives a protected-endpoint 401 and still remains authenticated after the request finishes, capture the Metro log and treat that as a regression.

## 7. Current login-only test flow

The current mobile UI contains sign-in but no end-user registration screen. After a clean Supabase reset, create a disposable test user through the normal Supabase Authentication admin/dashboard flow, then sign in through FinanceFlow.

Do not seed `auth.users` directly with ad-hoc SQL for this smoke test.

After sign-in, verify the normal API path (for example the pending bills/Home load) rather than inserting financial rows directly in the database. This exercises Bearer validation, owner-scoped RLS and the supported application data plane.

## 8. Do not do these things

For local QR/Fast Refresh troubleshooting, do **not**:

- delete `expo-updates`;
- delete EAS `owner`, `projectId` or `updates.url` from `app.json`;
- create a replacement `app.json` disconnected from the EAS project;
- downgrade SDK 57 to make the store version of Expo Go happy;
- put a Supabase `service_role`/secret key in the mobile environment;
- commit `.env.local`;
- treat browser CORS behavior as proof that the native Android transport is broken.

## 9. Production/development-build path

Expo recommends development builds for production-grade projects, especially when custom native dependencies are required. FinanceFlow can move to a committed `expo-dev-client` development-build workflow in a dedicated, reviewed change when that native dependency is intentionally adopted.

Do not make that native dependency/configuration change implicitly as a local troubleshooting workaround.

For the current JavaScript/native-module set, the Android SDK 57 matching Expo Go path above is the minimal clean smoke path because it leaves the reviewed EAS/release configuration untouched.
