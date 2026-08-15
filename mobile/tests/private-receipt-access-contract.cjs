const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mobileRoot = path.resolve(__dirname, '..');
const history = fs.readFileSync(path.join(mobileRoot, 'src/screens/BillHistoryScreen.tsx'), 'utf8');

function testDoesNotConsumeDurableReceiptLocators() {
  assert.doesNotMatch(history, /receipt_url/,
    'bill history must not consume legacy durable receipt URLs');
  assert.doesNotMatch(history, /receipt_path/,
    'bill history must not receive or consume private storage object paths');
  assert.doesNotMatch(history, /<Image\b/,
    'receipt bytes must not be fetched passively just to render the bill detail screen');
}

function testPrivateReceiptAccessRequiresExplicitAction() {
  assert.match(history, /const openPrivateReceipt = async \(\) => \{/);
  assert.match(history, /api\.get\(`\/bills\/\$\{bill\.id\}\/receipt`\)/);
  assert.match(history, /onPress=\{openPrivateReceipt\}/);
  assert.match(history, /disabled=\{receiptOpening\}/);
  assert.match(history, /Um acesso temporário é solicitado somente quando você decide abri-lo\./);

  const signedAccessCalls = history.match(/api\.get\(`\/bills\/\$\{bill\.id\}\/receipt`\)/g) || [];
  assert.equal(signedAccessCalls.length, 1,
    'short-lived receipt access must be requested only by the explicit action handler');
}

function testFailureAndLegacyStatesRemainExplicit() {
  assert.match(history, /setReceiptFailure\('Não foi possível abrir o comprovante agora\./);
  assert.match(history, /accessibilityLiveRegion="assertive"/);
  assert.match(history, /legacy_receipt_requires_reconciliation/);
  assert.match(history, /precisa ser reconciliado antes de poder gerar acesso privado temporário/);
}

function testCurrentPrivateReceiptStateDrivesHistoryAffordance() {
  assert.match(history, /has_receipt: boolean/);
  assert.match(history, /isPaid && bill\.has_receipt/);
  assert.match(history, /itemIsPaid && item\.has_receipt/);
}

for (const test of [
  testDoesNotConsumeDurableReceiptLocators,
  testPrivateReceiptAccessRequiresExplicitAction,
  testFailureAndLegacyStatesRemainExplicit,
  testCurrentPrivateReceiptStateDrivesHistoryAffordance,
]) {
  test();
  process.stdout.write(`PASS ${test.name}\n`);
}
