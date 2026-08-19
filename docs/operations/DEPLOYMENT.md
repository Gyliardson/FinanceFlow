# Deployment and release configuration

FinanceFlow keeps production credentials outside the repository. The repository defines the configuration contract; operators provision the actual values in Render, Supabase, and Expo Application Services (EAS).

## Mobile public runtime configuration

The mobile bundle requires these client-visible values:

- `EXPO_PUBLIC_API_URL` — FinanceFlow FastAPI base URL.
- `EXPO_PUBLIC_SUPABASE_URL` — Supabase project URL used by the mobile authentication flow.
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — Supabase publishable client key.

All `EXPO_PUBLIC_*` values are embedded in the client bundle and must be treated as public. They must never contain a Supabase service-role key, external provider key, database password, or other server credential. The release validator rejects obvious server-only Supabase key shapes without printing the configured key.

The two endpoint values are also sensitive *destinations*: the Supabase URL receives sign-in credentials and refresh/logout tokens, while the API URL receives authenticated FinanceFlow bearer requests. A publishable release must therefore use absolute HTTPS URLs with no embedded URL username/password, query string, or fragment, and must not target localhost, loopback, or wildcard-listener addresses. Hostnames are intentionally not pinned to one provider so legitimate custom HTTPS deployments remain supported.

## EAS environments

The `development`, `preview`, and `production` build profiles in `mobile/eas.json` use matching named EAS environments. Configure the three public runtime values in each environment that will actually be built or updated.

For production, configure values in the EAS project environment rather than committing them to `eas.json`. They can be managed from the Expo dashboard or EAS CLI, for example:

```bash
cd mobile

eas env:create --name EXPO_PUBLIC_API_URL --value https://api.example.com --environment production --visibility plaintext
eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://project.supabase.co --environment production --visibility plaintext
eas env:create --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value sb_publishable_... --environment production --visibility plaintext
```

Use real project values only in the operator-controlled EAS environment. Do not commit them merely to make CI pass.

## EAS Update from GitHub Actions

`.github/workflows/deploy-frontend.yml` runs only after mobile changes reach `main`. It requires the repository secret `EXPO_TOKEN` so the GitHub Action can authenticate to EAS.

Before publishing, the workflow executes the release validator inside the EAS `production` environment. The validator fails closed when a required value is missing, the public Supabase key is recognizably server-only, or either endpoint is malformed, non-HTTPS, contains embedded URL credentials/query/fragment data, or targets an obvious local/loopback host. It reports only the variable and violated invariant; it does not print configured values. Publication then uses:

```bash
eas update --branch production --environment production
```

Using the named environment keeps update-time values aligned with production builds.

## Remote builds

The `production` EAS build profile is bound to the EAS `production` environment. A remote build therefore obtains the same public runtime configuration used by production updates.

Before initiating a manual production build, run the same validator against the EAS production environment:

```bash
cd mobile
eas env:exec production 'node scripts/validate-release-env.mjs' --non-interactive
eas build --profile production
```

The repository intentionally does not provision signing credentials, store accounts, or real EAS project values. Those remain operator-managed external state.

For local Android work on Expo SDK 57, follow [MOBILE_LOCAL_ANDROID.md](./MOBILE_LOCAL_ANDROID.md). The supported physical-device development path uses a Development Build; a bare `npx expo start` command is not the complete device setup contract.

## Backend / Render

`render.yaml` describes the backend container and required server-side configuration. In particular:

- `SUPABASE_URL` and the publishable/anon key support authenticated Data API access;
- `SUPABASE_SERVICE_ROLE_KEY` is server-only and must never enter the mobile bundle;
- external AI/OCR provider credentials are server-only;
- `CORS_ALLOWED_ORIGINS` must be explicit in production;
- `/health` is the deployment health-check endpoint.

The production image uses Python 3.12, matching the canonical backend CI and clean-room interpreter baseline. It starts the canonical `runtime:create_app --factory` composition on port 8000 as the configured unprivileged `financeflow` user, not as root. The `Backend container` workflow validates the image/runtime boundary.

## Candidate verification

For a reviewed change targeting `main`, evaluate the applicable repository gates on the **exact candidate SHA**, including:

- FinanceFlow CI;
- Authenticated data plane;
- Backend container;
- Financial idempotency;
- Mobile auth contract;
- Mobile UX contract;
- Mobile Expo health;
- Supply-chain policy;
- secret/dependency evidence.

Historical workflow branch triggers remain whatever the repository currently defines; they are not a development model for new changes and are not modified by documentation-only work.

A green repository gate does not prove that external EAS/Render/Supabase credentials or remote settings are provisioned correctly. Those are operator-managed checks and must be described as such when relevant to a release decision.
