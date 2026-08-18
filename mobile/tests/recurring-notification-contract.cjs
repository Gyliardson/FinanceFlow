'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const buildDir = process.env.FINANCEFLOW_AUTH_CONTRACT_BUILD;
assert.ok(buildDir, 'FINANCEFLOW_AUTH_CONTRACT_BUILD must point to compiled production modules');

// The production module compiled into buildDir resolves the deterministic
// expo-notifications stub from buildDir/node_modules. Require that exact module
// here too; using bare require() would prefer mobile/node_modules and accidentally
// exercise the real Expo package instead of the CI harness state.
const Notifications = require(path.join(buildDir, 'node_modules/expo-notifications'));
const { scheduleNotificationsForBill, cancelNotificationsForBill } = require(path.join(buildDir, 'NotificationService.js'));
const { recurringReminderTargetsFromResponse } = require(path.join(buildDir, 'recurringReminderTargets.js'));

const template = {
  id: 'template-1',
  is_recurring: true,
  due_date: '2099-12-31',
  description: 'Template',
};
const child = {
  id: 'child-1',
  parent_bill_id: 'template-1',
  is_recurring: false,
  due_date: '2099-12-31',
  description: 'Internet - 12/2099',
};

assert.deepEqual(
  recurringReminderTargetsFromResponse({ data: [template], generation: { status: 'success', generated: [child] } }),
  [{ id: 'child-1', description: 'Internet - 12/2099', dueDate: '2099-12-31' }],
  'only the materialized payable child may become a reminder target',
);
assert.deepEqual(
  recurringReminderTargetsFromResponse({ status: 'partial_success', data: [template], generation: { status: 'deferred' } }),
  [],
  'deferred generation must not fabricate a reminder target from the template',
);
assert.deepEqual(
  recurringReminderTargetsFromResponse({ generation: { generated: [template, { ...child, id: '', parent_bill_id: '' }] } }),
  [],
  'templates and malformed generated rows must fail closed',
);

const screen = fs.readFileSync(path.join(__dirname, '../src/screens/RecurringBillScreen.tsx'), 'utf8');
const reminderHelperStart = screen.indexOf('const scheduleGeneratedReminders = (payload: any) =>');
const reminderHelperEnd = screen.indexOf('const finishSuccessfulCreation = (payload: any) =>');
assert.ok(reminderHelperStart >= 0 && reminderHelperEnd > reminderHelperStart, 'screen must retain a shared generated-child reminder boundary');
const reminderHelper = screen.slice(reminderHelperStart, reminderHelperEnd);
assert.match(reminderHelper, /recurringReminderTargetsFromResponse\(payload\)/, 'shared reminder boundary must derive targets through the production child-only extractor');
assert.match(reminderHelper, /scheduleNotificationsForBill\(target\.id, target\.description, target\.dueDate\)/, 'only extracted generated-child targets may reach notification scheduling');
assert.match(screen, /finishSuccessfulCreation\(response\.data\)/, 'normal recurring creation must use the shared generated-child reminder boundary');
assert.match(screen, /scheduleGeneratedReminders\(\{ generation: response\.data \}\)/, 'generation recovery must use the same generated-child reminder boundary');
assert.doesNotMatch(screen, /response\.data\.data\[0\][\s\S]{0,180}scheduleNotificationsForBill/, 'screen must not schedule the recurring template as a payable reminder');

Notifications.__reset();
Notifications.__seed([
  { identifier: 'old-child-reminder', content: { data: { billId: 'child-1' } } },
  { identifier: 'other-bill-reminder', content: { data: { billId: 'other-child' } } },
]);

(async () => {
  const firstIds = await scheduleNotificationsForBill('child-1', 'ignored private name', '2099-12-31');
  assert.equal(firstIds.length, 6, 'future payable child gets T-3/T-2/T-1 plus three due-day reminders');
  assert.equal(Notifications.__scheduledFor('child-1').length, 6);
  assert.equal(Notifications.__scheduledFor('other-child').length, 1, 'replacement must not cancel unrelated bill reminders');
  assert.ok(!Notifications.__identifiers().includes('old-child-reminder'), 'pre-existing reminder for the child must be replaced');

  const secondIds = await scheduleNotificationsForBill('child-1', 'ignored private name', '2099-12-31');
  assert.equal(secondIds.length, 6);
  assert.equal(Notifications.__scheduledFor('child-1').length, 6, 'retry/reconciliation must replace rather than duplicate reminders');

  const scheduleCallsBeforeFailure = Notifications.__scheduleCallCount();
  Notifications.__failNextList();
  const failedReplacement = await scheduleNotificationsForBill('child-2', 'ignored', '2099-12-31');
  assert.deepEqual(failedReplacement, [], 'failed reconciliation must fail closed');
  assert.equal(Notifications.__scheduleCallCount(), scheduleCallsBeforeFailure, 'must not add a new set when existing reminders cannot be enumerated');

  await cancelNotificationsForBill('child-1');
  assert.equal(Notifications.__scheduledFor('child-1').length, 0, 'paying/cancelling by payable child ID removes all of its reminders');
  assert.equal(Notifications.__scheduledFor('other-child').length, 1);

  console.log('RECURRING_NOTIFICATION_CONTRACT=pass');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
