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
const detail = read('src/screens/DetailScreen.tsx');
const income = read('src/screens/IncomeScreen.tsx');
const insights = read('src/screens/InsightsScreen.tsx');
const recurring = read('src/screens/RecurringBillScreen.tsx');

const requireMatch = (source, pattern, message) => assert.match(source, pattern, message);

const screens = [
  ['DetailScreen', detail, '/add-bill'],
  ['IncomeScreen', income, '/incomes'],
  ['InsightsScreen', insights, '/insights/reserve'],
  ['RecurringBillScreen', recurring, '/recurring-bills'],
];

for (const [name, source, route] of screens) {
  requireMatch(source, /useFinancialMutation/, `${name} must use the explicit financial-intent hook`);
  assert.ok(
    source.includes(`useFinancialMutation('${route}')`),
    `${name} must bind the correct non-convergent route to an explicit intent handle`,
  );
  assert.equal(
    source.includes(`api.post('${route}'`),
    false,
    `${name} must not bypass the explicit-intent transport boundary with direct api.post`,
  );
}

requireMatch(
  api,
  /financeflowIntentId\?: string/,
  'financial transport config must carry an explicit client logical-intent id',
);
requireMatch(
  api,
  /if \(!intentId\) \{\s*throw new Error\('Explicit logical intent identity is required for financial mutations\.'/,
  'financial transport must fail closed when the explicit intent id is absent',
);
requireMatch(
  api,
  /preparePendingMutation\(\s*snapshot,\s*operation,\s*intentId,/,
  'pending mutation lookup must be driven by the explicit intent id',
);
requireMatch(
  api,
  /listPendingOperationsForOwner\(snapshot\.userId\)/,
  'restart/foreground reconciliation must enumerate persisted intents for the authenticated owner',
);
requireMatch(
  api,
  /operation\.originalPayload,\s*operation\.intentId/,
  'reconciliation must replay the persisted original payload with the persisted explicit intent id',
);

requireMatch(
  store,
  /pending\.find\(\(item\) => item\.intentId === intentId\)/,
  'pending selection must use explicit intent id equality',
);
assert.doesNotMatch(
  store,
  /pending\.find\(\(item\) => item\.logicalFingerprint/,
  'payload-derived logicalFingerprint must never select the current pending intent',
);
assert.doesNotMatch(
  store,
  /logicalMutationPayload\s*=/,
  'production intent identity must not be reconstructed by stripping/recomputing payload fields',
);
requireMatch(
  store,
  /@financeflow:idempotency-secure:v3:/,
  'explicit pending intents must use the versioned secure owner-scoped store',
);
requireMatch(
  store,
  /@financeflow:idempotency-secure:v2:/,
  'v2 pending records must remain migratable so already-ambiguous intents are not abandoned',
);

requireMatch(hook, /createFinancialIntentId\(\)/, 'the UI hook must allocate explicit intent ids');
requireMatch(hook, /intentIdRef\.current \?\? createFinancialIntentId\(\)/, 'retry in one mounted user intent must reuse its explicit id');
requireMatch(hook, /startNewIntent/, 'the UI must have an explicit boundary for starting a new user intent');

requireMatch(authContext, /AppState\.addEventListener\('change'/, 'foreground lifecycle must trigger pending reconciliation');
requireMatch(authContext, /state === 'active'/, 'only foreground activation should trigger that lifecycle replay');
requireMatch(authContext, /reconcilePendingFinancialMutations\(\)/, 'session restore/sign-in/foreground must reconcile persisted explicit intents');

console.log('EXPLICIT_INTENT_SOURCE_CONTRACT=pass');
