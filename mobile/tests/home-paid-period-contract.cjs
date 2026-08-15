'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.join(__dirname, '../src/screens/HomeScreen.tsx'),
  'utf8',
);

function inPeriod(dateOnly, monthZeroBased, year) {
  if (typeof dateOnly !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly);
  if (!match) return false;
  return Number(match[1]) === year && Number(match[2]) - 1 === monthZeroBased;
}

function modelPeriodSets(bills, monthZeroBased, year) {
  const due = bills.filter((bill) => !bill.is_recurring && inPeriod(bill.due_date, monthZeroBased, year));
  return {
    pending: due.filter((bill) => bill.status === 'pending' || bill.status === 'overdue'),
    all: due,
    paid: bills.filter((bill) =>
      !bill.is_recurring &&
      (bill.status === 'paid' || bill.status === 'aprovado') &&
      inPeriod(bill.payment_date, monthZeroBased, year)),
  };
}

function testCrossMonthPaymentUsesPaymentDate() {
  const bills = [
    { id: 'cross-month', status: 'paid', due_date: '2026-01-31', payment_date: '2026-02-02', is_recurring: false },
    { id: 'jan-pending', status: 'pending', due_date: '2026-01-20', payment_date: null, is_recurring: false },
    { id: 'template', status: 'pending', due_date: '2026-01-05', payment_date: null, is_recurring: true },
  ];

  const january = modelPeriodSets(bills, 0, 2026);
  const february = modelPeriodSets(bills, 1, 2026);

  assert.deepEqual(january.pending.map((bill) => bill.id), ['jan-pending']);
  assert.deepEqual(january.paid.map((bill) => bill.id), []);
  assert.deepEqual(february.paid.map((bill) => bill.id), ['cross-month']);
  assert.deepEqual(january.all.map((bill) => bill.id), ['cross-month', 'jan-pending']);
}

function testMissingOrMalformedPaymentDateIsNotBackfilledFromDueDate() {
  const bills = [
    { id: 'missing', status: 'paid', due_date: '2026-01-10', payment_date: null, is_recurring: false },
    { id: 'malformed', status: 'paid', due_date: '2026-01-11', payment_date: '2026/01/11', is_recurring: false },
  ];

  assert.deepEqual(modelPeriodSets(bills, 0, 2026).paid, []);
}

function testProductionSeparatesDueAndPaymentPeriodSemantics() {
  assert.match(source, /const billsDueInSelectedPeriod = useMemo\(\(\) => allBills\.filter/);
  assert.match(source, /const pendingBills = useMemo\([\s\S]*billsDueInSelectedPeriod\.filter/);
  assert.match(source, /const paidBills = useMemo\(\(\) => allBills\.filter[\s\S]*!bill\.payment_date[\s\S]*parseFinancialDateOnly\(bill\.payment_date\)/);
  assert.match(source, /activeTab === 'paid'[\s\S]*\? paidBills[\s\S]*: billsDueInSelectedPeriod/);
  assert.match(source, /key: 'all', label: 'Todas', count: billsDueInSelectedPeriod\.length/);
  assert.doesNotMatch(
    source,
    /const paidBills = useMemo\([\s\S]{0,250}filteredByDate/,
    'paid month must not be derived from a due-date slice',
  );
}

function testPaidSortDoesNotFallbackToDueDate() {
  assert.match(
    source,
    /if \(activeTab === 'paid'\) \{\s*return \(b\.payment_date \?\? ''\)\.localeCompare\(a\.payment_date \?\? ''\);/,
  );
  assert.doesNotMatch(
    source,
    /activeTab === 'paid'[\s\S]{0,220}payment_date \|\| .*due_date/,
    'paid ordering must not reintroduce due-date attribution as fallback',
  );
}

const tests = [
  testCrossMonthPaymentUsesPaymentDate,
  testMissingOrMalformedPaymentDateIsNotBackfilledFromDueDate,
  testProductionSeparatesDueAndPaymentPeriodSemantics,
  testPaidSortDoesNotFallbackToDueDate,
];

for (const test of tests) {
  test();
  process.stdout.write(`PASS ${test.name}\n`);
}

console.log('HOME_PAID_PERIOD_CONTRACT=pass');
