'use strict';

const assert = require('assert');
const path = require('path');

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

const reloadModule = () => {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};

const resetStorage = () => {
  AsyncStorage.__reset();
  SecureStore.__reset();
};

async function proveLegacyDifferentPayloadRmwLosesOneEntry() {
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
    legacyCreate({ key: 'legacy-x' }),
    legacyCreate({ key: 'legacy-y' }),
  ]);
  assert.equal(
    persisted.length,
    1,
    'control case must reproduce the historical last-writer-wins pending-store race',
  );
}

async function testMidnightRetryReplaysOriginalIncomeIntent() {
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
  const afterMidnight = { ...beforeMidnight, date: '2026-08-15' };

  assert.notEqual(
    mutations.canonicalMutationPayload(beforeMidnight),
    mutations.canonicalMutationPayload(afterMidnight),
    'control: the historical payload-equality identity would treat midnight retry as different',
  );

  const first = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    beforeMidnight,
  );
  assert.equal(first.originalPayload.date, '2026-08-14');

  // App/module restart after the ambiguous first request.
  mutations = reloadModule();
  const afterRestartAndMidnight = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'income_create',
    afterMidnight,
  );
  assert.equal(afterRestartAndMidnight.key, first.key);
  assert.equal(
    afterRestartAndMidnight.originalPayload.date,
    '2026-08-14',
    'retry must replay the originally persisted financial date',
  );

  const authoritativeByKey = new Map();
  const sent = [];
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'income_create',
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
    afterMidnight,
    async (key, originalPayload) => {
      sent.push({ key, payload: originalPayload });
      authoritativeByKey.set(key, authoritativeByKey.get(key) || { ...originalPayload });
      return { status: 200 };
    },
  );

  assert.equal(sent[0].key, sent[1].key, 'midnight retry must reuse one idempotency key');
  assert.equal(sent[1].payload.date, '2026-08-14', 'transport retry must preserve original payload');
  assert.equal(authoritativeByKey.size, 1, 'one logical income intent must yield one authoritative row');
}

async function testDifferentConcurrentPendingOperationsBothSurvive() {
  resetStorage();
  const mutations = reloadModule();
  await proveLegacyDifferentPayloadRmwLosesOneEntry();

  const trace = [];
  const originalGet = SecureStore.getItemAsync;
  const originalSet = SecureStore.setItemAsync;
  SecureStore.getItemAsync = async (key) => {
    trace.push('get');
    return originalGet.call(SecureStore, key);
  };
  SecureStore.setItemAsync = async (key, value) => {
    trace.push('set');
    return originalSet.call(SecureStore, key, value);
  };

  try {
    const payloadX = { title: 'Salary', amount: 100, date: '2026-08-14', type: 'salary' };
    const payloadY = { title: 'Freelance', amount: 200, date: '2026-08-14', type: 'extra' };
    const [pendingX, pendingY] = await Promise.all([
      mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', payloadX),
      mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', payloadY),
    ]);

    assert.notEqual(pendingX.key, pendingY.key);
    assert.deepEqual(
      trace.slice(0, 4),
      ['get', 'set', 'get', 'set'],
      'owner+operation store mutation must serialize read/write pairs instead of get/get/set/set',
    );

    const reloaded = reloadModule();
    assert.equal(
      (await reloaded.getOrCreatePendingOperation(OWNER_A, 'income_create', payloadX)).key,
      pendingX.key,
    );
    assert.equal(
      (await reloaded.getOrCreatePendingOperation(OWNER_A, 'income_create', payloadY)).key,
      pendingY.key,
    );
  } finally {
    SecureStore.getItemAsync = originalGet;
    SecureStore.setItemAsync = originalSet;
  }
}

async function testRestartOwnerIsolationAndSecurePersistence() {
  resetStorage();
  let mutations = reloadModule();
  const payload = { amount: 10, note: 'same logical intent' };
  const first = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', payload);
  assert.ok(first.key.startsWith('ff_'));

  const sameBeforeRestart = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'reserve_add',
    { note: 'same logical intent', amount: 10 },
  );
  assert.equal(sameBeforeRestart.key, first.key);

  mutations = reloadModule();
  const afterRestart = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', payload);
  assert.equal(afterRestart.key, first.key, 'unresolved intent must retain its identity after restart');

  const otherOwner = await mutations.getOrCreatePendingOperation(OWNER_B, 'reserve_add', payload);
  assert.notEqual(otherOwner.key, first.key, 'owners must never share pending operation identities');
  assert.equal(
    await AsyncStorage.getItem(`@financeflow:idempotency:${encodeURIComponent(OWNER_A)}:reserve_add`),
    null,
    'private pending financial payload must not remain in legacy AsyncStorage',
  );
  assert.ok(
    await SecureStore.getItemAsync(mutations.pendingMutationStorageKey(OWNER_A, 'reserve_add')),
    'pending financial state must be stored in encrypted owner-scoped storage',
  );
}

async function testNetworkRetryAndDefinitiveRejectionLifecycle() {
  resetStorage();
  let mutations = reloadModule();
  const transportKeys = [];
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'bill_create',
      { description: 'Internet', amount: 123.45, due_date: '2026-09-10' },
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
    { amount: 123.45, due_date: '2026-09-10', description: 'Internet' },
    async (key) => {
      transportKeys.push(key);
      return { status: 200 };
    },
  );
  assert.equal(transportKeys[1], transportKeys[0]);

  const newIntent = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'bill_create',
    { description: 'Internet', amount: 123.45, due_date: '2026-09-10' },
  );
  assert.notEqual(newIntent.key, transportKeys[0], 'confirmed completion closes the old intent');

  const definitiveKeys = [];
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'recurring_template_create',
      { title: 'Rent', amount: 900, frequency: 'monthly', recurring_day: 5 },
      async (key) => {
        definitiveKeys.push(key);
        const error = new Error('validation rejected');
        error.response = { status: 422 };
        throw error;
      },
    ),
  );
  const afterDefinitiveRejection = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'recurring_template_create',
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
      payload,
      () => {
        currentSnapshot = snapshotB;
        return currentSnapshot.generation === snapshotA.generation;
      },
    ),
    /session changed/i,
  );

  const pendingA = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', payload);
  const preparedB = await mutations.preparePendingMutation(
    snapshotB,
    'reserve_add',
    payload,
    (snapshot) => (
      snapshot.userId === currentSnapshot.userId
      && snapshot.accessToken === currentSnapshot.accessToken
      && snapshot.generation === currentSnapshot.generation
    ),
  );

  assert.equal(preparedB.ownerId, OWNER_B);
  assert.equal(preparedB.accessToken, 'token-b');
  assert.notEqual(preparedB.key, pendingA.key, 'B must never reuse A pending identity');
  assert.deepEqual(preparedB.originalPayload, payload, 'B prepares only B-owned payload');
}

(async () => {
  await testMidnightRetryReplaysOriginalIncomeIntent();
  await testDifferentConcurrentPendingOperationsBothSurvive();
  await testRestartOwnerIsolationAndSecurePersistence();
  await testNetworkRetryAndDefinitiveRejectionLifecycle();
  await testAccountSwitchDuringPreparationFailsClosed();
  console.log('IDEMPOTENT_MUTATION_CONTRACT=pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
