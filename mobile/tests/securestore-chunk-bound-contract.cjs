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
const cache = require(path.join(buildDir, 'userCache.js'));
const mutationModulePath = path.join(buildDir, 'idempotentMutation.js');

const OWNER = '11111111-1111-1111-1111-111111111111';
const CHUNK_SIZE = 1800;
const MAX_CHUNKS = 4096;
const OVERSIZED_TEXT = 'x'.repeat((CHUNK_SIZE * MAX_CHUNKS) + 1);

const reloadMutations = () => {
  delete require.cache[require.resolve(mutationModulePath)];
  return require(mutationModulePath);
};

const resetStorage = () => {
  AsyncStorage.__reset();
  SecureStore.__reset();
};

const sortedSecureKeys = (prefix) => [...SecureStore.__store.keys()]
  .filter((key) => key.startsWith(prefix))
  .sort();

async function cacheOversizeRejectsBeforeCommit() {
  resetStorage();
  await cache.setUserCache(OWNER, 'bills', [{ id: 'previous', description: 'stable' }]);

  const manifestKey = cache.secureUserCacheManifestKey(OWNER, 'bills');
  const prefix = `financeflow.cache.v2.${OWNER}.bills.`;
  const manifestBefore = await SecureStore.getItemAsync(manifestKey);
  const keysBefore = sortedSecureKeys(prefix);

  await assert.rejects(
    () => cache.setUserCache(OWNER, 'bills', [{ id: 'oversized', description: OVERSIZED_TEXT }]),
    /SecureStore protocol limit/i,
    'writer must reject payloads that would create a manifest the reader rejects',
  );

  assert.equal(
    await SecureStore.getItemAsync(manifestKey),
    manifestBefore,
    'oversized cache write must preserve the last committed manifest',
  );
  assert.deepEqual(
    sortedSecureKeys(prefix),
    keysBefore,
    'oversized cache write must not publish orphan chunks',
  );
  assert.deepEqual(
    await cache.getUserCache(OWNER, 'bills'),
    [{ id: 'previous', description: 'stable' }],
    'previous committed cache must remain readable after rejected oversized write',
  );
}

async function pendingOversizeRejectsBeforeCommitAndSurvivesRestart() {
  resetStorage();
  let mutations = reloadMutations();
  const operation = 'income_create';
  const priorIntent = 'fi_chunk_boundary_previous_001';
  const oversizedIntent = 'fi_chunk_boundary_oversized_001';

  const prior = await mutations.getOrCreatePendingOperation(
    OWNER,
    operation,
    priorIntent,
    { title: 'Previous', amount: 10, date: '2026-08-16', type: 'extra' },
  );

  const manifestKey = mutations.pendingMutationStorageKey(OWNER, operation);
  const prefix = `financeflow.idempotency.v5.${OWNER}.${operation}.`;
  const manifestBefore = await SecureStore.getItemAsync(manifestKey);
  const keysBefore = sortedSecureKeys(prefix);

  await assert.rejects(
    () => mutations.getOrCreatePendingOperation(
      OWNER,
      operation,
      oversizedIntent,
      {
        title: 'Oversized',
        description: OVERSIZED_TEXT,
        amount: 11,
        date: '2026-08-16',
        type: 'extra',
      },
    ),
    /SecureStore protocol limit/i,
    'pending-intent writer must reject an unreadable future manifest before commit',
  );

  assert.equal(
    await SecureStore.getItemAsync(manifestKey),
    manifestBefore,
    'oversized pending write must preserve the previous committed manifest',
  );
  assert.deepEqual(
    sortedSecureKeys(prefix),
    keysBefore,
    'oversized pending write must not publish orphan chunks',
  );

  mutations = reloadMutations();
  const pendingAfterRestart = await mutations.listPendingOperationsForOwner(OWNER);
  assert.equal(pendingAfterRestart.length, 1);
  assert.equal(pendingAfterRestart[0].intentId, priorIntent);
  assert.equal(pendingAfterRestart[0].key, prior.key);
  assert.equal(
    pendingAfterRestart.some((item) => item.intentId === oversizedIntent),
    false,
    'failed oversized allocation must not become a durable ambiguous intent',
  );
}

(async () => {
  await cacheOversizeRejectsBeforeCommit();
  await pendingOversizeRejectsBeforeCommitAndSurvivesRestart();
  console.log('SECURESTORE_CHUNK_BOUND_CONTRACT=pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
