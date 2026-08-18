const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const paymentPath = path.join(__dirname, '..', 'src', 'screens', 'PaymentScreen.tsx');
const payment = fs.readFileSync(paymentPath, 'utf8');

// A ref, not only React state, must synchronously reject a same-render second submit.
assert.match(payment, /const paymentAttemptLock = useRef\(false\);/);
assert.match(payment, /const beginPaymentAttempt = \(\) => \{\s*if \(paymentAttemptLock\.current\) return false;\s*paymentAttemptLock\.current = true;\s*setPaymentAttemptActive\(true\);\s*return true;/s);
assert.match(payment, /if \(!beginPaymentAttempt\(\)\) return;/);
assert.match(payment, /const endPaymentAttempt = \(\) => \{\s*paymentAttemptLock\.current = false;\s*setPaymentAttemptActive\(false\);/s);

// The immutable target/receipt snapshot is captured before any asynchronous payment work.
assert.match(payment, /const attemptBill = selectedBill;\s*const attemptReceipt = receipt;/s);
assert.match(payment, /api\.post\(`\/bills\/\$\{attemptBill\.id\}\/pay-no-receipt`\)/);
assert.match(payment, /api\.post\(`\/bills\/\$\{attemptBill\.id\}\/pay`, formData/);
assert.match(payment, /uri: attemptReceipt\.uri,/);
assert.match(payment, /type: attemptReceipt\.mimeType,/);
assert.match(payment, /reconcileReceiptPayment\(attemptBill\.id\)/);

// All controls capable of changing payment intent are disabled while the attempt is active.
assert.match(payment, /const attemptBusy = paymentAttemptActive \|\| uploading;/);
assert.match(payment, /accessibilityState=\{\{ selected: isSelected, disabled: attemptBusy \}\}\s*disabled=\{attemptBusy\}/s);
assert.match(payment, /accessibilityLabel="Remover comprovante selecionado"[\s\S]*?disabled=\{attemptBusy\}/);
assert.match(payment, /accessibilityLabel="Selecionar comprovante da galeria"[\s\S]*?disabled=\{attemptBusy\}/);
assert.match(payment, /accessibilityLabel="Fotografar comprovante"[\s\S]*?disabled=\{attemptBusy\}/);
assert.match(payment, /accessibilityState=\{\{ disabled: !selectedBill \|\| attemptBusy, busy: attemptBusy \}\}/);
assert.match(payment, /disabled=\{!selectedBill \|\| attemptBusy\}/);

// The no-receipt confirmation dialog also owns the lock until cancel/dismiss or completion.
assert.match(payment, /\{ text: 'Cancelar', style: 'cancel', onPress: endPaymentAttempt \}/);
assert.match(payment, /\{ cancelable: true, onDismiss: endPaymentAttempt \}/);
assert.match(payment, /setUploading\(false\);\s*endPaymentAttempt\(\);/s);

// Picker callbacks cannot mutate the receipt after a payment attempt acquires the lock.
assert.match(payment, /const selectReceiptAsset = \(asset:[\s\S]*?if \(paymentAttemptLock\.current\) return;/);
assert.match(payment, /const handlePickReceipt = async \(\) => \{\s*if \(paymentAttemptLock\.current\) return;/s);
assert.match(payment, /const handleTakePhoto = async \(\) => \{\s*if \(paymentAttemptLock\.current\) return;/s);

// Deterministic behavioral model: first submit wins synchronously and keeps identity even if
// visible selection variables are later changed by unrelated code.
let locked = false;
function begin() {
  if (locked) return false;
  locked = true;
  return true;
}
function end() { locked = false; }

let selected = { id: 'bill-a' };
let selectedReceipt = { uri: 'receipt-a', mimeType: 'image/jpeg' };
assert.equal(begin(), true);
const attemptBill = selected;
const attemptReceipt = selectedReceipt;
assert.equal(begin(), false, 'same-render second submit must be rejected synchronously');
selected = { id: 'bill-b' };
selectedReceipt = { uri: 'receipt-b', mimeType: 'image/png' };
assert.equal(attemptBill.id, 'bill-a');
assert.equal(attemptReceipt.uri, 'receipt-a');
end();
assert.equal(begin(), true, 'a terminal attempt releases the single-flight boundary');

console.log('PAYMENT_ATTEMPT_IDENTITY_LOCK_CONTRACT=pass');
