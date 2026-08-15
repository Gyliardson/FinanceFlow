'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
assert.ok(compiledRoot, 'FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const asyncStorage = require(path.join(compiledRoot, 'node_modules', '@react-native-async-storage', 'async-storage'));
const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const auth = require(path.join(compiledRoot, 'authSession.js'));

const SECURE_SESSION_KEY = 'financeflow.auth-session.v2';

const makeSession = (userId, expiresAt) => ({
  accessToken: `access-${userId}`,
  refreshToken: `refresh-${userId}`,
  expiresAt,
  user: { id: userId, email: `${userId}@example.test` },
});

async function reset() {
  asyncStorage.__reset();
  secureStore.__reset();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  auth.configureAuthLocalSessionCleanup(null);
  await auth.initializeAuthSession();
}

async function withImmediateAuthTimeout(task) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const originalFetch = global.fetch;
  let timeoutDelay = null;
  let abortObserved = false;

  global.setTimeout = (callback, delay) => {
    timeoutDelay = delay;
    queueMicrotask(callback);
    return { synthetic: true };
  };
  global.clearTimeout = () => undefined;
  global.fetch = async (_url, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal, 'auth fetch must receive an AbortSignal');
    const rejectAbort = () => {
      abortObserved = true;
      const error = new Error('synthetic abort');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });

  try {
    const result = await task();
    assert.equal(timeoutDelay, auth.AUTH_REQUEST_TIMEOUT_MS, 'production timeout duration must drive cancellation');
    assert.equal(auth.AUTH_REQUEST_TIMEOUT_MS, 15_000, 'auth timeout contract must remain explicitly bounded');
    assert.equal(abortObserved, true, 'pending auth fetch must actually be aborted');
    return result;
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    global.fetch = originalFetch;
  }
}

async function testPasswordSignInTimeoutIsServiceUnavailable() {
  await reset();
  await assert.rejects(
    () => withImmediateAuthTimeout(() => auth.signInWithPassword('user@example.test', 'secret')),
    /Authentication service is unavailable/,
  );
  assert.equal(auth.getCurrentAuthSession(), null);
}

async function testRefreshTimeoutPreservesExistingSession() {
  await reset();
  const expired = makeSession('user-refresh', Date.now() - 1);
  await secureStore.setItemAsync(SECURE_SESSION_KEY, JSON.stringify(expired));

  const restored = await withImmediateAuthTimeout(() => auth.initializeAuthSession());
  assert.ok(restored, 'transient refresh timeout must preserve the previously valid cached session');
  assert.equal(restored.user.id, 'user-refresh');
  assert.equal(auth.getCurrentAuthSession().user.id, 'user-refresh');
  assert.ok(await secureStore.getItemAsync(SECURE_SESSION_KEY), 'refresh timeout must not delete persisted session');
}

async function testRemoteLogoutTimeoutStillCompletesLocalLogout() {
  await reset();
  const active = makeSession('user-logout', Date.now() + 10 * 60_000);
  await secureStore.setItemAsync(SECURE_SESSION_KEY, JSON.stringify(active));
  await auth.initializeAuthSession();

  let cleanupCalls = 0;
  auth.configureAuthLocalSessionCleanup(async () => { cleanupCalls += 1; });

  await withImmediateAuthTimeout(() => auth.signOutAuthSession());
  assert.equal(auth.getCurrentAuthSession(), null, 'remote timeout must not retain local auth session');
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_KEY), null, 'remote timeout must remove persisted session');
  assert.equal(cleanupCalls, 1, 'remote timeout must still run auth-bound device cleanup');
}

async function main() {
  const tests = [
    testPasswordSignInTimeoutIsServiceUnavailable,
    testRefreshTimeoutPreservesExistingSession,
    testRemoteLogoutTimeoutStillCompletesLocalLogout,
  ];
  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  auth.configureAuthLocalSessionCleanup(null);
  console.log('AUTH_TIMEOUT_CONTRACT=pass');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
