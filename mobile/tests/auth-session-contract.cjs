const assert = require('node:assert/strict');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!compiledRoot) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const asyncStorage = require(path.join(
  compiledRoot,
  'node_modules',
  '@react-native-async-storage',
  'async-storage',
));
const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const auth = require(path.join(compiledRoot, 'authSession.js'));
const cache = require(path.join(compiledRoot, 'userCache.js'));

const SESSION_KEY = '@financeflow:auth-session:v1';
const LEGACY_BILLS = '@bills_cache';
const LEGACY_OWNER = '@financeflow:legacy-cache-owner:v1';

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

async function resetStorage() {
  asyncStorage.__reset();
  secureStore.__reset();
  global.fetch = undefined;
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  await auth.initializeAuthSession();
}

async function writeSecureSession(session) {
  await secureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

async function readSecureSession() {
  const value = await secureStore.getItemAsync(SESSION_KEY);
  return value ? JSON.parse(value) : null;
}

async function testOwnerScopedCacheNeverCrossesUsers() {
  await resetStorage();
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'bill-a' }]);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
  assert.notEqual(cache.userCacheKey('user-a', 'bills'), cache.userCacheKey('user-b', 'bills'));
  assert.throws(() => cache.userCacheKey('   ', 'bills'), /Authenticated user id is required/);
}

async function testLegacySessionMigratesToSecureStoreAndIsDeletedFromAsyncStorage() {
  await resetStorage();
  const session = makeSession('user-a');
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-a');

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.equal(await asyncStorage.getItem(SESSION_KEY), null);
  assert.equal((await readSecureSession()).user.id, 'user-a');
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
}

async function testMalformedSecureSessionFailsClosedWithoutLegacyFallback() {
  await resetStorage();
  await secureStore.setItemAsync(SESSION_KEY, '{not-json');
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(makeSession('user-a')));
  await cache.setUserCache('user-a', 'bills', [{ id: 'sensitive-a' }]);

  const restored = await auth.initializeAuthSession();
  assert.equal(restored, null);
  assert.equal(await secureStore.getItemAsync(SESSION_KEY), null);
  assert.equal(await asyncStorage.getItem(SESSION_KEY), null);
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'sensitive-a' }]);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
}

async function testExpiredSessionInvalidRefreshFailsClosed() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await writeSecureSession(expired);
  await cache.setUserCache('user-a', 'bills', [{ id: 'sensitive-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  global.fetch = async () => response(401, { error: 'invalid_grant' });

  const restored = await auth.initializeAuthSession();
  assert.equal(restored, null);
  assert.equal(await secureStore.getItemAsync(SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), null);
}

async function testTransientRefreshFailurePreservesOfflineOwnerState() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await writeSecureSession(expired);
  await cache.setUserCache('user-a', 'bills', [{ id: 'offline-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  global.fetch = async () => { throw new Error('network down'); };

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.equal((await readSecureSession()).user.id, 'user-a');
  assert.deepEqual(JSON.parse(await asyncStorage.getItem(LEGACY_BILLS)), [{ id: 'offline-a' }]);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
}

async function testSuccessfulRefreshRotatesTokensOnlyInSecureStore() {
  await resetStorage();
  await writeSecureSession(makeSession('user-a', { expiresAt: Date.now() - 1000 }));
  global.fetch = async (url, init) => {
    assert.match(String(url), /grant_type=refresh_token/);
    assert.equal(init.method, 'POST');
    return response(200, tokenPayload('user-a'));
  };

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.accessToken, 'new-access-user-a');
  assert.equal((await readSecureSession()).refreshToken, 'new-refresh-user-a');
  assert.equal(await asyncStorage.getItem(SESSION_KEY), null);
}

async function testConcurrentAccessTokenRefreshIsSingleFlight() {
  await resetStorage();
  global.fetch = async (url) => {
    if (String(url).includes('grant_type=password')) {
      return response(200, tokenPayload('user-concurrent', {
        access_token: 'expiring-access',
        refresh_token: 'shared-refresh',
        expires_in: 0,
      }));
    }
    throw new Error(`Unexpected auth request: ${url}`);
  };
  await auth.signInWithPassword('concurrent@example.test', 'secret');

  let refreshCalls = 0;
  global.fetch = async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return response(200, tokenPayload('user-concurrent', {
      access_token: 'single-flight-access',
      refresh_token: 'rotated-refresh',
    }));
  };

  const tokens = await Promise.all([
    auth.getValidAccessToken(),
    auth.getValidAccessToken(),
    auth.getValidAccessToken(),
  ]);
  assert.deepEqual(tokens, ['single-flight-access', 'single-flight-access', 'single-flight-access']);
  assert.equal(refreshCalls, 1);
  assert.equal((await readSecureSession()).refreshToken, 'rotated-refresh');
}

async function testStaleRefreshFailureCannotClearNewLogin() {
  await resetStorage();
  global.fetch = async (url) => {
    if (String(url).includes('grant_type=password')) {
      return response(200, tokenPayload('user-old', {
        access_token: 'old-expired-access',
        refresh_token: 'old-refresh',
        expires_in: 0,
      }));
    }
    throw new Error(`Unexpected auth request: ${url}`);
  };
  await auth.signInWithPassword('old@example.test', 'secret');

  let releaseOldRefresh;
  let refreshStartedResolve;
  const refreshStarted = new Promise((resolve) => { refreshStartedResolve = resolve; });
  global.fetch = async (url) => {
    if (String(url).includes('grant_type=refresh_token')) {
      refreshStartedResolve();
      return new Promise((resolve) => {
        releaseOldRefresh = () => resolve(response(401, { error: 'invalid_grant' }));
      });
    }
    if (String(url).includes('grant_type=password')) {
      return response(200, tokenPayload('user-new', {
        access_token: 'new-login-access',
        refresh_token: 'new-login-refresh',
      }));
    }
    throw new Error(`Unexpected auth request: ${url}`);
  };

  const staleTokenRequest = auth.getValidAccessToken();
  await refreshStarted;
  await auth.signInWithPassword('new@example.test', 'secret');
  releaseOldRefresh();

  assert.equal(await staleTokenRequest, null);
  assert.equal(auth.getCurrentAuthSession().user.id, 'user-new');
  assert.equal((await readSecureSession()).user.id, 'user-new');
}

async function testLogoutPurgesOnlyCurrentOwnersFinancialStateAndSession() {
  await resetStorage();
  await writeSecureSession(makeSession('user-a'));
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);
  await auth.initializeAuthSession();
  global.fetch = async () => response(204);

  await auth.signOutAuthSession();
  assert.equal(await secureStore.getItemAsync(SESSION_KEY), null);
  assert.equal(await asyncStorage.getItem(SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
}

async function testAccountSwitchDoesNotReusePreviousCache() {
  await resetStorage();
  await writeSecureSession(makeSession('user-a'));
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await auth.initializeAuthSession();

  global.fetch = async (url) => {
    if (String(url).endsWith('/logout')) return response(204);
    return response(200, tokenPayload('user-b'));
  };
  await auth.signOutAuthSession();
  const sessionB = await auth.signInWithPassword('USER-B@example.test', 'secret');

  assert.equal(sessionB.user.id, 'user-b');
  assert.equal((await readSecureSession()).user.id, 'user-b');
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-b');
}

async function main() {
  const tests = [
    testOwnerScopedCacheNeverCrossesUsers,
    testLegacySessionMigratesToSecureStoreAndIsDeletedFromAsyncStorage,
    testMalformedSecureSessionFailsClosedWithoutLegacyFallback,
    testExpiredSessionInvalidRefreshFailsClosed,
    testTransientRefreshFailurePreservesOfflineOwnerState,
    testSuccessfulRefreshRotatesTokensOnlyInSecureStore,
    testConcurrentAccessTokenRefreshIsSingleFlight,
    testStaleRefreshFailureCannotClearNewLogin,
    testLogoutPurgesOnlyCurrentOwnersFinancialStateAndSession,
    testAccountSwitchDoesNotReusePreviousCache,
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
