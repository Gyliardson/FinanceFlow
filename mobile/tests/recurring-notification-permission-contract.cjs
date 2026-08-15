const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const notificationService = fs.readFileSync(
  path.join(root, 'src/services/NotificationService.ts'),
  'utf8',
);
const recurringScreen = fs.readFileSync(
  path.join(root, 'src/screens/RecurringBillScreen.tsx'),
  'utf8',
);

function functionBody(source, name) {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${name} must have a body`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, i);
    }
  }
  throw new Error(`${name} body is unterminated`);
}

const permissionBody = functionBody(notificationService, 'requestNotificationPermissions');
const scheduleBody = functionBody(notificationService, 'scheduleNotificationsForBill');

assert.match(
  notificationService,
  /let notificationPermissionState:\s*NotificationPermissionState\s*=\s*'unknown'/,
  'permission decisions must have an explicit session state',
);
assert.match(
  notificationService,
  /let notificationPermissionInFlight:\s*Promise<boolean>\s*\|\s*null\s*=\s*null/,
  'permission reconciliation must have a shared in-flight promise',
);
assert.match(
  permissionBody,
  /if \(notificationPermissionState === 'denied'\) return false/,
  'a denied permission decision must not re-prompt for each recurring child',
);
assert.match(
  permissionBody,
  /if \(notificationPermissionInFlight\) return notificationPermissionInFlight/,
  'concurrent reminder scheduling must share one permission reconciliation',
);
assert.match(
  permissionBody,
  /setNotificationChannelAsync\('bills'/,
  'Android channel setup remains part of readiness reconciliation',
);
assert.match(
  permissionBody,
  /catch\s*\{[\s\S]*return false;/,
  'device permission/channel failures must fail closed without escaping into financial flows',
);

const readinessIndex = scheduleBody.indexOf('await requestNotificationPermissions()');
const cancelIndex = scheduleBody.indexOf('await cancelScheduledForBill(billId)');
const scheduleIndex = scheduleBody.indexOf('Notifications.scheduleNotificationAsync');
assert.ok(readinessIndex >= 0, 'every bill scheduling attempt must reconcile notification readiness');
assert.ok(cancelIndex > readinessIndex, 'readiness must be established before mutating existing reminders');
assert.ok(scheduleIndex > readinessIndex, 'readiness must be established before creating reminders');
assert.match(
  scheduleBody,
  /if \(!notificationsReady\)[\s\S]*return \[\];/,
  'permission/channel unavailability must prevent local scheduling',
);
assert.match(
  scheduleBody,
  /if \(Platform\.OS === 'web'\) return \[\];/,
  'web remains a safe no-op for local reminder scheduling',
);

assert.match(
  recurringScreen,
  /recurringReminderTargetsFromResponse\(payload\)/,
  'recurring reminders must still derive only from authoritative generated child targets',
);
assert.match(
  recurringScreen,
  /scheduleNotificationsForBill\(target\.id, target\.description, target\.dueDate\)\.catch\(\(\) => undefined\)/,
  'notification failure must remain detached from the already-successful financial operation',
);
assert.match(
  recurringScreen,
  /Se as notificações estiverem permitidas, o aplicativo pode enviar lembretes antes do vencimento\./,
  'UI copy must remain conditional instead of claiming reminders were configured',
);

console.log('recurring notification permission contract: ok');
