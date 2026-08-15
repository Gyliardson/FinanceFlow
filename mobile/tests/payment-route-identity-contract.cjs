const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const paymentPath = path.join(__dirname, '..', 'src', 'screens', 'PaymentScreen.tsx');
const historyPath = path.join(__dirname, '..', 'src', 'screens', 'BillHistoryScreen.tsx');
const payment = fs.readFileSync(paymentPath, 'utf8');
const history = fs.readFileSync(historyPath, 'utf8');

// Upstream detail establishes a concrete financial target.
assert.match(
  history,
  /navigation\.navigate\('Payment',\s*\{\s*billId:\s*bill\.id\s*\}\)/,
  'BillHistory must pass the explicit bill identity into the payment flow',
);

// PaymentScreen must treat route identity as a selector only after reconciling it
// against freshly fetched owner-scoped pending rows. It must never manufacture a
// payable Bill from route fields or silently select the first pending row.
assert.match(payment, /const routedBillId = route\?\.params\?\.billId \|\| null;/);
assert.match(payment, /const routedBill = bills\.find\(\(bill[^)]*\) => bill\.id === routedBillId\)/);
assert.match(payment, /setSelectedBill\(routedBill \|\| null\)/);
assert.match(payment, /setRoutedBillUnavailable\(Boolean\(routedBillId && !routedBill\)\)/);
assert.doesNotMatch(payment, /setSelectedBill\(bills\[0\]\)/, 'generic entry must not auto-select an arbitrary bill');
assert.doesNotMatch(payment, /setSelectedBill\(\{[^}]*route/i, 'route payload must not be trusted as an authoritative bill row');

// Stale routed identity needs visible, privacy-safe feedback while preserving the
// generic list as an explicit recovery path.
assert.match(payment, /routedBillUnavailable/);
assert.match(payment, /Esta fatura não está mais disponível para pagamento/);
assert.match(payment, /Selecione outra fatura pendente se quiser registrar um pagamento diferente/);

console.log('PAYMENT_ROUTE_IDENTITY_CONTRACT=pass');
