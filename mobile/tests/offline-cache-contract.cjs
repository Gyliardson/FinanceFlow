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
const secureStore = require(path.join(compiledRoot, 'node_modules', 'expo-secure-store'));
const cache = require(path.join(compiledRoot, 'userCache.js'));
const mobileRoot = path.resolve(__dirname, '..');

async function reset() {
  asyncStorage.__reset();
  secureStore.__reset();
}

function secureEntries() {
  return [...secureStore.__store.entries()];
}

async function testVersionedCacheRoundTripHasFreshnessAndNoPlaintext() {
  await reset();
  const before = Date.now();
  await cache.setUserCache('user-a', 'bills', []);

  const snapshot = await cache.getUserCacheSnapshot('user-a', 'bills');
  assert.deepEqual(snapshot.data, []);
  assert.equal(snapshot.version, 1);
  assert.ok(Number.isFinite(snapshot.cachedAt));
  assert.ok(snapshot.cachedAt >= before);
  assert.ok(snapshot.cachedAt <= Date.now());
  assert.equal(await asyncStorage.getItem(cache.userCacheKey('user-a', 'bills')), null);
  assert.ok(await secureStore.getItemAsync(cache.secureUserCacheManifestKey('user-a', 'bills')));
}

async function testLargeCacheIsChunkedBelowSecureStoreLimit() {
  await reset();
  const largeDescription = 'x'.repeat(6000);
  await cache.setUserCache('user-a', 'bills', [{ id: 'large', description: largeDescription }]);
  assert.equal((await cache.getUserCache('user-a', 'bills'))[0].description.length, 6000);

  const entries = secureEntries();
  assert.ok(entries.length >= 5, 'large payload should be split across secure manifest/chunks');
  for (const [key, value] of entries) {
    assert.match(key, /^[A-Za-z0-9._-]+$/, 'every SecureStore key must satisfy Expo native contract');
    assert.ok(value.length <= 2048, 'each SecureStore value must stay within hardened test bound');
  }
}

async function testLegacyRawOwnerCacheMigratesToSecureStoreAndDeletesPlaintext() {
  await reset();
  const key = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(key, JSON.stringify([{ id: 'legacy-a' }]));

  const snapshot = await cache.getUserCacheSnapshot('user-a', 'bills');
  assert.deepEqual(snapshot.data, [{ id: 'legacy-a' }]);
  assert.equal(snapshot.version, 0);
  assert.equal(snapshot.cachedAt, null);
  assert.equal(await asyncStorage.getItem(key), null);
  assert.ok(await secureStore.getItemAsync(cache.secureUserCacheManifestKey('user-a', 'bills')));
}

async function testMalformedLegacyJsonFailsClosedAndIsDiscarded() {
  await reset();
  const key = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(key, '{not-json');

  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await asyncStorage.getItem(key), null);
}

async function testMalformedSecureManifestFailsClosedAndIsDiscarded() {
  await reset();
  const manifestKey = cache.secureUserCacheManifestKey('user-a', 'bills');
  await secureStore.setItemAsync(manifestKey, '{not-json');
  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await secureStore.getItemAsync(manifestKey), null);
}

async function testMissingSecureChunkFailsClosed() {
  await reset();
  await cache.setUserCache('user-a', 'bills', [{ id: 'a', description: 'x'.repeat(3000) }]);
  const manifestKey = cache.secureUserCacheManifestKey('user-a', 'bills');
  const manifest = JSON.parse(await secureStore.getItemAsync(manifestKey));
  const firstChunkKey = `financeflow.cache.v2.user-a.bills.${manifest.generation}.0`;
  await secureStore.deleteItemAsync(firstChunkKey);

  assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  assert.equal(await secureStore.getItemAsync(manifestKey), null);
}

async function testWrongResourcePayloadShapeFailsClosed() {
  await reset();
  const billsKey = cache.userCacheKey('user-a', 'bills');
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
  assert.equal(await secureStore.getItemAsync(cache.secureUserCacheManifestKey('user-a', 'bills')), null);
}

async function testSecureStorageReadFailureFailsClosedWithoutPlaintextFallback() {
  await reset();
  const legacyKey = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(legacyKey, JSON.stringify([{ id: 'must-not-fallback' }]));
  const originalGetItem = secureStore.getItemAsync;
  secureStore.getItemAsync = async () => { throw new Error('secure read failed'); };
  try {
    assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  } finally {
    secureStore.getItemAsync = originalGetItem;
  }
}

async function testBestEffortSecureWriteFailureDoesNotCreatePlaintext() {
  await reset();
  const originalSetItem = secureStore.setItemAsync;
  secureStore.setItemAsync = async () => { throw new Error('secure storage full'); };
  try {
    assert.equal(await cache.trySetUserCache('user-a', 'bills', [{ id: 'fresh-server-bill' }]), false);
  } finally {
    secureStore.setItemAsync = originalSetItem;
  }

  assert.equal(await asyncStorage.getItem(cache.userCacheKey('user-a', 'bills')), null);
  assert.equal(await cache.trySetUserCache('user-a', 'bills', [{ id: 'persisted' }]), true);
  assert.deepEqual(await cache.getUserCache('user-a', 'bills'), [{ id: 'persisted' }]);
}

async function testLegacyMigrationFailureDeletesPlaintextRatherThanKeepingSensitiveCache() {
  await reset();
  const legacyKey = cache.userCacheKey('user-a', 'bills');
  await asyncStorage.setItem(legacyKey, JSON.stringify([{ id: 'legacy-sensitive' }]));
  const originalSetItem = secureStore.setItemAsync;
  secureStore.setItemAsync = async () => { throw new Error('secure write failed'); };
  try {
    assert.equal(await cache.getUserCacheSnapshot('user-a', 'bills'), null);
  } finally {
    secureStore.setItemAsync = originalSetItem;
  }
  assert.equal(await asyncStorage.getItem(legacyKey), null);
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
  assert.match(
    home,
    /const usableOfflineData = billsResult\.hasData && !hasAuthoritativeFailure;/,
    'settings cache cannot substitute for bills cache and authoritative auth failures must fail the dashboard closed',
  );
  assert.match(home, /cachedAt=\{offlineCachedAt\}/, 'offline banner must receive bill-cache freshness');
  assert.match(networkStatus, /Última atualização salva:/, 'known cache freshness must be visible');
  assert.match(networkStatus, /Alterações financeiras exigem conexão\./, 'offline financial writes must remain explicitly unsupported');
}

async function main() {
  const tests = [
    testVersionedCacheRoundTripHasFreshnessAndNoPlaintext,
    testLargeCacheIsChunkedBelowSecureStoreLimit,
    testLegacyRawOwnerCacheMigratesToSecureStoreAndDeletesPlaintext,
    testMalformedLegacyJsonFailsClosedAndIsDiscarded,
    testMalformedSecureManifestFailsClosedAndIsDiscarded,
    testMissingSecureChunkFailsClosed,
    testWrongResourcePayloadShapeFailsClosed,
    testInvalidPayloadCannotBePersisted,
    testSecureStorageReadFailureFailsClosedWithoutPlaintextFallback,
    testBestEffortSecureWriteFailureDoesNotCreatePlaintext,
    testLegacyMigrationFailureDeletesPlaintextRatherThanKeepingSensitiveCache,
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
