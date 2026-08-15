'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
assert.ok(compiledRoot, 'FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const asyncStorage = require(path.join(compiledRoot, 'node_modules', '@react-native-async-storage', 'async-storage'));
const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const auth = require(path.join(compiledRoot, 'authSession.js'));

const SECURE_SESSION_KEY = 'financeflow.auth-session.v2';
let cleanupCalls = 0;

const makeSession = (userId, overrides = {}) => ({
  accessToken: `access-${userId}`,
  refreshToken: `refresh-${userId}`,
  expiresAt: Date.now() + 10 * 60_000,
  user: { id: userId, email: `${userId}@example.test` },
  ...overrides,
});

const tokenPayload = (userId, overrides = {}) => ({
  access_token: `new-access-${userId}`,
  refresh_token: `new-refresh-${userId}`,
  expires_in: 3600,
  user: { id: userId, email: `${userId}@example.test` },
  ...overrides,
});

const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return payload === undefined ? '' : JSON.stringify(payload); },
});

async function reset() {
  asyncStorage.__reset();
  secureStore.__reset();
  global.fetch = undefined;
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  cleanupCalls = 0;
  auth.configureAuthLocalSessionCleanup(async () => { cleanupCalls += 1; });
  await auth.initializeAuthSession();
  cleanupCalls = 0;
}

async function installSession(session) {
  await secureStore.setItemAsync(SECURE_SESSION_KEY, JSON.stringify(session));
  return auth.initializeAuthSession();
}

async function testUnauthenticatedStartupPurgesOrphanReminders() {
  await reset();
  await auth.initializeAuthSession();
  assert.equal(cleanupCalls, 1, 'unauthenticated startup must request device-local session cleanup');
}

async function testAuthoritativeRejectionPurgesCurrentSessionReminders() {
  await reset();
  await installSession(makeSession('user-a'));
  const snapshot = await auth.getValidAuthSessionSnapshot();
  assert.ok(snapshot);

  assert.equal(await auth.invalidateRejectedAuthSessionSnapshot(snapshot), true);
  assert.equal(cleanupCalls, 1);
  assert.equal(auth.getCurrentAuthSession(), null);
}

async function testStaleRejectionCannotPurgeNewSessionReminders() {
  await reset();
  await installSession(makeSession('user-a'));
  const staleSnapshot = await auth.getValidAuthSessionSnapshot();

  global.fetch = async (url) => {
    assert.match(String(url), /grant_type=password/);
    return response(200, tokenPayload('user-a', {
      access_token: 'newer-access',
      refresh_token: 'newer-refresh',
    }));
  };
  await auth.signInWithPassword('user-a@example.test', 'secret');

  assert.equal(await auth.invalidateRejectedAuthSessionSnapshot(staleSnapshot), false);
  assert.equal(cleanupCalls, 0, 'stale rejection must not run global device cleanup after newer login');
  assert.equal(auth.getCurrentAuthSession().accessToken, 'newer-access');
}

async function testOfflineLogoutStillPurgesReminders() {
  await reset();
  await installSession(makeSession('user-a'));
  global.fetch = async () => { throw new Error('offline'); };

  await auth.signOutAuthSession();
  assert.equal(cleanupCalls, 1);
  assert.equal(auth.getCurrentAuthSession(), null);
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_KEY), null);
}

async function testConcurrentNewLoginPreventsOldLogoutCleanup() {
  await reset();
  await installSession(makeSession('user-old'));

  let releaseLogout;
  let logoutStartedResolve;
  const logoutStarted = new Promise((resolve) => { logoutStartedResolve = resolve; });
  global.fetch = async (url) => {
    if (String(url).endsWith('/logout')) {
      logoutStartedResolve();
      return new Promise((resolve) => { releaseLogout = () => resolve(response(204)); });
    }
    if (String(url).includes('grant_type=password')) {
      return response(200, tokenPayload('user-new', {
        access_token: 'new-user-access',
        refresh_token: 'new-user-refresh',
      }));
    }
    throw new Error(`Unexpected auth request: ${url}`);
  };

  const oldLogout = auth.signOutAuthSession();
  await logoutStarted;
  await auth.signInWithPassword('user-new@example.test', 'secret');
  releaseLogout();
  await oldLogout;

  assert.equal(cleanupCalls, 0, 'old logout must not clear global reminders after a newer account is current');
  assert.equal(auth.getCurrentAuthSession().user.id, 'user-new');
}

async function testCleanupFailureCannotBlockLocalLogout() {
  await reset();
  await installSession(makeSession('user-a'));
  auth.configureAuthLocalSessionCleanup(async () => { throw new Error('synthetic device cleanup failure'); });
  global.fetch = async () => response(204);

  await auth.signOutAuthSession();
  assert.equal(auth.getCurrentAuthSession(), null);
  assert.equal(await secureStore.getItemAsync(SECURE_SESSION_KEY), null);
}

function testAuthProviderWiresNotificationCleanup() {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/AuthContext.tsx'), 'utf8');
  assert.match(source, /import \{ cancelAllNotifications \} from '\.\/NotificationService'/);
  assert.match(source, /configureAuthLocalSessionCleanup\(cleanupSessionNotifications\)/);
  assert.match(source, /cleanupSessionNotifications[\s\S]*cancelAllNotifications\(\)/);
  assert.match(source, /configureAuthLocalSessionCleanup\(null\)/, 'provider teardown must release the callback');
}

async function main() {
  const tests = [
    testUnauthenticatedStartupPurgesOrphanReminders,
    testAuthoritativeRejectionPurgesCurrentSessionReminders,
    testStaleRejectionCannotPurgeNewSessionReminders,
    testOfflineLogoutStillPurgesReminders,
    testConcurrentNewLoginPreventsOldLogoutCleanup,
    testCleanupFailureCannotBlockLocalLogout,
    testAuthProviderWiresNotificationCleanup,
  ];

  for (const test of tests) {
    await test();
    process.stdout.write(`PASS ${test.name}\n`);
  }
  auth.configureAuthLocalSessionCleanup(null);
  console.log('AUTH_NOTIFICATION_ISOLATION_CONTRACT=pass');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
