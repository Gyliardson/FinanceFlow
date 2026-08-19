const assert = require('node:assert/strict');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!compiledRoot) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const auth = require(path.join(compiledRoot, 'authSession.js'));
const cache = require(path.join(compiledRoot, 'userCache.js'));
const failures = require(path.join(compiledRoot, 'apiFailure.js'));
const apiModule = require(path.join(compiledRoot, 'api.js'));
const api = apiModule.default;

const SECURE_SESSION_MANIFEST_KEY = 'financeflow.auth-session.v3.manifest';
const SECURE_SESSION_PREFIX = 'financeflow.auth-session.v3';
const LEGACY_SECURE_SESSION_KEY = 'financeflow.auth-session.v2';
const SESSION_CHUNK_SIZE = 1800;

function makeSession(userId, overrides = {}) {
  return {
    accessToken: `access-${userId}`,
    refreshToken: `refresh-${userId}`,
    expiresAt: Date.now() + 10 * 60_000,
    user: { id: userId, email: `${userId}@example.test` },
    ...overrides,
  };
}

function tokenPayload(userId, overrides = {}) {
  return {
    access_token: `new-access-${userId}`,
    refresh_token: `new-refresh-${userId}`,
    expires_in: 3600,
    user: { id: userId, email: `${userId}@example.test` },
    ...overrides,
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload);
    },
  };
}

function chunkKey(generation, index) {
  return `${SECURE_SESSION_PREFIX}.${generation}.${index}`;
}

async function reset() {
  secureStore.__reset();
  global.fetch = undefined;
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  apiModule.configureApiAuthSessionSnapshotProvider(null, null, null);
  await auth.initializeAuthSession();
}

async function installSession(session) {
  // Exercise the supported one-way v2 migration as a compact setup primitive.
  await secureStore.setItemAsync(LEGACY_SECURE_SESSION_KEY, JSON.stringify(session));
  return auth.initializeAuthSession();
}

async function readSecureSession() {
  const manifestRaw = await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY);
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw);
  const chunks = [];
  for (let index = 0; index < manifest.chunks; index += 1) {
    const chunk = await secureStore.getItemAsync(chunkKey(manifest.generation, index));
    if (chunk === null) return null;
    assert.ok(chunk.length <= SESSION_CHUNK_SIZE);
    chunks.push(chunk);
  }
  return JSON.parse(chunks.join(''));
}

async function testFailureClassificationDoesNotMaskAuthoritative4xx() {
  assert.equal(failures.canUseOfflineCacheForApiFailure(new Error('network down')), true);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 500 } }), true);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 503 } }), true);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 408 } }), true);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 425 } }), true);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 429 } }), true);

  assert.equal(failures.isAuthenticationRejected({ response: { status: 401 } }), true);
  assert.equal(failures.isAuthenticationRejected({ response: { status: 403 } }), false);
  assert.equal(failures.isAuthorizationRejected({ response: { status: 403 } }), true);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 401 } }), false);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 403 } }), false);
  assert.equal(failures.canUseOfflineCacheForApiFailure({ response: { status: 422 } }), false);
}

async function testCurrentRejectedSnapshotClearsOnlyItsOwnerAndSession() {
  await reset();
  await installSession(makeSession('user-a'));
  await cache.setUserCache('user-a', 'bills', [{ id: 'sensitive-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);
  const snapshot = await auth.getValidAuthSessionSnapshot();

  assert.equal(await auth.invalidateRejectedAuthSessionSnapshot(snapshot), true);
  assert.equal(auth.getCurrentAuthSession(), null);
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY), null);
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
}

async function testStaleRejectedSnapshotCannotClearNewerSameOwnerLogin() {
  await reset();
  await installSession(makeSession('user-a'));
  await cache.setUserCache('user-a', 'bills', [{ id: 'preserve-for-new-session' }]);
  const staleSnapshot = await auth.getValidAuthSessionSnapshot();

  global.fetch = async (url) => {
    assert.match(String(url), /grant_type=password/);
    return response(200, tokenPayload('user-a', {
      access_token: 'newer-access-user-a',
      refresh_token: 'newer-refresh-user-a',
    }));
  };
  await auth.signInWithPassword('user-a@example.test', 'secret');

  assert.equal(await auth.invalidateRejectedAuthSessionSnapshot(staleSnapshot), false);
  assert.equal(auth.getCurrentAuthSession().accessToken, 'newer-access-user-a');
  assert.equal((await readSecureSession()).accessToken, 'newer-access-user-a');
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
  assert.deepEqual(
    await cache.getUserCache('user-a', 'bills'),
    [{ id: 'preserve-for-new-session' }],
  );
}

async function testAxios401InvalidatesPersistedSessionThroughConfiguredHandler() {
  await reset();
  await installSession(makeSession('user-a'));
  await cache.setUserCache('user-a', 'bills', [{ id: 'stale-private-bill' }]);
  const expectedSnapshot = await auth.getValidAuthSessionSnapshot();
  const rejectedSnapshots = [];

  apiModule.configureApiAuthSessionSnapshotProvider(
    () => auth.getValidAuthSessionSnapshot(),
    auth.isAuthSessionSnapshotCurrent,
    async (snapshot) => {
      rejectedSnapshots.push(snapshot);
      await auth.invalidateRejectedAuthSessionSnapshot(snapshot);
    },
  );

  const originalAdapter = api.defaults.adapter;
  api.defaults.adapter = async (config) => {
    assert.equal(config.headers.get('Authorization'), `Bearer ${expectedSnapshot.accessToken}`);
    const error = new Error('synthetic protected endpoint 401');
    error.config = config;
    error.response = {
      status: 401,
      data: { detail: 'Unauthorized' },
      headers: {},
      config,
    };
    throw error;
  };

  try {
    await assert.rejects(
      api.get('/bills'),
      /synthetic protected endpoint 401/,
    );
  } finally {
    api.defaults.adapter = originalAdapter;
    apiModule.configureApiAuthSessionSnapshotProvider(null, null, null);
  }

  assert.equal(rejectedSnapshots.length, 1);
  assert.deepEqual(rejectedSnapshots[0], expectedSnapshot);
  assert.equal(auth.getCurrentAuthSession(), null);
  assert.equal(await readSecureSession(), null);
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
}

async function main() {
  const tests = [
    testFailureClassificationDoesNotMaskAuthoritative4xx,
    testCurrentRejectedSnapshotClearsOnlyItsOwnerAndSession,
    testStaleRejectedSnapshotCannotClearNewerSameOwnerLogin,
    testAxios401InvalidatesPersistedSessionThroughConfiguredHandler,
  ];
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
