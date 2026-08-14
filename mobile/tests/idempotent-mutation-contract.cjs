'use strict';

const assert = require('assert');
const path = require('path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!buildDir) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');
const AsyncStorage = require(path.join(
  buildDir,
  'node_modules/@react-native-async-storage/async-storage/index.js',
));
const modulePath = path.join(buildDir, 'idempotentMutation.js');
const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';

const reloadModule = () => {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};

(async () => {
  AsyncStorage.__reset();
  let mutations = reloadModule();

  const payload = { amount: 10, note: 'same logical intent' };
  const first = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', payload);
  assert.ok(first.key.startsWith('ff_'));

  const sameBeforeRestart = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'reserve_add',
    { note: 'same logical intent', amount: 10 },
  );
  assert.strictEqual(sameBeforeRestart.key, first.key, 'mapping order must not create a new intent');

  // Simulate application/module restart while AsyncStorage survives.
  mutations = reloadModule();
  const afterRestart = await mutations.getOrCreatePendingOperation(OWNER_A, 'reserve_add', payload);
  assert.strictEqual(afterRestart.key, first.key, 'unresolved intent must retain its identity after restart');

  const otherOwner = await mutations.getOrCreatePendingOperation(OWNER_B, 'reserve_add', payload);
  assert.notStrictEqual(otherOwner.key, first.key, 'owners must never share pending operation identities');

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
  const unresolvedBill = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'bill_create',
    { amount: 123.45, due_date: '2026-09-10', description: 'Internet' },
  );
  assert.strictEqual(unresolvedBill.key, transportKeys[0], 'network failure must preserve the original key');

  await mutations.runIdempotentMutation(
    OWNER_A,
    'bill_create',
    { description: 'Internet', amount: 123.45, due_date: '2026-09-10' },
    async (key) => {
      transportKeys.push(key);
      return { status: 200 };
    },
  );
  assert.strictEqual(transportKeys[1], transportKeys[0], 'confirmed retry must reuse the ambiguous key');

  const newIntent = await mutations.getOrCreatePendingOperation(
    OWNER_A,
    'bill_create',
    { description: 'Internet', amount: 123.45, due_date: '2026-09-10' },
  );
  assert.notStrictEqual(newIntent.key, transportKeys[0], 'after confirmed success, equal values are a new intent');

  const definitiveKeys = [];
  await assert.rejects(
    mutations.runIdempotentMutation(
      OWNER_A,
      'income_create',
      { title: 'Salary', amount: 1000, date: '2026-08-14' },
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
    'income_create',
    { title: 'Salary', amount: 1000, date: '2026-08-14' },
  );
  assert.notStrictEqual(
    afterDefinitiveRejection.key,
    definitiveKeys[0],
    'definitive client rejection must close the rejected intent',
  );

  console.log('IDEMPOTENT_MUTATION_CONTRACT=pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
