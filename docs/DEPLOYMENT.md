# Deployment and release configuration

FinanceFlow keeps production credentials outside the repository. The repository defines the configuration contract; operators provision the actual values in Render, Supabase and Expo Application Services (EAS).

## Mobile public runtime configuration

The mobile bundle requires these client-visible values:

- `EXPO_PUBLIC_API_URL` — FinanceFlow FastAPI base URL.
- `EXPO_PUBLIC_SUPABASE_URL` — Supabase project URL used by the mobile authentication flow.
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase publishable client key.

All `EXPO_PUBLIC_*` values are embedded in the client bundle and must be treated as public. They must never contain a Supabase service-role key, Gemini key, database password or other server credential.

## EAS environments

The `development`, `preview` and `production` build profiles in `mobile/eas.json` use matching named EAS environments. Configure the three public runtime values in each environment that will actually be built or updated.

For production, configure the values in the EAS project environment rather than committing them to `eas.json`. They can be managed from the Expo dashboard or with EAS CLI, for example:

```bash
cd mobile

eas env:create --name EXPO_PUBLIC_API_URL --value https://api.example.com --environment production --visibility plaintext
eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://project.supabase.co --environment production --visibility plaintext
eas env:create --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value sb_publishable_... --environment production --visibility plaintext
```

Use the real project values only in the operator-controlled EAS environment. Do not commit them merely to make CI pass.

## EAS Update from GitHub Actions

`.github/workflows/deploy-frontend.yml` runs only after mobile changes reach `main`. It requires the repository secret `EXPO_TOKEN` so the GitHub Action can authenticate to EAS.

Before publishing, the workflow executes the release validator inside the EAS `production` environment. The validator checks only that the three required public runtime values are present and never prints their values. Publication then uses:

```bash
eas update --branch production --environment production
```

Using the named environment keeps update-time values aligned with production builds.

## Remote builds

The `production` EAS build profile is bound to the EAS `production` environment. A remote build therefore obtains the same public runtime configuration used by production updates.

The repository intentionally does not provision signing credentials, store accounts or real EAS project values. Those remain operator-managed external state.

## Backend / Render

`render.yaml` describes the backend container and required server-side configuration. In particular:

- `SUPABASE_URL` and the publishable/anon key support authenticated Data API access;
- `SUPABASE_SERVICE_ROLE_KEY` is server-only and must never enter the mobile bundle;
- `GEMINI_API_KEY` is server-only;
- `CORS_ALLOWED_ORIGINS` must be explicit in production;
- `/health` is the deployment health-check endpoint.

The production image uses Python 3.12, matching the canonical backend CI and clean-room interpreter baseline. It starts the canonical `runtime:create_app --factory` composition on port 8000 as the dedicated unprivileged `financeflow` user (UID/GID 10001), not as root. The `Backend container` workflow executes the built image to verify the Python 3.12 runtime, inspects the production entrypoint, and asserts the effective non-root identity so these release boundaries cannot silently drift.

## Release verification

Before promoting `portfolio/revamp-2026` to `main`, require the exact-head repository gates to pass, including:

- FinanceFlow CI;
- Mobile auth/cache contract;
- Mobile UX contract;
- Mobile Expo health, including the release-environment contract and export smoke;
- backend container build, Python-runtime parity, entrypoint and non-root checks;
- dependency/secret evidence.

A green repository gate does not prove that external EAS/Render/Supabase credentials are provisioned correctly. The final release report must list those external checks as manual operator steps when they cannot be verified without production access.
