'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const notificationSource = fs.readFileSync(
  path.join(__dirname, '../src/services/NotificationService.ts'),
  'utf8',
);
const appSource = fs.readFileSync(path.join(__dirname, '../../mobile/App.tsx'), 'utf8');

function modelStaleIdentifiers(scheduled, payableIds) {
  const active = new Set(payableIds);
  return scheduled
    .filter((notification) => {
      const data = notification.content?.data;
      const type = data?.type;
      const billId = data?.billId;
      return (type === 'reminder' || type === 'urgent')
        && typeof billId === 'string'
        && billId.length > 0
        && !active.has(billId);
    })
    .map((notification) => notification.identifier);
}

function testBehavioralBoundary() {
  const scheduled = [
    { identifier: 'keep-reminder', content: { data: { billId: 'pending-a', type: 'reminder' } } },
    { identifier: 'drop-reminder', content: { data: { billId: 'paid-b', type: 'reminder' } } },
    { identifier: 'drop-urgent', content: { data: { billId: 'paid-c', type: 'urgent' } } },
    { identifier: 'keep-unrelated', content: { data: { billId: 'paid-b', type: 'marketing' } } },
    { identifier: 'keep-foreign', content: { data: { calendarId: 'external' } } },
  ];

  assert.deepEqual(
    modelStaleIdentifiers(scheduled, ['pending-a']),
    ['drop-reminder', 'drop-urgent'],
    'only stale FinanceFlow bill reminder types should be retired',
  );
}

function testProductionFilterMatchesBoundary() {
  assert.match(
    notificationSource,
    /export async function reconcileScheduledBillNotifications\([\s\S]*new Set\(authoritativePayableBillIds\)/,
  );
  assert.match(notificationSource, /type === 'reminder' \|\| type === 'urgent'/);
  assert.match(notificationSource, /typeof billId === 'string'/);
  assert.match(notificationSource, /!payableIds\.has\(billId\)/);
  assert.match(notificationSource, /Promise\.allSettled\(/, 'one cancellation failure must not stop all stale cleanup');
  assert.match(notificationSource, /catch \{[\s\S]*return 0;[\s\S]*\}/, 'device API failure must stay fail-safe');
}

function testAuthoritativeOnlyWiring() {
  assert.match(appSource, /api\.get\('\/bills\/pending'\)/, 'reconciliation must use an online authoritative endpoint');
  assert.match(appSource, /reconcileScheduledBillNotifications\(payableIds\)/);
  assert.match(appSource, /AppState\.addEventListener\('change'[\s\S]*state === 'active'/, 'foreground resume must reconcile');
  assert.match(
    appSource,
    /catch \{[\s\S]*authoritative online snapshot may delete reminders[\s\S]*scheduler unchanged/,
    'failed/offline authoritative fetch must not trigger destructive cleanup',
  );
  assert.doesNotMatch(appSource, /getUserCacheSnapshot|trySetUserCache/, 'notification cleanup must never derive authority from offline cache');
}

function testExistingIsolationRemains() {
  assert.match(notificationSource, /export async function cancelAllNotifications/);
  assert.match(notificationSource, /data: \{ billId, type: 'reminder' \}/);
  assert.match(notificationSource, /data: \{ billId, type: 'urgent' \}/);
  assert.doesNotMatch(notificationSource, /body:[^\n]*billName/);
}

const tests = [
  testBehavioralBoundary,
  testProductionFilterMatchesBoundary,
  testAuthoritativeOnlyWiring,
  testExistingIsolationRemains,
];

for (const test of tests) {
  test();
  process.stdout.write(`PASS ${test.name}\n`);
}

console.log('AUTHORITATIVE_REMINDER_RECONCILIATION_CONTRACT=pass');
