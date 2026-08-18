'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!buildDir) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');
const AsyncStorage = require(path.join(buildDir, 'node_modules/@react-native-async-storage/async-storage/index.js'));
const SecureStore = require(path.join(buildDir, 'node_modules/expo-secure-store/index.js'));
const modulePath = path.join(buildDir, 'idempotentMutation.js');

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const INTENT_X = 'fi_income_midnight_000001';
const INTENT_Y = 'fi_income_midnight_000002';

const reloadModule = () => {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};
const resetStorage = () => {
  AsyncStorage.__reset();
  SecureStore.__reset();
};

async function proveHistoricalPayloadAlias() {
  const pendingByPayload = new Map();
  const payload = { title: 'Salary', amount: 5000, date: '2026-08-14', type: 'salary' };
  const fingerprint = JSON.stringify(payload);
  pendingByPayload.set(fingerprint, 'old-key');
  assert.equal(
    pendingByPayload.get(fingerprint),
    'old-key',
    'control must reproduce the vulnerable payload-equality alias for a second explicit action',
  );
}

async function proveHistoricalRmwLoss() {
  let persisted = [];
  let readers = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const legacyCreate = async (record) => {
    const snapshot = [...persisted];
    readers += 1;
    if (readers === 2) release();
    await barrier;
    persisted = [...snapshot, record];
  };
  await Promise.all([
    legacyCreate({ intentId: 'old-x' }),
    legacyCreate({ intentId: 'old-y' }),
  ]);
  assert.equal(persisted.length, 1, 'control must reproduce old last-writer-wins pending loss');
}

async function explicitIdentityNotPayload() {
  resetStorage();
  const mutations = reloadModule();
  await proveHistoricalPayloadAlias();
  const payload = {
    title: 'Salary', amount: 5000, date: '2026-08-14', description: null,
    type: 'salary', is_recurring: false,
  };
  const first = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_X, payload);
  const second = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_Y, payload);
  assert.notEqual(first.key, second.key, 'identical payload + new explicit intent must receive a new key');
  const pending = await mutations.listPendingOperationsForOwner(OWNER_A);
  assert.equal(pending.filter((item) => item.operation === 'income_create').length, 2);
}

async function midnightRestartReplaysOriginal() {
  resetStorage();
  let mutations = reloadModule();
  const before = {
    title: 'Salary', amount: 5000, date: '2026-08-14', description: null,
    type: 'salary', is_recurring: false,
  };
  const after = { ...before, date: '2026-08-15' };
  assert.notEqual(mutations.canonicalMutationPayload(before), mutations.canonicalMutationPayload(after));
  const original = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_X, before);

  mutations = reloadModule();
  const restarted = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_X, after);
  assert.equal(restarted.key, original.key);
  assert.equal(restarted.originalPayload.date, '2026-08-14');

  const authoritative = new Map();
  const sent = [];
  await assert.rejects(
    mutations.runIdempotentMutation(OWNER_A, 'income_create', INTENT_X, after, async (key, originalPayload) => {
      sent.push({ key, originalPayload });
      authoritative.set(key, authoritative.get(key) || originalPayload);
      const error = new Error('response lost after commit');
      error.request = {};
      throw error;
    }),
  );
  mutations = reloadModule();
  await mutations.runIdempotentMutation(OWNER_A, 'income_create', INTENT_X, after, async (key, originalPayload) => {
    sent.push({ key, originalPayload });
    authoritative.set(key, authoritative.get(key) || originalPayload);
    return { status: 200 };
  });
  assert.equal(sent[0].key, sent[1].key);
  assert.equal(sent[1].originalPayload.date, '2026-08-14');
  assert.equal(authoritative.size, 1);
}

async function oldAmbiguousIntentSurvivesRestartAndReusesIdentity() {
  resetStorage();
  const realDateNow = Date.now;
  let now = Date.UTC(2026, 0, 1, 12, 0, 0);
  Date.now = () => now;
  try {
    let mutations = reloadModule();
    const intentId = 'fi_income_long_gap_000001';
    const originalPayload = {
      title: 'Long-gap income', amount: 250, date: '2026-01-01', description: null,
      type: 'extra', is_recurring: false,
    };
    const original = await mutations.getOrCreatePendingOperation(
      OWNER_A,
      'income_create',
      intentId,
      originalPayload,
    );

    now += 91 * 24 * 60 * 60 * 1000;
    mutations = reloadModule();
    const pending = await mutations.listPendingOperationsForOwner(OWNER_A);
    const retained = pending.find((item) => item.intentId === intentId);
    assert.ok(retained, 'ambiguous intent must not expire merely because 90 days elapsed');
    assert.equal(retained.key, original.key);
    assert.deepEqual(retained.originalPayload, originalPayload);

    const retry = await mutations.getOrCreatePendingOperation(
      OWNER_A,
      'income_create',
      intentId,
      { ...originalPayload, date: '2026-04-02', amount: 999 },
    );
    assert.equal(retry.key, original.key, 'long-gap retry must reuse the durable transport identity');
    assert.deepEqual(retry.originalPayload, originalPayload, 'long-gap retry must reuse first-submission payload');
  } finally {
    Date.now = realDateNow;
  }
}

async function corruptedPendingStateFailsClosedWithoutDestructiveCleanup() {
  const expectCorruption = async (mutations, operation, manifestKey) => {
    await assert.rejects(
      () => mutations.listPendingOperationsForOwner(OWNER_A),
      (error) => error?.name === 'PendingFinancialStateCorruptionError',
      'corrupted ambiguous state must block owner enumeration instead of becoming an empty set',
    );
    assert.ok(await SecureStore.getItemAsync(manifestKey), 'corruption evidence manifest must not be destructively erased');
    await assert.rejects(
      () => mutations.getOrCreatePendingOperation(
        OWNER_A,
        operation,
        'fi_income_after_corrupt_001',
        { title: 'Unsafe new action', amount: 999, date: '2026-08-15', type: 'extra' },
      ),
      (error) => error?.name === 'PendingFinancialStateCorruptionError',
      'fresh financial intent allocation must fail closed while durable state is unreadable',
    );
  };

  resetStorage();
  let mutations = reloadModule();
  const manifestKey = mutations.pendingMutationStorageKey(OWNER_A, 'income_create');
  await SecureStore.setItemAsync(manifestKey, '{not-json');
  await expectCorruption(mutations, 'income_create', manifestKey);

  resetStorage();
  mutations = reloadModule();
  await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    'fi_income_corrupt_chunk_001',
    { title: 'Committed maybe', amount: 100, date: '2026-08-15', type: 'extra' },
  );
  let manifest = JSON.parse(await SecureStore.getItemAsync(manifestKey));
  const firstChunkKey = `financeflow.idempotency.v5.${OWNER_A}.income_create.${manifest.generation}.0`;
  await SecureStore.deleteItemAsync(firstChunkKey);
  await expectCorruption(mutations, 'income_create', manifestKey);

  resetStorage();
  mutations = reloadModule();
  await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    'fi_income_corrupt_json_0001',
    { title: 'Committed maybe', amount: 100, date: '2026-08-15', type: 'extra' },
  );
  manifest = JSON.parse(await SecureStore.getItemAsync(manifestKey));
  const payloadChunkKey = `financeflow.idempotency.v5.${OWNER_A}.income_create.${manifest.generation}.0`;
  const originalChunk = await SecureStore.getItemAsync(payloadChunkKey);
  assert.ok(originalChunk && originalChunk.length > 2);
  const malformedSameLength = `{${originalChunk.slice(1)}`;
  assert.equal(malformedSameLength.length, originalChunk.length);
  await SecureStore.setItemAsync(payloadChunkKey, malformedSameLength);
  await expectCorruption(mutations, 'income_create', manifestKey);
}

async function concurrentDifferentIntentsSurvive() {
  resetStorage();
  const mutations = reloadModule();
  await proveHistoricalRmwLoss();
  const [left, right] = await Promise.all([
    mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_X, { title: 'A', amount: 100, date: '2026-08-14', type: 'salary' }),
    mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_Y, { title: 'B', amount: 200, date: '2026-08-14', type: 'extra' }),
  ]);
  assert.notEqual(left.key, right.key);
  const ids = (await mutations.listPendingOperationsForOwner(OWNER_A))
    .filter((item) => item.operation === 'income_create')
    .map((item) => item.intentId)
    .sort();
  assert.deepEqual(ids, [INTENT_X, INTENT_Y].sort());
}

async function restartOwnerAndSecureStorage() {
  resetStorage();
  let mutations = reloadModule();
  const intentA = 'fi_reserve_owner_a_000001';
  const intentB = 'fi_reserve_owner_b_000001';
  const first = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', intentA, { amount: 10 });
  mutations = reloadModule();
  const replay = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', intentA, { amount: 999 });
  assert.equal(replay.key, first.key);
  assert.equal(replay.originalPayload.amount, 10);
  const otherOwner = await mutations.getOrCreatePendingOperation(OWNER_B, 'reserve_add', intentB, { amount: 10 });
  assert.notEqual(otherOwner.key, first.key);
  assert.equal(await AsyncStorage.getItem(`@financeflow:idempotency:${encodeURIComponent(OWNER_A)}:reserve_add`), null);
  const secureKey = mutations.pendingMutationStorageKey(OWNER_A, 'reserve_add');
  assert.match(secureKey, /^[A-Za-z0-9._-]+$/);
  assert.ok(await SecureStore.getItemAsync(secureKey));
}

async function rejectionLifecycle() {
  resetStorage();
  let mutations = reloadModule();
  const payload = { description: 'Internet', amount: 123.45, due_date: '2026-09-10' };
  const networkIntent = 'fi_bill_network_00000001';
  let firstKey;
  await assert.rejects(mutations.runIdempotentMutation(OWNER_A, 'bill_create', networkIntent, payload, async (key) => {
    firstKey = key;
    const error = new Error('connection reset');
    error.request = {};
    throw error;
  }));
  mutations = reloadModule();
  await mutations.runIdempotentMutation(OWNER_A, 'bill_create', networkIntent, { ...payload, due_date: '2026-09-11' }, async (key, originalPayload) => {
    assert.equal(key, firstKey);
    assert.equal(originalPayload.due_date, '2026-09-10');
    return { status: 200 };
  });

  const fresh = await mutations.getOrCreatePendingOperation(OWNER_A, 'bill_create', 'fi_bill_network_00000002', payload);
  assert.notEqual(fresh.key, firstKey);

  const authIntent = 'fi_bill_auth_retry_000001';
  await assert.rejects(mutations.runIdempotentMutation(OWNER_A, 'bill_create', authIntent, payload, async () => {
    const error = new Error('session expired');
    error.response = { status: 401 };
    throw error;
  }));
  assert.equal((await mutations.getOrCreatePendingOperation(OWNER_A, 'bill_create', authIntent, payload)).intentId, authIntent);

  const rejectedIntent = 'fi_recurring_rent_000001';
  let rejectedKey;
  await assert.rejects(mutations.runIdempotentMutation(OWNER_A, 'recurring_template_create', rejectedIntent, { title: 'Rent', amount: 900, frequency: 'monthly', recurring_day: 5 }, async (key) => {
    rejectedKey = key;
    const error = new Error('validation rejected');
    error.response = { status: 422 };
    throw error;
  }));
  const replacement = await mutations.getOrCreatePendingOperation(OWNER_A, 'recurring_template_create', 'fi_recurring_rent_000002', { title: 'Rent', amount: 900, frequency: 'monthly', recurring_day: 5 });
  assert.notEqual(replacement.key, rejectedKey);
}

async function accountSwitchPreparationFailsClosed() {
  resetStorage();
  const mutations = reloadModule();
  const snapshotA = { userId: OWNER_A, accessToken: 'token-a', generation: 10 };
  const snapshotB = { userId: OWNER_B, accessToken: 'token-b', generation: 11 };
  let current = snapshotA;
  await assert.rejects(
    mutations.preparePendingMutation(snapshotA, 'reserve_add', 'fi_reserve_owner_a_000001', { amount: 77 }, () => {
      current = snapshotB;
      return false;
    }),
    /session changed/i,
  );
  assert.equal((await mutations.listPendingOperationsForOwner(OWNER_A)).length, 0, 'stale session must fail before pending creation');
  const preparedB = await mutations.preparePendingMutation(snapshotB, 'reserve_add', 'fi_reserve_owner_b_000001', { amount: 77 }, (snapshot) => (
    snapshot.userId === current.userId
    && snapshot.accessToken === current.accessToken
    && snapshot.generation === current.generation
  ));
  assert.equal(preparedB.ownerId, OWNER_B);
  assert.equal(preparedB.accessToken, 'token-b');
}

async function invalidSecureNamespaceIsRejectedAndAsyncV1Migrates() {
  resetStorage();
  let mutations = reloadModule();
  const invalidLegacySecureKey = `@financeflow:idempotency-secure:v2:${encodeURIComponent(OWNER_A)}:income_create`;
  await assert.rejects(
    () => SecureStore.setItemAsync(invalidLegacySecureKey, '[]'),
    /Invalid SecureStore key/,
    'hardened mock must reproduce native key validation',
  );

  const legacyAsyncKey = `@financeflow:idempotency:${encodeURIComponent(OWNER_A)}:income_create`;
  const originalPayload = { title: 'Legacy salary', amount: 321, date: '2026-08-14', type: 'salary' };
  const legacyRecord = {
    key: 'legacy-test-key',
    originalPayload,
    canonicalPayload: mutations.canonicalMutationPayload(originalPayload),
    logicalFingerprint: 'legacy',
    createdAt: Date.now(),
    state: 'pending',
  };
  await AsyncStorage.setItem(legacyAsyncKey, JSON.stringify([legacyRecord]));
  const migrated = await mutations.listPendingOperationsForOwner(OWNER_A);
  assert.equal(migrated.length, 1);
  assert.match(migrated[0].intentId, /^fi_legacy_/);
  assert.equal(migrated[0].key, legacyRecord.key);
  assert.deepEqual(migrated[0].originalPayload, originalPayload);
  assert.equal(await AsyncStorage.getItem(legacyAsyncKey), null);
  assert.ok(await SecureStore.getItemAsync(mutations.pendingMutationStorageKey(OWNER_A, 'income_create')));

  const legacyIntentId = migrated[0].intentId;
  mutations = reloadModule();
  const replay = await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', legacyIntentId, { ...originalPayload, date: '2026-08-15' });
  assert.equal(replay.key, legacyRecord.key);
  assert.equal(replay.originalPayload.date, '2026-08-14');
}

(async () => {
  await explicitIdentityNotPayload();
  await midnightRestartReplaysOriginal();
  await oldAmbiguousIntentSurvivesRestartAndReusesIdentity();
  await corruptedPendingStateFailsClosedWithoutDestructiveCleanup();
  await concurrentDifferentIntentsSurvive();
  await restartOwnerAndSecureStorage();
  await rejectionLifecycle();
  await accountSwitchPreparationFailsClosed();
  await invalidSecureNamespaceIsRejectedAndAsyncV1Migrates();
  console.log('EXPLICIT_INTENT_IDENTITY_CONTRACT=pass');
  console.log('IDEMPOTENT_MUTATION_CONTRACT=pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});