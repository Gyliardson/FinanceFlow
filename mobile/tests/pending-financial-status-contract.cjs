'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const status = read('src/components/PendingFinancialStatus.tsx');
const navigator = read('src/navigation/AppNavigator.tsx');
const store = read('src/services/idempotentMutation.ts');

assert.match(status, /listPendingOperationsForOwner\(requestedOwner\)/,
  'status surface must enumerate only the authenticated owner namespace');
assert.match(status, /ownerRef\.current === requestedOwner/,
  'late pending-state reads must not repaint a newer owner session');
assert.match(status, /useNavigationState/,
  'route changes must refresh pending state after an ambiguous form is closed');
assert.match(status, /AppState\.addEventListener\('change'/,
  'foreground transitions must refresh pending state after restart/reconnect lifecycle events');
assert.match(status, /state === 'active'/);
assert.match(status, /Fechar um formulário não cancela/,
  'the UI must explicitly state that closing a form is not authoritative cancellation');
assert.match(status, /accessibilityLiveRegion="polite"/);
assert.match(status, /accessibilityRole="summary"/);

assert.doesNotMatch(status, /originalPayload/,
  'the global unresolved status must never render persisted financial payloads');
assert.doesNotMatch(status, /\.key\b/,
  'the global unresolved status must never render idempotency keys');
assert.doesNotMatch(status, /intentId/,
  'the global unresolved status must never render logical intent identifiers');

assert.match(navigator, /<PendingFinancialStatus\s*\/>/,
  'the unresolved status must survive originating form unmount inside the authenticated navigator');
assert.match(store, /LOCAL_RETENTION_MS/,
  'ambiguous durable state remains retained rather than being deleted to satisfy the UI contract');
assert.match(store, /listPendingOperationsForOwner/);

console.log('PENDING_FINANCIAL_STATUS_CONTRACT=pass');
