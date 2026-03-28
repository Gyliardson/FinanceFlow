import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// ===========================================================================
// Configuração Global de Notificações
// ===========================================================================

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ===========================================================================
// Mensagens Persuasivas
// ===========================================================================

const MESSAGES_BEFORE = [
  {
    title: '📅 Lembrete de Conta',
    body: (name: string, days: number) =>
      `A conta "${name}" vence em ${days} dia${days > 1 ? 's' : ''}. Organize-se para pagar no prazo!`,
  },
  {
    title: '⏰ Conta se Aproximando',
    body: (name: string, days: number) =>
      `Faltam apenas ${days} dia${days > 1 ? 's' : ''} para o vencimento de "${name}". Não deixe para a última hora!`,
  },
  {
    title: '🔔 Atenção com a Conta',
    body: (name: string, days: number) =>
      `"${name}" vence em ${days} dia${days > 1 ? 's' : ''}. Separar o dinheiro agora evita dor de cabeça depois.`,
  },
];

const MESSAGES_DUE_DAY = {
  morning: {
    title: '🚨 VENCE HOJE!',
    body: (name: string) =>
      `A conta "${name}" vence HOJE! Pague agora e evite juros. Depois não diga que não avisamos. 💸`,
  },
  afternoon: {
    title: '⚠️ URGENTE - Último dia!',
    body: (name: string) =>
      `AINDA NÃO PAGOU "${name}"?! O prazo acaba HOJE. Juros começam amanhã. Não vacile! 🔥`,
  },
  night: {
    title: '🔴 ÚLTIMA CHANCE HOJE!',
    body: (name: string) =>
      `"${name}" vence HOJE e você AINDA não registrou o pagamento! Pague AGORA antes que vire dívida com multa! 💀`,
  },
};

// ===========================================================================
// Funções Principais
// ===========================================================================

/**
 * Solicita permissão de notificações ao usuário.
 * Deve ser chamada na inicialização do app.
 */
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

  // Canal Android (obrigatório para Android 8+)
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

/**
 * Agenda todas as notificações para uma fatura específica.
 * 
 * Lógica:
 * - T-3, T-2, T-1: Uma notificação por dia (9h da manhã)
 * - Dia T (vencimento): 3 notificações (9h, 14h, 20h) com tom persuasivo
 * 
 * @param billId - ID da fatura no banco
 * @param billName - Nome/descrição da fatura
 * @param dueDate - Data de vencimento (string YYYY-MM-DD)
 */
export async function scheduleNotificationsForBill(
  billId: string,
  billName: string,
  dueDate: string
): Promise<string[]> {
  if (Platform.OS === 'web') return [];

  const promises: Promise<string | void>[] = [];
  const due = new Date(dueDate + 'T00:00:00');
  const now = new Date();

  // --- Notificações T-3, T-2, T-1 ---
  for (let daysBefore = 3; daysBefore >= 1; daysBefore--) {
    const triggerDate = new Date(due);
    triggerDate.setDate(triggerDate.getDate() - daysBefore);
    triggerDate.setHours(9, 0, 0, 0); // 9h da manhã

    if (triggerDate <= now) continue; // Já passou

    const msgIndex = 3 - daysBefore; // 0, 1, 2
    const msg = MESSAGES_BEFORE[msgIndex];

    const promise = Notifications.scheduleNotificationAsync({
      content: {
        title: msg.title,
        body: msg.body(billName, daysBefore),
        data: { billId, type: 'reminder' },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        channelId: 'bills',
      },
    }).catch(err => {
      console.warn(`Erro ao agendar notificação T-${daysBefore}:`, err);
    });
    promises.push(promise);
  }

  // --- Notificações no dia do vencimento ---
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
        body: msg.body(billName),
        data: { billId, type: 'urgent' },
        sound: 'default',
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: triggerDate,
        channelId: 'bills',
      },
    }).catch(err => {
      console.warn(`Erro ao agendar notificação ${period}:`, err);
    });
    promises.push(promise);
  }

  const results = await Promise.all(promises);
  const scheduledIds = results.filter((id): id is string => typeof id === 'string');

  console.log(`[Notificações] Agendadas ${scheduledIds.length} para "${billName}" (venc: ${dueDate})`);
  return scheduledIds;
}

/**
 * Cancela todas as notificações pendentes de uma fatura específica.
 * Usado quando o pagamento é registrado.
 */
export async function cancelNotificationsForBill(billId: string): Promise<void> {
  if (Platform.OS === 'web') return;

  try {
    const allScheduled = await Notifications.getAllScheduledNotificationsAsync();
    const cancelPromises: Promise<void>[] = [];
    
    for (const notification of allScheduled) {
      if (notification.content.data?.billId === billId) {
        cancelPromises.push(
          Notifications.cancelScheduledNotificationAsync(notification.identifier)
        );
      }
    }
    
    if (cancelPromises.length > 0) {
      await Promise.all(cancelPromises);
    }
    
    console.log(`[Notificações] Canceladas (${cancelPromises.length}) para billId: ${billId}`);
  } catch (err) {
    console.warn('Erro ao cancelar notificações:', err);
  }
}

/**
 * Cancela TODAS as notificações agendadas (útil para debug/reset).
 */
export async function cancelAllNotifications(): Promise<void> {
  if (Platform.OS === 'web') return;
  await Notifications.cancelAllScheduledNotificationsAsync();
  console.log('[Notificações] Todas canceladas.');
}
