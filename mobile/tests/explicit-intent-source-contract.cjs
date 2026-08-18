'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const api = read('src/services/api.ts');
const store = read('src/services/idempotentMutation.ts');
const hook = read('src/services/useFinancialMutation.ts');
const authContext = read('src/services/AuthContext.tsx');
const screens = [
  ['DetailScreen', read('src/screens/DetailScreen.tsx'), '/add-bill'],
  ['IncomeScreen', read('src/screens/IncomeScreen.tsx'), '/incomes'],
  ['InsightsScreen', read('src/screens/InsightsScreen.tsx'), '/insights/reserve'],
  ['RecurringBillScreen', read('src/screens/RecurringBillScreen.tsx'), '/recurring-bills'],
];

for (const [name, source, route] of screens) {
  assert.match(source, /useFinancialMutation/, `${name} must use the explicit financial-intent hook`);
  assert.ok(source.includes(`useFinancialMutation('${route}')`), `${name} must bind ${route}`);
  assert.equal(source.includes(`api.post('${route}'`), false, `${name} must not bypass explicit-intent transport`);
}

assert.match(api, /financeflowIntentId\?: string/);
assert.match(api, /financeflowSessionSnapshot\?: MutationSessionSnapshot/);
assert.match(api, /Explicit logical intent identity is required for financial mutations/);
assert.match(api, /preparePendingMutation\(\s*snapshot,\s*operation,\s*intentId,/);
assert.match(api, /listPendingOperationsForOwner\(snapshot\.userId\)/);
assert.match(
  api,
  /operation\.originalPayload,\s*operation\.intentId,\s*\{ financeflowSessionSnapshot: snapshot \}/,
  'foreground/restart replay must stay pinned to the same session snapshot that enumerated the owner records',
);

assert.match(store, /pending\.find\(\(item\) => item\.intentId === intentId\)/);
assert.doesNotMatch(store, /pending\.find\(\(item\) => item\.logicalFingerprint/);
assert.doesNotMatch(store, /logicalMutationPayload\s*=/);
assert.match(store, /@financeflow:idempotency-secure:v3:/);
assert.match(store, /@financeflow:idempotency-secure:v2:/);
assert.match(store, /Authenticated session changed before preparing a financial mutation/);

assert.match(hook, /intentIdRef\.current \?\? createFinancialIntentId\(\)/);
assert.match(hook, /hasActiveIntent/);
assert.match(hook, /startNewIntent/);

assert.match(authContext, /AppState\.addEventListener\('change'/);
assert.match(authContext, /state === 'active'/);
assert.match(authContext, /reconcilePendingFinancialMutations\(\)/);

console.log('EXPLICIT_INTENT_SOURCE_CONTRACT=pass');
