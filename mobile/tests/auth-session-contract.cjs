const assert = require('node:assert/strict');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!compiledRoot) {
  throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');
}

const asyncStorage = require(path.join(
  compiledRoot,
  'node_modules',
  '@react-native-async-storage',
  'async-storage',
));
const auth = require(path.join(compiledRoot, 'authSession.js'));
const cache = require(path.join(compiledRoot, 'userCache.js'));

const SESSION_KEY = '@financeflow:auth-session:v1';
const LEGACY_BILLS = '@bills_cache';
const LEGACY_SETTINGS = '@settings_cache';
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
  global.fetch = undefined;
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
}

async function testOwnerScopedCacheNeverCrossesUsers() {
  await resetStorage();
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);

  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'bill-a' }]);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
  assert.notEqual(cache.userCacheKey('user-a', 'bills'), cache.userCacheKey('user-b', 'bills'));
  assert.throws(() => cache.userCacheKey('   ', 'bills'), /Authenticated user id is required/);

  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
  assert.deepEqual(JSON.parse(await asyncStorage.getItem(LEGACY_BILLS)), [{ id: 'bill-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-b');
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-b');
  assert.deepEqual(JSON.parse(await asyncStorage.getItem(LEGACY_BILLS)), [{ id: 'bill-b' }]);
}

async function testRestartMigratesOnlyOwnerTaggedCompatibilityCache() {
  await resetStorage();
  const session = makeSession('user-a');
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  await cache.setUserCache('user-a', 'bills', [{ id: 'legacy-a' }]);
  await cache.setUserCache('user-a', 'settings', { initial_balance: 42 });
  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  await cache.clearUserFinancialCache('user-a');

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'legacy-a' }]);
  assert.deepEqual(await cache.getUserCache('user-a', 'settings'), { initial_balance: 42 });
  assert.equal(await cache.getUserCache('user-b', 'bills'), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
}

async function testUntaggedLegacyCacheFailsClosed() {
  await resetStorage();
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(makeSession('user-a')));
  await asyncStorage.setItem(LEGACY_BILLS, JSON.stringify([{ id: 'unknown-owner' }]));
  await asyncStorage.setItem(LEGACY_SETTINGS, JSON.stringify({ initial_balance: 999 }));

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.equal(await cache.getUserCache('user-a', 'settings'), null);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_SETTINGS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
}

async function testMismatchedLegacyOwnerCannotBeReassigned() {
  await resetStorage();
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  await cache.clearUserFinancialCache('user-a');
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(makeSession('user-b')));

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-b');
  assert.equal(await cache.getUserCache('user-b', 'bills'), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-b');
}

async function testExpiredSessionInvalidRefreshFailsClosed() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(expired));
  await cache.setUserCache('user-a', 'bills', [{ id: 'sensitive-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  global.fetch = async () => response(401, { error: 'invalid_grant' });

  const restored = await auth.initializeAuthSession();
  assert.equal(restored, null);
  assert.equal(await asyncStorage.getItem(SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), null);
}

async function testTransientRefreshFailurePreservesOfflineOwnerState() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(expired));
  await cache.setUserCache('user-a', 'bills', [{ id: 'offline-a' }]);
  await cache.hydrateLegacyFinancialCacheForUser('user-a');
  global.fetch = async () => {
    throw new Error('network down');
  };

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.user.id, 'user-a');
  assert.deepEqual(JSON.parse(await asyncStorage.getItem(LEGACY_BILLS)), [{ id: 'offline-a' }]);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
  assert.notEqual(await asyncStorage.getItem(SESSION_KEY), null);
}

async function testSuccessfulRefreshRotatesTokens() {
  await resetStorage();
  const expired = makeSession('user-a', { expiresAt: Date.now() - 1000 });
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(expired));
  global.fetch = async (url, init) => {
    assert.match(String(url), /grant_type=refresh_token/);
    assert.equal(init.method, 'POST');
    return response(200, tokenPayload('user-a'));
  };

  const restored = await auth.initializeAuthSession();
  assert.equal(restored.accessToken, 'new-access-user-a');
  assert.equal(restored.refreshToken, 'new-refresh-user-a');
  const persisted = JSON.parse(await asyncStorage.getItem(SESSION_KEY));
  assert.equal(persisted.accessToken, 'new-access-user-a');
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
}

async function testLogoutPurgesOnlyAuthenticatedOwnersFinancialStateAndSession() {
  await resetStorage();
  const session = makeSession('user-a');
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(session));
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await cache.setUserCache('user-b', 'bills', [{ id: 'bill-b' }]);
  await auth.initializeAuthSession();
  global.fetch = async (url, init) => {
    assert.match(String(url), /\/logout$/);
    assert.equal(init.headers.Authorization, 'Bearer access-user-a');
    return response(204);
  };

  await auth.signOutAuthSession();
  assert.equal(await asyncStorage.getItem(SESSION_KEY), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
  assert.deepEqual(await cache.getUserCache('user-b', 'bills'), [{ id: 'bill-b' }]);
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), null);
}

async function testAccountSwitchDoesNotReusePreviousLegacyCache() {
  await resetStorage();
  const sessionA = makeSession('user-a');
  await asyncStorage.setItem(SESSION_KEY, JSON.stringify(sessionA));
  await cache.setUserCache('user-a', 'bills', [{ id: 'bill-a' }]);
  await auth.initializeAuthSession();
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-a');
  assert.deepEqual(JSON.parse(await asyncStorage.getItem(LEGACY_BILLS)), [{ id: 'bill-a' }]);

  global.fetch = async (url) => {
    if (String(url).endsWith('/logout')) return response(204);
    return response(200, tokenPayload('user-b'));
  };
  await auth.signOutAuthSession();
  const sessionB = await auth.signInWithPassword('USER-B@example.test', 'secret');
  assert.equal(sessionB.user.id, 'user-b');
  assert.equal(await asyncStorage.getItem(LEGACY_OWNER), 'user-b');
  assert.equal(await asyncStorage.getItem(LEGACY_BILLS), null);
  assert.equal(await cache.getUserCache('user-a', 'bills'), null);
}

async function main() {
  const tests = [
    testOwnerScopedCacheNeverCrossesUsers,
    testRestartMigratesOnlyOwnerTaggedCompatibilityCache,
    testUntaggedLegacyCacheFailsClosed,
    testMismatchedLegacyOwnerCannotBeReassigned,
    testExpiredSessionInvalidRefreshFailsClosed,
    testTransientRefreshFailurePreservesOfflineOwnerState,
    testSuccessfulRefreshRotatesTokens,
    testLogoutPurgesOnlyAuthenticatedOwnersFinancialStateAndSession,
    testAccountSwitchDoesNotReusePreviousLegacyCache,
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
