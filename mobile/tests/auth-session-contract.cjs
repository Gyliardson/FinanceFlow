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

const SECURE_SESSION_MANIFEST_KEY = 'financeflow.auth-session.v3.manifest';
const SECURE_SESSION_PREFIX = 'financeflow.auth-session.v3';
const LEGACY_SECURE_SESSION_KEY = 'financeflow.auth-session.v2';
const LEGACY_SESSION_KEY = '@financeflow:auth-session:v1';
const LEGACY_BILLS = '@bills_cache';
const LEGACY_SETTINGS = '@settings_cache';
const LEGACY_OWNER = '@financeflow:legacy-cache-owner:v1';
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

async function resetStorage() {
  asyncStorage.__reset();
  secureStore.__reset();
  global.fetch = undefined;
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  await auth.initializeAuthSession();
}

async function writeSecureSession(session) {
  const raw = JSON.stringify(session);
  const generation = `gtest${Math.random().toString(36).slice(2, 10)}`;
  const chunks = raw.match(new RegExp(`.{1,${SESSION_CHUNK_SIZE}}`, 'gs')) ?? [];
  for (let index = 0; index < chunks.length; index += 1) {
    await secureStore.setItemAsync(chunkKey(generation, index), chunks[index]);
  }
  await secureStore.setItemAsync(SECURE_SESSION_MANIFEST_KEY, JSON.stringify({
    version: 3,
    generation,
    chunks: chunks.length,
    totalLength: raw.length,
  }));
}

async function readSecureSession() {
  const manifestRaw = await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY);
  if (!manifestRaw) return null;
  const manifest = JSON.parse(manifestRaw);
  const chunks = [];
  for (let index = 0; index < manifest.chunks; index += 1) {
    const value = await secureStore.getItemAsync(chunkKey(manifest.generation, index));
    if (value === null) return null;
    chunks.push(value);
  }
  return JSON.parse(chunks.join(''));
}

async function withFailingSecureStoreSet(failAtCall, task) {
  const original = secureStore.setItemAsync;
  let calls = 0;
  secureStore.setItemAsync = async (...args) => {
    calls += 1;
    if (calls === failAtCall) {
      throw new Error(`synthetic SecureStore write failure at call ${calls}`);
    }
    return original(...args);
  };
  try {
    return await task();
  } finally {
    secureStore.setItemAsync = original;
  }
}

async function assertLegacyFinancialCacheCleared() {
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_SETTINGS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), null);
}

async function testOwnerScopedCacheNeverCrossesUsers() {
  await resetStorage();
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'bill-a' }]);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
  assert.notEqual(cache.secureUserCacheManifestKey('user-a', 'bills'), cache.secureUserCacheManifestKey('user-b', 'bills'));
  assert.throws(() => cache.userCacheKey('   ', 'bills'), /Authenticated user id is required/);
}

async function testLegacySessionAndTaggedFinancialCacheMigrateOnce() {
  await resetStorage();
  const session = makeSession('user-a');
  await asyncStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(session));
  await asyncStorage.multiSet([
    [LEGACY_OWNER, 'user-a'],
    [LEGACY_BILLS, JSON.stringify([{ id: 'legacy-bill-a' }])],
    [LEGACY_SETTINGS, JSON.stringify({ initial_balance: 123 })],
  ]);

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.equal(await asyncStorage.getItem(LEGACY_SESSION_KEY), null);
  assert.equal((await readSecureSession()).user.id, 'user-a');
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'legacy-bill-a' }]);
  assert.deepEqual(await cache.getUserCache('user-a', 'settings'), { initial_balance: 123 });
  await assertLegacyFinancialCacheCleared();
}

async function testLegacySecureV2SessionMigratesOnce() {
  await resetStorage();
  const session = makeSession('user-v2');
  await secureStore.setItemAsync(LEGACY_SECURE_SESSION_KEY, JSON.stringify(session));

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-v2');
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
  assert.equal((await readSecureSession()).user.id, 'user-v2');
}

async function testMismatchedLegacyFinancialCacheFailsClosed() {
  await resetStorage();
  await writeSecureSession(makeSession('user-a'));
  await asyncStorage.multiSet([
    [LEGACY_OWNER, 'user-b'],
    [LEGACY_BILLS, JSON.stringify([{ id: 'bill-b' }])],
  ]);

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  await assertLegacyFinancialCacheCleared();
}

async function testMalformedChunkedSessionFailsClosedWithoutLegacyFallback() {
  await resetStorage();
  await secureStore.setItemAsync(SECURE_SESSION_MANIFEST_KEY, '{not-json');
  await asyncStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify(makeSession('user-a')));
  await cache.setUserCache('user-a', 'bills', [{ id: 'sensitive-a' }]);

  const restored = await auth.initializeAuthSession();
  assert.equal(restored, null);
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY), null);
  assert.equal(await asyncStorage.getItem(LEGACY_SESSION_KEY), null);
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'sensitive-a' }]);
  await assertLegacyFinancialCacheCleared();
}

async function testMissingSecureChunkFailsClosedWithoutLegacyFallback() {
  await resetStorage();
  await writeSecureSession(makeSession('user-a', {
    accessToken: 'a'.repeat(2500),
    refreshToken: 'r'.repeat(2500),
  }));
  const manifest = JSON.parse(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY));
  await secureStore.deleteItemAsync(chunkKey(manifest.generation, 1));
  await secureStore.setItemAsync(LEGACY_SECURE_SESSION_KEY, JSON.stringify(makeSession('legacy-user')));

  const restored = await auth.initializeAuthSession();
  assert.equal(restored, null);
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY), null);
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
}

async function testExpiredSessionInvalidRefreshFailsClosed() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await writeSecureSession(expired);
  await cache.setUserCache('user-a', 'bills', [{ id: 'sensitive-a' }]);
  global.fetch = async () => response(401, { error: 'invalid_grant' });

  const restored = await auth.initializeAuthSession();
  assert.equal(restored, null);
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  await assertLegacyFinancialCacheCleared();
}

async function testTransientRefreshFailurePreservesOfflineOwnerStateWithoutGlobals() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await writeSecureSession(expired);
  await cache.setUserCache('user-a', 'bills', [{ id: 'offline-a' }]);
  global.fetch = async () => { throw new Error('network down'); };

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.equal((await readSecureSession()).user.id, 'user-a');
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'offline-a' }]);
  await assertLegacyFinancialCacheCleared();
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
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
  assert.equal(await asyncStorage.getItem(LEGACY_SESSION_KEY), null);
  await assertLegacyFinancialCacheCleared();
}

async function testLargeSessionPersistsInBoundedSecureChunks() {
  await resetStorage();
  const largeAccessToken = `header.${'a'.repeat(2800)}.signature`;
  const largeRefreshToken = `refresh.${'r'.repeat(2600)}`;
  global.fetch = async () => response(200, tokenPayload('user-large', {
    access_token: largeAccessToken,
    refresh_token: largeRefreshToken,
  }));

  const session = await auth.signInWithPassword('large@example.test', 'secret');
  assert.equal(session.accessToken, largeAccessToken);
  assert.equal(auth.getCurrentAuthSession().refreshToken, largeRefreshToken);
  assert.equal((await readSecureSession()).refreshToken, largeRefreshToken);

  const manifest = JSON.parse(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY));
  assert.ok(manifest.chunks >= 3);
  for (let index = 0; index < manifest.chunks; index += 1) {
    const chunk = await secureStore.getItemAsync(chunkKey(manifest.generation, index));
    assert.ok(chunk.length <= SESSION_CHUNK_SIZE);
  }
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
}

async function testChunkWriteFailureKeepsPreviousMemoryAndDurableSession() {
  await resetStorage();
  global.fetch = async () => response(200, tokenPayload('user-a'));
  await auth.signInWithPassword('a@example.test', 'secret');
  const before = await readSecureSession();

  global.fetch = async () => response(200, tokenPayload('user-b', {
    access_token: 'b'.repeat(2800),
    refresh_token: 'c'.repeat(2600),
  }));

  await assert.rejects(
    withFailingSecureStoreSet(2, () => auth.signInWithPassword('b@example.test', 'secret')),
    /synthetic SecureStore write failure/,
  );
  assert.equal(auth.getCurrentAuthSession().user.id, 'user-a');
  assert.deepEqual(await readSecureSession(), before);
}

async function testManifestWriteFailureKeepsPreviousMemoryAndDurableSession() {
  await resetStorage();
  global.fetch = async () => response(200, tokenPayload('user-a'));
  await auth.signInWithPassword('a@example.test', 'secret');
  const before = await readSecureSession();

  global.fetch = async () => response(200, tokenPayload('user-b', {
    access_token: 'b'.repeat(2800),
    refresh_token: 'c'.repeat(2600),
  }));

  await assert.rejects(
    withFailingSecureStoreSet(4, () => auth.signInWithPassword('b@example.test', 'secret')),
    /synthetic SecureStore write failure/,
  );
  assert.equal(auth.getCurrentAuthSession().user.id, 'user-a');
  assert.deepEqual(await readSecureSession(), before);
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
  await assertLegacyFinancialCacheCleared();
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
  await assertLegacyFinancialCacheCleared();
}

async function testLogoutPurgesOnlyCurrentOwnersFinancialStateAndSession() {
  await resetStorage();
  await writeSecureSession(makeSession('user-a'));
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);
  await auth.initializeAuthSession();
  global.fetch = async () => response(204);

  await auth.signOutAuthSession();
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_MANIFEST_KEY), null);
  assert.equal(await secureStore.getItemAsync(LEGACY_SECURE_SESSION_KEY), null);
  assert.equal(await asyncStorage.getItem(LEGACY_SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
  await assertLegacyFinancialCacheCleared();
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
  assert.equal(await cache.getUserCache('user-b', 'bills'), null);
  await assertLegacyFinancialCacheCleared();
}

async function main() {
  const tests = [
    testOwnerScopedCacheNeverCrossesUsers,
    testLegacySessionAndTaggedFinancialCacheMigrateOnce,
    testLegacySecureV2SessionMigratesOnce,
    testMismatchedLegacyFinancialCacheFailsClosed,
    testMalformedChunkedSessionFailsClosedWithoutLegacyFallback,
    testMissingSecureChunkFailsClosedWithoutLegacyFallback,
    testExpiredSessionInvalidRefreshFailsClosed,
    testTransientRefreshFailurePreservesOfflineOwnerStateWithoutGlobals,
    testSuccessfulRefreshRotatesTokensOnlyInSecureStore,
    testLargeSessionPersistsInBoundedSecureChunks,
    testChunkWriteFailureKeepsPreviousMemoryAndDurableSession,
    testManifestWriteFailureKeepsPreviousMemoryAndDurableSession,
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
