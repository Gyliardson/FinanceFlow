const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const compiledRoot = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!compiledRoot) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');

const authResponse = require(path.join(compiledRoot, 'authResponse.js'));
const failures = require(path.join(compiledRoot, 'apiFailure.js'));

function snapshot(userId, generation, accessToken = `access-${userId}-${generation}`) {
  return { userId, generation, accessToken };
}

async function testCurrentSessionSuccessIsConsumable() {
  const current = snapshot('user-a', 1);
  await authResponse.assertCurrentAuthenticatedResponse(
    current,
    (candidate) => candidate.userId === 'user-a' && candidate.generation === 1,
  );
}

async function testSuccessAfterLogoutIsRejectedAndCannotUseOfflineCache() {
  const requestSnapshot = snapshot('user-a', 1);
  let current = requestSnapshot;
  const validator = (candidate) => current !== null
    && candidate.userId === current.userId
    && candidate.generation === current.generation
    && candidate.accessToken === current.accessToken;

  current = null;
  await assert.rejects(
    authResponse.assertCurrentAuthenticatedResponse(requestSnapshot, validator),
    (error) => {
      assert.equal(failures.isStaleAuthSessionFailure(error), true);
      assert.equal(error.code, failures.STALE_AUTH_SESSION_ERROR_CODE);
      assert.equal(failures.canUseOfflineCacheForApiFailure(error), false);
      return true;
    },
  );
}

async function testSuccessAfterAccountReplacementIsRejected() {
  const requestSnapshot = snapshot('user-a', 7);
  const current = snapshot('user-b', 8);
  const validator = (candidate) => candidate.userId === current.userId
    && candidate.generation === current.generation
    && candidate.accessToken === current.accessToken;

  await assert.rejects(
    authResponse.assertCurrentAuthenticatedResponse(requestSnapshot, validator),
    (error) => failures.isStaleAuthSessionFailure(error),
  );
}

async function testSuccessAfterSameOwnerSessionReplacementIsRejected() {
  const requestSnapshot = snapshot('user-a', 10, 'old-token');
  const current = snapshot('user-a', 11, 'new-token');
  const validator = (candidate) => candidate.userId === current.userId
    && candidate.generation === current.generation
    && candidate.accessToken === current.accessToken;

  await assert.rejects(
    authResponse.assertCurrentAuthenticatedResponse(requestSnapshot, validator),
    (error) => failures.isStaleAuthSessionFailure(error),
  );
}

async function testAxiosSuccessInterceptorBindsFreshnessGuard() {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src', 'services', 'api.ts'),
    'utf8',
  );
  assert.match(source, /financeflowSessionSnapshot/);
  assert.match(
    source,
    /await assertCurrentAuthenticatedResponse\(snapshot, authSessionSnapshotValidator\)/,
    'axios success interceptor must validate the exact request snapshot before returning response data',
  );
}

async function main() {
  const tests = [
    testCurrentSessionSuccessIsConsumable,
    testSuccessAfterLogoutIsRejectedAndCannotUseOfflineCache,
    testSuccessAfterAccountReplacementIsRejected,
    testSuccessAfterSameOwnerSessionReplacementIsRejected,
    testAxiosSuccessInterceptorBindsFreshnessGuard,
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
