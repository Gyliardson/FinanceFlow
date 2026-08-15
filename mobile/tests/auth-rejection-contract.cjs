const assert = require('node:assert/strict');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!compiledRoot) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const auth = require(path.join(compiledRoot, 'authSession.js'));
const cache = require(path.join(compiledRoot, 'userCache.js'));
const failures = require(path.join(compiledRoot, 'apiFailure.js'));

const SECURE_SESSION_KEY = 'financeflow.auth-session.v2';

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

async function reset() {
  secureStore.__reset();
  global.fetch = undefined;
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  await auth.initializeAuthSession();
}

async function installSession(session) {
  await secureStore.setItemAsync(SECURE_SESSION_KEY, JSON.stringify(session));
  return auth.initializeAuthSession();
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
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_KEY), null);
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
  assert.equal(JSON.parse(await secureStore.getItemAsync(SECURE_SESSION_KEY)).accessToken, 'newer-access-user-a');
  assert.deepEqual(
    await cache.getUserCache('user-a', 'bills'),
    [{ id: 'preserve-for-new-session' }],
  );
}

async function main() {
  const tests = [
    testFailureClassificationDoesNotMaskAuthoritative4xx,
    testCurrentRejectedSnapshotClearsOnlyItsOwnerAndSession,
    testStaleRejectedSnapshotCannotClearNewerSameOwnerLogin,
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
