'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const app = read('App.tsx');
const status = read('src/components/PendingFinancialStatus.tsx');
const navigator = read('src/navigation/AppNavigator.tsx');
const store = read('src/services/idempotentMutation.ts');
const hook = read('src/services/useFinancialMutation.ts');

assert.match(status, /listPendingOperationsForOwner\(requestedOwner\)/,
  'status surface must enumerate only the authenticated owner namespace');
assert.match(status, /ownerRef\.current === requestedOwner/,
  'late pending-state reads must not repaint a newer owner session');
assert.doesNotMatch(status, /useNavigationState|useNavigation\s*\(/,
  'the global status is a Stack.Navigator sibling and must not call navigator-scoped hooks');
assert.match(app, /<NavigationContainer[\s\S]*onStateChange=\{\(\) => setNavigationRevision/,
  'the NavigationContainer must own the route-change signal for the global status');
assert.match(app, /<AppNavigator navigationRevision=\{navigationRevision\}\s*\/>/,
  'the root navigation revision must flow into the authenticated navigator');
assert.match(navigator, /<PendingFinancialStatus navigationRevision=\{navigationRevision\}\s*\/>/,
  'the global status must receive route-change revisions without navigator-scoped hooks');
assert.match(status, /\[ownerId, navigationRevision, refresh\]/,
  'route changes must still refresh pending state after an ambiguous form is closed');
assert.match(status, /AppState\.addEventListener\('change'/,
  'foreground transitions must refresh pending state after restart/reconnect lifecycle events');
assert.match(status, /state === 'active'/);
assert.match(status, /subscribeFinancialIntentClosed/,
  'authoritative success or definitive closure must refresh the global unresolved status');
assert.match(status, /Fechar um formulário não cancela/,
  'the UI must explicitly state that closing a form is not authoritative cancellation');
assert.match(status, /accessibilityLiveRegion="polite"/);
assert.match(status, /accessibilityRole="summary"/);
assert.match(status, /setReconciliationUnavailable\(true\)/,
  'pending-store read failure must remain visible instead of becoming an empty pending set');
assert.match(status, /Reconciliação financeira indisponível/,
  'the blocking status must explain the safety condition without exposing private data');
assert.match(status, /accessibilityLiveRegion="assertive"/);
assert.match(status, /accessibilityRole="alert"/);
assert.match(status, /novas operações financeiras podem ficar bloqueadas/,
  'the user must understand why fresh financial actions can be prevented');

assert.doesNotMatch(status, /originalPayload/,
  'the global unresolved status must never render persisted financial payloads');
assert.doesNotMatch(status, /\.key\b/,
  'the global unresolved status must never render idempotency keys');
assert.doesNotMatch(status, /intentId/,
  'the global unresolved status must never render logical intent identifiers');

assert.match(navigator, /<PendingFinancialStatus[\s\S]*\/>/,
  'the unresolved status must survive originating form unmount inside the authenticated navigator');
assert.doesNotMatch(store, /LOCAL_RETENTION_MS|createdAt\s*>=\s*cutoff/,
  'ambiguous durable state must not be silently deleted because local wall-clock time passed');
assert.match(store, /PendingFinancialStateCorruptionError/,
  'durable-intent corruption must have an explicit fail-closed state');
assert.doesNotMatch(store, /if \(!manifest\) \{\s*await SecureStore\.deleteItemAsync\(manifestKey\)/,
  'invalid pending manifests must not be destructively converted into no pending state');
assert.match(store, /listPendingOperationsForOwner/);

assert.match(hook, /if \(!intentIdRef\.current\)/,
  'only a fresh form intent may enter the additional-intent acknowledgement gate');
assert.match(hook, /listPendingOperationsForOwner\(snapshot\.userId\)/,
  'the gate must inspect only current-owner durable pending operations');
assert.match(hook, /item\.operation === operation/,
  'the gate must be scoped to the same financial operation type');
assert.match(hook, /await acknowledgeAdditionalIntent\(operation, unresolvedCount\)/,
  'a new same-operation intent must await explicit acknowledgement');
assert.match(hook, /Criar operação adicional/,
  'the acknowledgement must explicitly name the action as an additional operation');
assert.match(hook, /cancelable: false/,
  'a new identity must not be allocated by dismissing the acknowledgement without an explicit action');
assert.match(hook, /intentIdRef\.current \?\? createFinancialIntentId\(\)/,
  'retry-in-place must continue to reuse the existing logical intent identity');
assert.ok(
  hook.indexOf('await acknowledgeAdditionalIntent(operation, unresolvedCount)')
    < hook.indexOf('const intentId = intentIdRef.current ?? createFinancialIntentId()'),
  'the explicit acknowledgement must happen before a new intent identity is created',
);

console.log('PENDING_FINANCIAL_STATUS_CONTRACT=pass');
