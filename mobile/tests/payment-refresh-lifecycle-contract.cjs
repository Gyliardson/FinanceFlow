const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const paymentPath = path.join(__dirname, '..', 'src', 'screens', 'PaymentScreen.tsx');
const payment = fs.readFileSync(paymentPath, 'utf8');

const requires = (snippet, message) => {
  assert.ok(payment.includes(snippet), message || `missing invariant: ${snippet}`);
};

// Mounted payment candidates are reconciled when the screen becomes relevant
// again instead of trusting a potentially stale initial pending-bills snapshot.
requires('AppState, View, Text, StyleSheet');
requires("navigation.addListener('focus'");
requires("AppState.addEventListener('change'");
requires("state === 'active' && !paymentAttemptLock.current");
requires('if (!paymentAttemptLock.current) void fetchPendingBills();');
requires('unsubscribeFocus();');
requires('appStateSubscription.remove();');

// Every fetch belongs to a monotonic generation; stale responses/errors cannot
// publish over a newer focus/resume/manual refresh, and unmount invalidates work.
requires('const refreshGeneration = useRef(0);');
requires('const generation = ++refreshGeneration.current;');
requires('if (generation !== refreshGeneration.current || paymentAttemptLock.current) return;');
requires('refreshGeneration.current += 1;');
assert.ok(
  payment.indexOf('const generation = ++refreshGeneration.current;')
    < payment.indexOf("const response = await api.get('/bills/pending');"),
  'generation must be captured before the authoritative request',
);

// Lifecycle refresh never replaces the immutable identity of an active payment.
requires('if (paymentAttemptLock.current) return;');
requires('const attemptBill = selectedBill;');
requires('const attemptReceipt = receipt;');
requires('const attemptBusy = paymentAttemptActive || uploading;');
assert.ok(!payment.includes('const attemptBusy = paymentAttemptActive || uploading || loading;'));

// Routed identity is rechecked against refreshed pending rows. Generic entry only
// preserves an explicitly selected bill if that same id is still authoritative.
requires('const routedBill = bills.find((bill) => bill.id === routedBillId);');
requires('? bills.find((bill) => bill.id === current.id) || null');
assert.ok(!payment.includes('setSelectedBill(bills[0])'), 'must never auto-select an arbitrary bill');

console.log('PAYMENT_REFRESH_LIFECYCLE_CONTRACT=pass');
