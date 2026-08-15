import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const validator = new URL('./validate-release-env.mjs', import.meta.url);
const required = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];

const validEnv = {
  ...process.env,
  EXPO_PUBLIC_API_URL: 'https://api.example.invalid',
  EXPO_PUBLIC_SUPABASE_URL: 'https://example.supabase.co/',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
};

function run(env) {
  return spawnSync(process.execPath, [validator.pathname], {
    env,
    encoding: 'utf8',
  });
}

function expectRejected(name, value, expectedMessage) {
  const env = { ...validEnv, [name]: value };
  const result = run(env);
  if (result.status === 0) {
    throw new Error(`Validator accepted unsafe ${name} test case`);
  }
  if (!result.stderr.includes(expectedMessage)) {
    throw new Error(`Validator rejected ${name} without the expected invariant message`);
  }
  if (value && result.stderr.includes(value)) {
    throw new Error(`Validator leaked configured ${name} value into stderr`);
  }
}

const success = run(validEnv);
if (success.status !== 0) {
  throw new Error(`Valid release environment was rejected: ${success.stderr}`);
}

const customHttps = run({
  ...validEnv,
  EXPO_PUBLIC_API_URL: 'https://finance.example.org:8443/v1/',
  EXPO_PUBLIC_SUPABASE_URL: 'https://auth.example.org/supabase',
});
if (customHttps.status !== 0) {
  throw new Error(`Valid custom HTTPS endpoints were rejected: ${customHttps.stderr}`);
}

for (const name of required) {
  const env = { ...validEnv };
  delete env[name];
  const result = run(env);
  if (result.status === 0) {
    throw new Error(`Validator accepted release environment without ${name}`);
  }
  if (!result.stderr.includes(name)) {
    throw new Error(`Validator did not identify missing ${name}`);
  }
}

for (const name of ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_SUPABASE_URL']) {
  expectRejected(name, 'not-a-url', `${name} must be an absolute HTTPS URL`);
  expectRejected(name, 'http://api.example.org', `${name} must use HTTPS`);
  expectRejected(name, 'https://user:password@api.example.org', `${name} must not contain embedded URL credentials`);
  expectRejected(name, 'https://api.example.org/path?token=value', `${name} must not contain a query string or fragment`);
  expectRejected(name, 'https://api.example.org/path#section', `${name} must not contain a query string or fragment`);

  for (const localUrl of [
    'https://localhost',
    'https://dev.localhost',
    'https://127.0.0.1',
    'https://127.42.0.9',
    'https://0.0.0.0',
    'https://[::1]',
    'https://[::]',
  ]) {
    expectRejected(name, localUrl, `${name} must not target a local or loopback host`);
  }
}

const workflow = readFileSync('../.github/workflows/deploy-frontend.yml', 'utf8');
if (!workflow.includes("eas env:exec production 'node scripts/validate-release-env.mjs' --non-interactive")) {
  throw new Error('Deploy workflow does not validate the EAS production environment before publishing');
}
if (!workflow.includes('eas update --branch production --environment production')) {
  throw new Error('Deploy workflow is not pinned to the EAS production environment');
}
if (workflow.includes('SUPABASE_SERVICE_ROLE_KEY')) {
  throw new Error('Server-only Supabase service-role key must never appear in the mobile deploy workflow');
}

const eas = JSON.parse(readFileSync('./eas.json', 'utf8'));
for (const profile of ['development', 'preview', 'production']) {
  if (eas.build?.[profile]?.environment !== profile) {
    throw new Error(`EAS ${profile} build profile must use the matching named environment`);
  }
}
if (eas.build?.production?.env) {
  throw new Error('Production runtime values must come from the named EAS environment, not committed eas.json env values');
}

console.log('Mobile release environment contract passed.');
