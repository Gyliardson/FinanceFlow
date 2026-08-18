'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!buildDir) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const SecureStore = require(path.join(buildDir, 'node_modules/expo-secure-store/index.js'));
const AsyncStorage = require(path.join(buildDir, 'node_modules/@react-native-async-storage/async-storage/index.js'));
const apiModule = require(path.join(buildDir, 'api.js'));
const mutations = require(path.join(buildDir, 'idempotentMutation.js'));

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const snapshotA = { userId: OWNER_A, accessToken: 'token-a', generation: 10 };
const snapshotB = { userId: OWNER_B, accessToken: 'token-b', generation: 11 };

const isCurrent = (current, snapshot) => Boolean(
  current
  && current.userId === snapshot.userId
  && current.accessToken === snapshot.accessToken
  && current.generation === snapshot.generation
);

async function accountSwitchQueuesNewOwnerPass() {
  SecureStore.__reset();
  AsyncStorage.__reset();

  const payloadA1 = { title: 'Owner A salary', amount: 100, date: '2026-08-15', type: 'salary' };
  const payloadA2 = { title: 'Owner A bonus', amount: 150, date: '2026-08-15', type: 'extra' };
  const payloadB = { title: 'Owner B salary', amount: 200, date: '2026-08-15', type: 'salary' };
  await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', 'fi_owner_a_queue_000001', payloadA1);
  await mutations.getOrCreatePendingOperation(OWNER_A, 'income_create', 'fi_owner_a_queue_000002', payloadA2);
  await mutations.getOrCreatePendingOperation(OWNER_B, 'income_create', 'fi_owner_b_queue_000001', payloadB);

  let current = snapshotA;
  apiModule.configureApiAuthSessionSnapshotProvider(
    () => current,
    (snapshot) => isCurrent(current, snapshot),
    null,
  );

  let releaseOwnerA;
  const ownerABlocked = new Promise((resolve) => { releaseOwnerA = resolve; });
  let markOwnerAStarted;
  const ownerAStarted = new Promise((resolve) => { markOwnerAStarted = resolve; });
  const attempts = [];
  let activeTransports = 0;
  let maxActiveTransports = 0;

  apiModule.default.defaults.adapter = async (config) => {
    const authorization = config.headers.get('Authorization');
    activeTransports += 1;
    maxActiveTransports = Math.max(maxActiveTransports, activeTransports);
    attempts.push({ authorization, url: config.url });
    try {
      if (authorization === `Bearer ${snapshotA.accessToken}`) {
        markOwnerAStarted();
        await ownerABlocked;
      }
      return {
        data: { ok: true },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
        request: {},
      };
    } finally {
      activeTransports -= 1;
    }
  };

  const replayA = apiModule.reconcilePendingFinancialMutations();
  await ownerAStarted;

  current = snapshotB;
  const replayB = apiModule.reconcilePendingFinancialMutations();
  releaseOwnerA();
  await Promise.all([replayA, replayB]);

  assert.equal(maxActiveTransports, 1, 'reconciliation transports must remain serialized');
  assert.equal(
    attempts.some((attempt) => attempt.authorization === `Bearer ${snapshotB.accessToken}`),
    true,
    'owner B must receive a replay pass even when its trigger arrives during owner A work',
  );
  assert.equal(
    (await mutations.listPendingOperationsForOwner(OWNER_B)).length,
    0,
    'successful owner B replay must clear its pending logical intent',
  );

  // A stale response may complete authoritatively, but the second A logical intent
  // must remain pending because the loop validates the captured snapshot before
  // every transport and stops immediately after the account switch.
  const ownerAAttempts = attempts.filter((attempt) => attempt.authorization === `Bearer ${snapshotA.accessToken}`);
  assert.equal(ownerAAttempts.length, 1, 'stale owner A must not transport its second pending operation');
  assert.equal(
    (await mutations.listPendingOperationsForOwner(OWNER_A)).length,
    1,
    'the unattempted stale-owner intent must remain durable for a future owner A session',
  );

  const beforeRepeatedTrigger = attempts.length;
  await Promise.all([
    apiModule.reconcilePendingFinancialMutations(),
    apiModule.reconcilePendingFinancialMutations(),
  ]);
  assert.equal(maxActiveTransports, 1, 'repeated same-session triggers must not overlap transports');
  assert.equal(
    attempts.length,
    beforeRepeatedTrigger,
    'empty repeated passes must not manufacture duplicate financial transports',
  );

  apiModule.configureApiAuthSessionSnapshotProvider(null, null, null);
}

accountSwitchQueuesNewOwnerPass()
  .then(() => {
    console.log('PENDING_RECONCILIATION_QUEUE_CONTRACT=pass');
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
