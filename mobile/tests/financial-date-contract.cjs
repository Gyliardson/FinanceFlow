'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
if (!buildDir) throw new Error('FINANCEFLOW_AUTH_CONTRACT_BUILD is required');
const dates = require(path.join(buildDir, 'financialDate.js'));

const oldUtcSlice = (instant) => new Date(instant).toISOString().split('T')[0];

function assertFinancialDate(isoInstant, expected) {
  assert.equal(dates.financialDateOnly(new Date(isoInstant)), expected, isoInstant);
}

function testUtcDriftControlAndRequestedRegression() {
  const instant = '2026-08-15T01:30:00.000Z'; // 2026-08-14 22:30 America/Sao_Paulo
  assert.equal(
    oldUtcSlice(instant),
    '2026-08-15',
    'control must reproduce the historical UTC-slice tomorrow bug',
  );
  assertFinancialDate(instant, '2026-08-14');
}

function testLocalMidnightAndRolloverBoundaries() {
  assertFinancialDate('2026-08-15T02:59:59.999Z', '2026-08-14');
  assertFinancialDate('2026-08-15T03:00:00.000Z', '2026-08-15');
  assertFinancialDate('2026-08-15T03:00:00.001Z', '2026-08-15');

  // UTC is already September while the financial calendar is still August.
  assertFinancialDate('2026-09-01T02:30:00.000Z', '2026-08-31');
  assertFinancialDate('2026-09-01T03:00:00.000Z', '2026-09-01');

  // UTC is already in the next year while Sao Paulo is still December 31.
  assertFinancialDate('2027-01-01T02:30:00.000Z', '2026-12-31');
  assertFinancialDate('2027-01-01T03:00:00.000Z', '2027-01-01');

  assert.equal(dates.financialDaysBetween('2026-08-31', '2026-09-01'), 1);
  assert.equal(dates.financialDaysBetween('2026-12-31', '2027-01-01'), 1);
}

function testIanaTimezoneContract() {
  assert.equal(dates.FINANCIAL_TIME_ZONE, 'America/Sao_Paulo');
  // The implementation delegates timezone/DST history to Intl/IANA rather than
  // hard-coding a -03:00 offset. This historical instant intentionally exercises
  // a period when Sao Paulo's offset rules differed from today's no-DST baseline.
  const historical = dates.financialDateOnly(new Date('2018-12-01T02:30:00.000Z'));
  assert.equal(historical, '2018-12-01');
}

function testFinancialImpactBoundaryModel() {
  const instant = new Date('2026-08-15T01:30:00.000Z');
  const correctBoundary = dates.financialDateOnly(instant);
  const wrongBoundary = oldUtcSlice(instant);
  const incomes = [
    { date: '2026-08-14', amount: 100 },
    { date: '2026-08-15', amount: 25 },
  ];
  const payments = [
    { payment_date: '2026-08-14', amount: 20 },
  ];
  const balanceFromBoundary = (boundary) => 1000
    + incomes.filter((item) => item.date >= boundary).reduce((sum, item) => sum + item.amount, 0)
    - payments.filter((item) => item.payment_date >= boundary).reduce((sum, item) => sum + item.amount, 0);

  assert.equal(balanceFromBoundary(correctBoundary), 1105);
  assert.equal(balanceFromBoundary(wrongBoundary), 1025);
  assert.notEqual(
    balanceFromBoundary(correctBoundary),
    balanceFromBoundary(wrongBoundary),
    'a UTC date drift must demonstrably change the financial boundary result',
  );
}

function testStaticFinancialDateOnlyGuard() {
  const mobileRoot = process.cwd();
  const financialPaths = [
    'src/screens/HomeScreen.tsx',
    'src/screens/IncomeScreen.tsx',
    'src/screens/DetailScreen.tsx',
    'src/screens/PaymentScreen.tsx',
    'src/screens/BillHistoryScreen.tsx',
    'src/screens/RecurringBillScreen.tsx',
    'src/screens/InsightsScreen.tsx',
  ];
  const forbidden = [
    /toISOString\(\)\s*\.split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\]/,
    /toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/,
  ];

  for (const relative of financialPaths) {
    const source = fs.readFileSync(path.join(mobileRoot, relative), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${relative} must not derive a financial date-only value by slicing a UTC timestamp`,
      );
    }
  }

  const home = fs.readFileSync(path.join(mobileRoot, 'src/screens/HomeScreen.tsx'), 'utf8');
  const income = fs.readFileSync(path.join(mobileRoot, 'src/screens/IncomeScreen.tsx'), 'utf8');
  assert.match(home, /initial_balance_date:\s*initialDate\s*\|\|\s*financialDateOnly\(\)/);
  assert.match(income, /date:\s*financialDateOnly\(\)/);
}

testUtcDriftControlAndRequestedRegression();
testLocalMidnightAndRolloverBoundaries();
testIanaTimezoneContract();
testFinancialImpactBoundaryModel();
testStaticFinancialDateOnlyGuard();
console.log('FINANCIAL_DATE_CONTRACT=pass');
