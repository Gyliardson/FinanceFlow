'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!compiledRoot) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');
const asyncStorage = require(path.join(compiledRoot, 'node_modules', '@react-native-async-storage', 'async-storage'));
const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const auth = require(path.join(compiledRoot, 'authSession.js'));
const mutations = require(path.join(compiledRoot, 'idempotentMutation.js'));

const SESSION_KEY = '@financeflow:auth-session:v1';
const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const INTENT_A = 'fi_private_income_a_000001';
const INTENT_B = 'fi_private_income_b_000001';

const makeSession = (userId) => ({
  accessToken: `access-${userId}`,
  refreshToken: `refresh-${userId}`,
  expiresAt: Date.now() + 10 * 60_000,
  user: { id: userId, email: `${userId}@example.test` },
});
const tokenPayload = (userId) => ({
  access_token: `new-access-${userId}`,
  refresh_token: `new-refresh-${userId}`,
  expires_in: 3600,
  user: { id: userId, email: `${userId}@example.test` },
});
const response = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  async text() { return payload === undefined ? '' : JSON.stringify(payload); },
});

async function reset() {
  asyncStorage.__reset();
  secureStore.__reset();
  process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.test';
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';
  global.fetch = undefined;
  await auth.initializeAuthSession();
}

async function activateSession(session) {
  await secureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  return auth.initializeAuthSession();
}

async function pendingStateStaysEncryptedAndOwnerIsolated() {
  await reset();
  await activateSession(makeSession(OWNER_A));
  const payload = { title: 'Private salary', amount: 5000, date: '2026-08-14', type: 'salary' };
  const pendingA = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_A, payload);

  global.fetch = async () => response(204);
  await auth.signOutAuthSession();
  assert.equal(auth.getCurrentAuthSession(), null);
  assert.ok(await secureStore.getItemAsync(mutations.pendingMutationStorageKey(OWNER_A, 'income_create')));
  assert.equal(await asyncStorage.getItem(`@financeflow:idempotency:${encodeURIComponent(OWNER_A)}:income_create`), null);

  global.fetch = async () => response(200, tokenPayload(OWNER_B));
  const sessionB = await auth.signInWithPassword('b@example.test', 'secret');
  const snapshotB = await auth.getValidAuthSessionSnapshot();
  assert.equal(sessionB.user.id, OWNER_B);
  assert.equal(snapshotB.userId, OWNER_B);
  assert.equal(snapshotB.accessToken, `new-access-${OWNER_B}`);

  const pendingB = await mutations.getOrCreatePendingOperation(OWNER_B, 'income_create', INTENT_B, payload);
  assert.notEqual(pendingB.key, pendingA.key);
  assert.notEqual(pendingB.intentId, pendingA.intentId);
  const visibleToB = await mutations.listPendingOperationsForOwner(OWNER_B);
  assert.equal(visibleToB.some((item) => item.intentId === INTENT_A), false);

  global.fetch = async () => response(204);
  await auth.signOutAuthSession();
  global.fetch = async () => response(200, tokenPayload(OWNER_A));
  await auth.signInWithPassword('a@example.test', 'secret');
  const restoredA = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_A, { ...payload, date: '2026-08-15' });
  assert.equal(restoredA.key, pendingA.key);
  assert.equal(restoredA.originalPayload.date, '2026-08-14');
}

async function staleSnapshotInvalidAfterSwitch() {
  await reset();
  await activateSession(makeSession(OWNER_A));
  const snapshotA = await auth.getValidAuthSessionSnapshot();
  assert.equal(auth.isAuthSessionSnapshotCurrent(snapshotA), true);

  global.fetch = async () => response(200, tokenPayload(OWNER_B));
  await auth.signInWithPassword('b@example.test', 'secret');
  const snapshotB = await auth.getValidAuthSessionSnapshot();
  assert.equal(auth.isAuthSessionSnapshotCurrent(snapshotA), false);
  assert.equal(auth.isAuthSessionSnapshotCurrent(snapshotB), true);
  assert.equal(snapshotB.userId, OWNER_B);
  assert.notEqual(snapshotB.generation, snapshotA.generation);
}

(async () => {
  await pendingStateStaysEncryptedAndOwnerIsolated();
  console.log('PASS explicit pending logout/account-switch isolation');
  await staleSnapshotInvalidAfterSwitch();
  console.log('PASS coherent session snapshot invalidation');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
