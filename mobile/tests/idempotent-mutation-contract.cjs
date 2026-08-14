'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!buildDir) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');
const AsyncStorage = require(path.join(
  buildDir,
  'node_modules/@react-native-async-storage/async-storage/index.js',
));
const SecureStore = require(path.join(buildDir, 'node_modules/expo-secure-store/index.js'));
const modulePath = path.join(buildDir, 'idempotentMutation.js');
const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';

const INTENT_INCOME_X = 'fi_income_midnight_000001';
const INTENT_INCOME_Y = 'fi_income_midnight_000002';
const INTENT_BILL_X = 'fi_bill_network_00000001';
const INTENT_BILL_Y = 'fi_bill_network_00000002';
const INTENT_RESERVE_A = 'fi_reserve_owner_a_000001';
const INTENT_RESERVE_B = 'fi_reserve_owner_b_000001';
const INTENT_RECURRING = 'fi_recurring_rent_000001';

const reloadModule = () => {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};

const resetStorage = () => {
  AsyncStorage.__reset();
  SecureStore.__reset();
};

async function proveLegacyPayloadIdentityAliasesNewExplicitIntent() {
  const legacyByPayload = new Map();
  const payload = { title: 'Salary', amount: 5000, date: '2026-08-14', type: 'salary' };
  const fingerprint = JSON.stringify(payload);
  const firstKey = 'legacy-key-x';
  legacyByPayload.set(fingerprint, firstKey);
  const secondExplicitUserActionWouldReceive = legacyByPayload.get(fingerprint) || 'legacy-key-y';
  assert.equal(
    secondExplicitUserActionWouldReceive,
    firstKey,
    'control must reproduce the flaw: payload equality aliases a new explicit user action to the old intent',
  );
}

async function proveLegacyDifferentPendingRmwLosesOneEntry() {
  let persisted = [];
  let readers = 0;
  let releaseReaders;
  const allReadersReached = new Promise((resolve) => { releaseReaders = resolve; });

  const legacyCreate = async (record) => {
    const snapshot = [...persisted];
    readers += 1;
    if (readers === 2) releaseReaders();
    await allReadersReached;
    persisted = [...snapshot, record];
  };

  await Promise.all([
    legacyCreate({ intentId: 'x', key: 'legacy-x' }),
    legacyCreate({ intentId: 'y', key: 'legacy-y' }),
  ]);
  assert.equal(
    persisted.length,
    1,
    'control must reproduce the historical last-writer-wins pending-store race',
  );
}

async function testExplicitIntentIdNotPayloadDefinesIdentity() {
  resetStorage();
  const mutations = reloadModule();
  await proveLegacyPayloadIdentityAliasesNewExplicitIntent();

  const identicalPayload = {
    title: 'Salary',
    amount: 5000,
    date: '2026-08-14',
    description: null,
    type: 'salary',
    is_recurring: false,
  };

  const first = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    INTENT_INCOME_X,
    identicalPayload,
  );
  const secondExplicitIntent = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    INTENT_INCOME_Y,
    identicalPayload,
  );

  assert.notEqual(first.intentId, secondExplicitIntent.intentId);
  assert.notEqual(
    first.key,
    secondExplicitIntent.key,
    'same owner/operation/payload with a NEW explicit intent id must receive a NEW idempotency key',
  );

  const pending = await mutations.listPendingOperationsForOwner(OWNER_A);
  assert.equal(pending.filter((item) => item.operation === 'income_create').length, 2);
}

async function testMidnightRetryReplaysOriginalExplicitIncomeIntent() {
  resetStorage();
  let mutations = reloadModule();

  const beforeMidnight = {
    title: 'Salary',
    amount: 5000,
    date: '2026-08-14',
    description: null,
    type: 'salary',
    is_recurring: false,
  };
  const afterMidnightCandidate = { ...beforeMidnight, date: '2026-08-15' };

  assert.notEqual(
    mutations.canonicalMutationPayload(beforeMidnight),
    mutations.canonicalMutationPayload(afterMidnightCandidate),
    'control: a transport payload rebuilt after midnight is different',
  );

  const first = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    INTENT_INCOME_X,
    beforeMidnight,
  );
  assert.equal(first.originalPayload.date, '2026-08-14');

  // App/module restart after an indeterminate first request.
  mutations = reloadModule();
  const afterRestartAndMidnight = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    INTENT_INCOME_X,
    afterMidnightCandidate,
  );
  assert.equal(afterRestartAndMidnight.key, first.key);
  assert.equal(afterRestartAndMidnight.intentId, INTENT_INCOME_X);
  assert.equal(
    afterRestartAndMidnight.originalPayload.date,
    '2026-08-14',
    'same explicit intent must replay its originally persisted financial date',
  );

  const authoritativeByKey = new Map();
  const sent = [];
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'income_create',
      INTENT_INCOME_X,
      beforeMidnight,
      async (key, originalPayload) => {
        sent.push({ key, payload: originalPayload });
        authoritativeByKey.set(key, authoritativeByKey.get(key) || { ...originalPayload });
        const error = new Error('response lost after commit');
        error.request = {};
        throw error;
      },
    ),
  );

  mutations = reloadModule();
  await mutations.runIdempotentMutation(
    OWNER_A,
    'income_create',
    INTENT_INCOME_X,
    afterMidnightCandidate,
    async (key, originalPayload) => {
      sent.push({ key, payload: originalPayload });
      authoritativeByKey.set(key, authoritativeByKey.get(key) || { ...originalPayload });
      return { status: 200 };
    },
  );

  assert.equal(sent[0].key, sent[1].key);
  assert.equal(sent[1].payload.date, '2026-08-14');
  assert.equal(authoritativeByKey.size, 1, 'one explicit logical intent must yield one authoritative effect');
}

async function testDifferentConcurrentExplicitIntentsBothSurvive() {
  resetStorage();
  const mutations = reloadModule();
  await proveLegacyDifferentPendingRmwLosesOneEntry();

  const payloadX = { title: 'Salary', amount: 100, date: '2026-08-14', type: 'salary' };
  const payloadY = { title: 'Freelance', amount: 200, date: '2026-08-14', type: 'extra' };
  const [pendingX, pendingY] = await Promise.all([
    mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_INCOME_X, payloadX),
    mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', INTENT_INCOME_Y, payloadY),
  ]);

  assert.notEqual(pendingX.key, pendingY.key);
  const persisted = await mutations.listPendingOperationsForOwner(OWNER_A);
  const incomeIntentIds = persisted
    .filter((item) => item.operation === 'income_create')
    .map((item) => item.intentId)
    .sort();
  assert.deepEqual(incomeIntentIds, [INTENT_INCOME_X, INTENT_INCOME_Y].sort());
}

async function testRestartOwnerIsolationAndSecurePersistence() {
  resetStorage();
  let mutations = reloadModule();
  const payload = { amount: 10, note: 'same values can be separate intents' };
  const first = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'reserve_add',
    INTENT_RESERVE_A,
    payload,
  );
  assert.ok(first.key.startsWith('ff_'));

  mutations = reloadModule();
  const afterRestart = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'reserve_add',
    INTENT_RESERVE_A,
    { ...payload, amount: 999 },
  );
  assert.equal(afterRestart.key, first.key);
  assert.deepEqual(afterRestart.originalPayload, payload, 'restart replays original payload for the same explicit intent');

  const otherOwner = await mutations.getOrCreatePendingOperation(
    OWNER_B,
    'reserve_add',
    INTENT_RESERVE_B,
    payload,
  );
  assert.notEqual(otherOwner.key, first.key);
  assert.equal(
    await AsyncStorage.getItem(`@financeflow:idempotency:${encodeURIComponent(OWNER_A)}:reserve_add`),
    null,
  );
  assert.ok(
    await SecureStore.getItemAsync(mutations.pendingMutationStorageKey(OWNER_A, 'reserve_add')),
    'pending financial state must be stored in encrypted owner-scoped storage',
  );
}

async function testNetworkAuthAndDefinitiveRejectionLifecycle() {
  resetStorage();
  let mutations = reloadModule();
  const payload = { description: 'Internet', amount: 123.45, due_date: '2026-09-10' };
  const transportKeys = [];

  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'bill_create',
      INTENT_BILL_X,
      payload,
      async (key) => {
        transportKeys.push(key);
        const error = new Error('connection reset after possible commit');
        error.request = {};
        throw error;
      },
    ),
  );

  mutations = reloadModule();
  await mutations.runIdempotentMutation(
    OWNER_A,
    'bill_create',
    INTENT_BILL_X,
    { ...payload, due_date: '2026-09-11' },
    async (key, originalPayload) => {
      transportKeys.push(key);
      assert.equal(originalPayload.due_date, '2026-09-10');
      return { status: 200 };
    },
  );
  assert.equal(transportKeys[1], transportKeys[0]);

  const newExplicitIntent = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'bill_create',
    INTENT_BILL_Y,
    payload,
  );
  assert.notEqual(newExplicitIntent.key, transportKeys[0]);

  const authIntent = 'fi_bill_auth_retry_000001';
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'bill_create',
      authIntent,
      payload,
      async () => {
        const error = new Error('session expired');
        error.response = { status: 401 };
        throw error;
      },
    ),
  );
  assert.equal(
    (await mutations.getOrCreatePendingOperation(OWNER_A, 'bill_create', authIntent, payload)).intentId,
    authIntent,
    '401 must retain an ambiguous explicit intent for later same-owner reconciliation',
  );

  const definitiveKeys = [];
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'recurring_template_create',
      INTENT_RECURRING,
      { title: 'Rent', amount: 900, frequency: 'monthly', recurring_day: 5 },
      async (key) => {
        definitiveKeys.push(key);
        const error = new Error('validation rejected');
        error.response = { status: 422 };
        throw error;
      },
    ),
  );
  const replacementIntent = 'fi_recurring_rent_000002';
  const afterDefinitiveRejection = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'recurring_template_create',
    replacementIntent,
    { title: 'Rent', amount: 900, frequency: 'monthly', recurring_day: 5 },
  );
  assert.notEqual(afterDefinitiveRejection.key, definitiveKeys[0]);
}

async function testAccountSwitchDuringPreparationFailsClosed() {
  resetStorage();
  const mutations = reloadModule();
  const snapshotA = { userId: OWNER_A, accessToken: 'token-a', generation: 10 };
  const snapshotB = { userId: OWNER_B, accessToken: 'token-b', generation: 11 };
  let currentSnapshot = snapshotA;
  const payload = { amount: 77 };

  await assert.rejects(
    mutations.preparePendingMutation(
      snapshotA,
      'reserve_add',
      INTENT_RESERVE_A,
      payload,
      () => {
        currentSnapshot = snapshotB;
        return currentSnapshot.generation === snapshotA.generation;
      },
    ),
    /session changed/i,
  );

  const pendingA = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'reserve_add',
    INTENT_RESERVE_A,
    payload,
  );
  const preparedB = await mutations.preparePendingMutation(
    snapshotB,
    'reserve_add',
    INTENT_RESERVE_B,
    payload,
    (snapshot) => (
      snapshot.userId === currentSnapshot.userId
      && snapshot.accessToken === currentSnapshot.accessToken
      && snapshot.generation === currentSnapshot.generation
    ),
  );

  assert.equal(preparedB.ownerId, OWNER_B);
  assert.equal(preparedB.accessToken, 'token-b');
  assert.notEqual(preparedB.key, pendingA.key);
}

async function testSecureV2MigrationPreservesAmbiguousLegacyIntent() {
  resetStorage();
  let mutations = reloadModule();
  const ownerToken = encodeURIComponent(OWNER_A);
  const v2Key = `@financeflow:idempotency-secure:v2:${ownerToken}:income_create`;
  const originalPayload = { title: 'Legacy salary', amount: 321, date: '2026-08-14', type: 'salary' };
  const legacyRecord = {
    key: 'ff_legacy_operation_123',
    originalPayload,
    canonicalPayload: mutations.canonicalMutationPayload(originalPayload),
    logicalFingerprint: mutations.canonicalMutationPayload({ title: 'Legacy salary', amount: 321, type: 'salary' }),
    createdAt: Date.now(),
    state: 'pending',
  };
  await SecureStore.setItemAsync(v2Key, JSON.stringify([legacyRecord]));

  const migrated = await mutations.listPendingOperationsForOwner(OWNER_A);
  assert.equal(migrated.length, 1);
  assert.match(migrated[0].intentId, /^fi_legacy_/);
  assert.equal(migrated[0].key, legacyRecord.key);
  assert.deepEqual(migrated[0].originalPayload, originalPayload);
  assert.equal(await SecureStore.getItemAsync(v2Key), null, 'v2 source must be removed after one-way migration');
  assert.ok(await SecureStore.getItemAsync(mutations.pendingMutationStorageKey(OWNER_A, 'income_create')));

  const syntheticIntentId = migrated[0].intentId;
  mutations = reloadModule();
  const replay = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    syntheticIntentId,
    { ...originalPayload, date: '2026-08-15' },
  );
  assert.equal(replay.key, legacyRecord.key);
  assert.equal(replay.originalPayload.date, '2026-08-14');
}

(async () => {
  await testExplicitIntentIdNotPayloadDefinesIdentity();
  await testMidnightRetryReplaysOriginalExplicitIncomeIntent();
  await testDifferentConcurrentExplicitIntentsBothSurvive();
  await testRestartOwnerIsolationAndSecurePersistence();
  await testNetworkAuthAndDefinitiveRejectionLifecycle();
  await testAccountSwitchDuringPreparationFailsClosed();
  await testSecureV2MigrationPreservesAmbiguousLegacyIntent();
  console.log('EXPLICIT_INTENT_IDENTITY_CONTRACT=pass');
  console.log('IDEMPOTENT_MUTATION_CONTRACT=pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
