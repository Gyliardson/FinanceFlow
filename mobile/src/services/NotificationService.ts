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

export async function requestNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === 'web') return false;

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.warn('Permissão de notificações negada pelo usuário.');
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
 * Replace all pending reminders for one payable bill instance.
 *
 * Replacement is deliberate: retries/reconciliation can safely call this function
 * again for the same child bill without multiplying OS notifications. If existing
 * reminders cannot be enumerated/cancelled, scheduling fails closed rather than
 * adding an unknown duplicate set.
 */
export async function scheduleNotificationsForBill(
  billId: string,
  _billName: string,
  dueDate: string
): Promise<string[]> {
  if (Platform.OS === 'web') return [];

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
