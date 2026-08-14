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
const cache = require(path.join(compiledRoot, 'userCache.js'));

async function reset() {
  asyncStorage.__reset();
}

async function testVersionedCacheRoundTripHasFreshness() {
  await reset();
  const before = Date.now();
  await cache.setUserCache('user-a', 'bills', []);

  const snapshot = await cache.getUserCacheSnapshot('user-a', 'bills');
  assert.deepEqual(snapshot.data, []);
  assert.equal(snapshot.version, 1);
  assert.ok(Number.isFinite(snapshot.cachedAt));
  assert.ok(snapshot.cachedAt >= before);
  assert.ok(snapshot.cachedAt <= Date.now());
}

async function testLegacyRawOwnerCacheRemainsReadableWithUnknownFreshness() {
  await reset();
  const key = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(key, JSON.stringify([{ id: 'legacy-a' }]));

  const snapshot = await cache.getUserCacheSnapshot('user-a', 'bills');
  assert.deepEqual(snapshot.data, [{ id: 'legacy-a' }]);
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.cachedAt, null);
}

async function testMalformedJsonFailsClosedAndIsDiscarded() {
  await reset();
  const key = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(key, '{not-json');

  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(key), null);
}

async function testMalformedEnvelopeFailsClosedAndIsDiscarded() {
  await reset();
  const key = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(key, JSON.stringify({
    version: 1,
    cachedAt: 'not-a-number',
    data: [{ id: 'must-not-be-trusted' }],
  }));

  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(key), null);
}

async function testStorageReadFailureFailsClosed() {
  await reset();
  const originalGetItem = asyncStorage.getItem;
  asyncStorage.getItem = async () => { throw new Error('storage read failed'); };
  try {
    assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  } finally {
    asyncStorage.getItem = originalGetItem;
  }
}

async function testBestEffortWriteFailureDoesNotThrow() {
  await reset();
  const originalSetItem = asyncStorage.setItem;
  asyncStorage.setItem = async () => { throw new Error('storage full'); };
  try {
    assert.equal(await cache.trySetUserCache('user-a', 'bills', [{ id: 'fresh-server-bill' }]), false);
  } finally {
    asyncStorage.setItem = originalSetItem;
  }

  assert.equal(await cache.trySetUserCache('user-a', 'bills', [{ id: 'persisted' }]), true);
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'persisted' }]);
}

async function testEmptyBillListIsAuthoritativeCacheData() {
  await reset();
  await cache.setUserCache('user-a', 'bills', []);
  const snapshot = await cache.getUserCacheSnapshot('user-a', 'bills');
  assert.ok(snapshot);
  assert.deepEqual(snapshot.data, []);
}

async function main() {
  const tests = [
    testVersionedCacheRoundTripHasFreshness,
    testLegacyRawOwnerCacheRemainsReadableWithUnknownFreshness,
    testMalformedJsonFailsClosedAndIsDiscarded,
    testMalformedEnvelopeFailsClosedAndIsDiscarded,
    testStorageReadFailureFailsClosed,
    testBestEffortWriteFailureDoesNotThrow,
    testEmptyBillListIsAuthoritativeCacheData,
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
