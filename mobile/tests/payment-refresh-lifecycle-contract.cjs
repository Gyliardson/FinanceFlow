const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const paymentPath = path.join(__dirname, '..', 'src', 'screens', 'PaymentScreen.tsx');
const payment = fs.readFileSync(paymentPath, 'utf8');

// Payment candidates must be reconciled when the mounted screen becomes relevant
// again, rather than trusting a potentially stale initial pending-bills snapshot.
assert.match(payment, /AppState, View, Text, StyleSheet/);
assert.match(
  payment,
  /navigation\.addListener\('focus', \(\) => \{\s*if \(!paymentAttemptLock\.current\) void fetchPendingBills\(\);\s*\}\)/s,
);
assert.match(
  payment,
  /AppState\.addEventListener\('change', \(state\) => \{\s*if \(state === 'active' && !paymentAttemptLock\.current\) \{\s*void fetchPendingBills\(\);\s*\}\s*\}\)/s,
);
assert.match(payment, /unsubscribeFocus\(\);\s*appStateSubscription\.remove\(\);/s);

// Every request belongs to a monotonic generation. Older responses/errors are not
// allowed to publish over a newer focus/resume/manual refresh.
assert.match(payment, /const refreshGeneration = useRef\(0\);/);
assert.match(payment, /const generation = \+\+refreshGeneration\.current;/);
assert.match(
  payment,
  /if \(generation !== refreshGeneration\.current \|\| paymentAttemptLock\.current\) return;/,
);
assert.match(payment, /refreshGeneration\.current \+= 1;/);

// Lifecycle refresh must never replace the immutable target of an active payment.
// Loading remains a read-state concern, not a false "payment in progress" state.
assert.match(payment, /if \(paymentAttemptLock\.current\) return;\s*const generation/s);
assert.match(payment, /const attemptBill = selectedBill;\s*const attemptReceipt = receipt;/s);
assert.match(payment, /const attemptBusy = paymentAttemptActive \|\| uploading;/);
assert.doesNotMatch(payment, /const attemptBusy = [^;]*loading/);

// Routed identity is rechecked against the refreshed authoritative pending set;
// generic entry preserves a still-payable explicit selection but never invents one.
assert.match(payment, /const routedBill = bills\.find\(\(bill\) => bill\.id === routedBillId\);/);
assert.match(
  payment,
  /setSelectedBill\(\(current\) => current\s*\? bills\.find\(\(bill\) => bill\.id === current\.id\) \|\| null\s*: null\);/s,
);
assert.doesNotMatch(payment, /setSelectedBill\(bills\[0\]\)/);

console.log('PAYMENT_REFRESH_LIFECYCLE_CONTRACT=pass');
