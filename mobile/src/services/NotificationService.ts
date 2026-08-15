import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Notification previews can be rendered on a locked device. Keep visible copy
// generic by default: bill names and other financial details belong inside the
// authenticated app, not in title/body previews. The opaque billId remains in
// notification data only so the app can identify/cancel the correct reminder.
const MESSAGES_BEFORE = [
  {
    title: 'Lembrete de vencimento',
    body: (days: number) =>
      `Você tem uma conta com vencimento em ${days} dia${days > 1 ? 's' : ''}. Abra o FinanceFlow para conferir os detalhes.`,
  },
  {
    title: 'Lembrete de vencimento',
    body: (days: number) =>
      `Uma conta vence em ${days} dia${days > 1 ? 's' : ''}. Consulte o FinanceFlow para revisar o pagamento.`,
  },
  {
    title: 'Vencimento próximo',
    body: (days: number) =>
      `Há uma conta com vencimento em ${days} dia${days > 1 ? 's' : ''}. Abra o app para ver as informações com segurança.`,
  },
];

const MESSAGES_DUE_DAY = {
  morning: {
    title: 'Vencimento hoje',
    body: 'Você tem uma conta com vencimento hoje. Abra o FinanceFlow para conferir os detalhes.',
  },
  afternoon: {
    title: 'Lembrete de vencimento',
    body: 'Uma conta vence hoje. Consulte o FinanceFlow para revisar o status do pagamento.',
  },
  night: {
    title: 'Vencimento hoje',
    body: 'Há uma conta com vencimento hoje. Abra o app para conferir as informações com segurança.',
  },
};

let notificationPermissionInFlight: Promise<boolean> | null = null;

/**
 * Reconcile current OS permission and Android channel state before local scheduling.
 *
 * Every independent attempt re-reads device permission so changes made in system
 * Settings become observable without restarting the JS process. Concurrent callers
 * share one in-flight reconciliation; only an actually requestable permission state
 * can invoke the OS prompt. A known denial fails closed without re-prompting.
 */
export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (notificationPermissionInFlight) return notificationPermissionInFlight;

  const permissionRequest = (async (): Promise<boolean> => {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted' && existingStatus !== 'denied') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        console.warn('Permissão de notificações não concedida.');
        return false;
      }

      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('bills', {
          name: 'Contas a Pagar',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 250, 250],
          lightColor: '#FF231F7C',
          sound: 'default',
        });
      }

      return true;
    } catch {
      console.warn('[Notificações] Não foi possível preparar permissão/canal para lembretes.');
      return false;
    }
  })();

  notificationPermissionInFlight = permissionRequest;
  try {
    return await permissionRequest;
  } finally {
    if (notificationPermissionInFlight === permissionRequest) {
      notificationPermissionInFlight = null;
    }
  }
}

const cancelScheduledForBill = async (billId: string): Promise<number> => {
  const allScheduled = await Notifications.getAllScheduledNotificationsAsync();
  const identifiers = allScheduled
    .filter((notification) => notification.content.data?.billId === billId)
    .map((notification) => notification.identifier);

  await Promise.all(
    identifiers.map((identifier) => Notifications.cancelScheduledNotificationAsync(identifier)),
  );
  return identifiers.length;
};

/**
 * Retire only FinanceFlow bill reminders that contradict an authoritative payable set.
 *
 * This must be called only after a successful online bill fetch. Offline cache is not
 * evidence that a reminder is stale. Unrelated scheduled notifications are preserved.
 * Device API failures are intentionally contained so financial UI reconciliation can
 * still complete even when notification cleanup is temporarily unavailable.
 */
export async function reconcileScheduledBillNotifications(
  authoritativePayableBillIds: readonly string[],
): Promise<number> {
  if (Platform.OS === 'web') return 0;

  const payableIds = new Set(authoritativePayableBillIds);
  try {
    const allScheduled = await Notifications.getAllScheduledNotificationsAsync();
    const staleIdentifiers = allScheduled
      .filter((notification) => {
        const data = notification.content.data;
        const type = data?.type;
        const billId = data?.billId;
        const isFinanceFlowBillReminder = type === 'reminder' || type === 'urgent';
        return isFinanceFlowBillReminder
          && typeof billId === 'string'
          && billId.length > 0
          && !payableIds.has(billId);
      })
      .map((notification) => notification.identifier);

    const results = await Promise.allSettled(
      staleIdentifiers.map((identifier) => Notifications.cancelScheduledNotificationAsync(identifier)),
    );
    const cancelled = results.filter((result) => result.status === 'fulfilled').length;
    if (cancelled !== staleIdentifiers.length) {
      console.warn('[Notificações] Alguns lembretes obsoletos não puderam ser removidos.');
    }
    return cancelled;
  } catch {
    console.warn('[Notificações] Não foi possível reconciliar lembretes com o estado autoritativo.');
    return 0;
  }
}

/**
 * Replace all pending reminders for one payable bill instance.
 *
 * Scheduling first reconciles permission/channel readiness. Replacement is deliberate:
 * retries/reconciliation can safely call this function again for the same child bill
 * without multiplying OS notifications. If permission/channel setup or the existing
 * reminder set cannot be reconciled, scheduling fails closed rather than adding an
 * unknown duplicate set.
 */
export async function scheduleNotificationsForBill(
  billId: string,
  _billName: string,
  dueDate: string
): Promise<string[]> {
  if (Platform.OS === 'web') return [];

  const notificationsReady = await requestNotificationPermissions();
  if (!notificationsReady) {
    console.warn('[Notificações] Lembretes não agendados: permissão/canal indisponível.');
    return [];
  }

  try {
    await cancelScheduledForBill(billId);
  } catch {
    console.warn('[Notificações] Falha ao reconciliar lembretes existentes; novo agendamento ignorado.');
    return [];
  }

  const promises: Promise<string | void>[] = [];
  const due = new Date(dueDate + 'T00:00:00');
  const now = new Date();

  for (let daysBefore = 3; daysBefore >= 1; daysBefore--) {
    const triggerDate = new Date(due);
    triggerDate.setDate(triggerDate.getDate() - daysBefore);
    triggerDate.setHours(9, 0, 0, 0);

    if (triggerDate <= now) continue;

    const msgIndex = 3 - daysBefore;
    const msg = MESSAGES_BEFORE[msgIndex];

    const promise = Notifications.scheduleNotificationAsync({
      content: {
        title: msg.title,
        body: msg.body(daysBefore),
        data: { billId, type: 'reminder' },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        channelId: 'bills',
      },
    }).catch(() => {
      console.warn('[Notificações] Falha ao agendar lembrete.');
    });
    promises.push(promise);
  }

  const dueDayHours = [
    { hour: 9, period: 'morning' as const },
    { hour: 14, period: 'afternoon' as const },
    { hour: 20, period: 'night' as const },
  ];

  for (const { hour, period } of dueDayHours) {
    const triggerDate = new Date(due);
    triggerDate.setHours(hour, 0, 0, 0);

    if (triggerDate <= now) continue;

    const msg = MESSAGES_DUE_DAY[period];
    const promise = Notifications.scheduleNotificationAsync({
      content: {
        title: msg.title,
        body: msg.body,
        data: { billId, type: 'urgent' },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        channelId: 'bills',
      },
    }).catch(() => {
      console.warn('[Notificações] Falha ao agendar lembrete de vencimento.');
    });
    promises.push(promise);
  }

  const results = await Promise.all(promises);
  const scheduledIds = results.filter((id): id is string => typeof id === 'string');
  console.log(`[Notificações] ${scheduledIds.length} lembrete(s) agendado(s).`);
  return scheduledIds;
}

/** Cancel all pending reminders associated with a payable bill instance. */
export async function cancelNotificationsForBill(billId: string): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    const cancelled = await cancelScheduledForBill(billId);
    console.log(`[Notificações] ${cancelled} lembrete(s) cancelado(s).`);
  } catch {
    console.warn('[Notificações] Falha ao cancelar lembretes.');
  }
}

export async function cancelAllNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Notifications.cancelAllScheduledNotificationsAsync();
  console.log('[Notificações] Todos os lembretes foram cancelados.');
}
