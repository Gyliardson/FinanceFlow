const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const mobileRoot = path.resolve(__dirname, '..');

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

async function testWrongResourcePayloadShapeFailsClosed() {
  await reset();
  const billsKey = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(billsKey, JSON.stringify({
    version: 1,
    cachedAt: Date.now(),
    data: { id: 'not-an-array' },
  }));
  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(billsKey), null);

  await asyncStorage.setItem(billsKey, JSON.stringify({ id: 'legacy-object-not-array' }));
  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(billsKey), null);

  const settingsKey = cache.userCacheKey('user-a', 'settings');
  await asyncStorage.setItem(settingsKey, JSON.stringify([]));
  assert.equal(await cache.getUserCacheSnapshot('user-a', 'settings'), null);
  assert.equal(await asyncStorage.getItem(settingsKey), null);
}

async function testInvalidPayloadCannotBePersisted() {
  await reset();
  await assert.rejects(() => cache.setUserCache('user-a', 'bills', { id: 'not-an-array' }));
  assert.equal(await cache.trySetUserCache('user-a', 'bills', { id: 'not-an-array' }), false);
  assert.equal(await asyncStorage.getItem(cache.userCacheKey('user-a', 'bills')), null);
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

async function testDashboardKeepsNetworkReadAuthoritativeAndShowsFreshness() {
  const home = fs.readFileSync(path.join(mobileRoot, 'src/screens/HomeScreen.tsx'), 'utf8');
  const networkStatus = fs.readFileSync(path.join(mobileRoot, 'src/components/NetworkStatus.tsx'), 'utf8');

  assert.match(home, /getUserCacheSnapshot/);
  assert.match(home, /void trySetUserCache\(userId, 'bills', bills\)/);
  assert.match(home, /void trySetUserCache\(userId, 'settings', settings\)/);
  assert.doesNotMatch(home, /await setUserCache\(/, 'cache persistence must not downgrade a successful API read');
  assert.match(home, /const usableOfflineData = billsResult\.hasData;/, 'settings cache cannot substitute for bills cache');
  assert.match(home, /cachedAt=\{offlineCachedAt\}/, 'offline banner must receive bill-cache freshness');
  assert.match(networkStatus, /Última atualização salva:/, 'known cache freshness must be visible');
  assert.match(networkStatus, /Alterações financeiras exigem conexão\./, 'offline financial writes must remain explicitly unsupported');
}

async function main() {
  const tests = [
    testVersionedCacheRoundTripHasFreshness,
    testLegacyRawOwnerCacheRemainsReadableWithUnknownFreshness,
    testMalformedJsonFailsClosedAndIsDiscarded,
    testMalformedEnvelopeFailsClosedAndIsDiscarded,
    testWrongResourcePayloadShapeFailsClosed,
    testInvalidPayloadCannotBePersisted,
    testStorageReadFailureFailsClosed,
    testBestEffortWriteFailureDoesNotThrow,
    testEmptyBillListIsAuthoritativeCacheData,
    testDashboardKeepsNetworkReadAuthoritativeAndShowsFreshness,
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
