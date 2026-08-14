import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../services/AuthContext';
import { getUserCache, setUserCache } from '../services/userCache';
import NetworkStatus from '../components/NetworkStatus';
import api from '../services/api';

interface Bill {
  id: string;
  description: string;
  amount: number;
  due_date: string;
  barcode: string;
  status: string;
  is_recurring: boolean;
  payment_date: string | null;
  receipt_url: string | null;
}

interface SettingsCache {
  initial_balance?: number | null;
  emergency_fund_goal?: number | null;
  initial_balance_date?: string | null;
}

type TabKey = 'pending' | 'paid' | 'all';
type LoadState = 'ready' | 'offline-cache' | 'unavailable';

const MONTH_NAMES = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

const formatBRL = (value: number | string | null | undefined) => {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 'R$ 0,00';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return 'Data não informada';
  return new Date(`${value}T00:00:00`).toLocaleDateString('pt-BR');
};

export default function HomeScreen({ navigation }: any) {
  const { session } = useAuth();
  const userId = session?.user.id;
  const now = new Date();

  const [allBills, setAllBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('pending');
  const [loadState, setLoadState] = useState<LoadState>('ready');
  const [configModalVisible, setConfigModalVisible] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [initialBalance, setInitialBalance] = useState('');
  const [emergencyGoal, setEmergencyGoal] = useState('');
  const [initialDate, setInitialDate] = useState('');
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());

  const hydrateSettings = (settings: SettingsCache) => {
    setInitialBalance(settings.initial_balance?.toFixed(2).replace('.', ',') || '');
    setEmergencyGoal(settings.emergency_fund_goal?.toFixed(2).replace('.', ',') || '');
    setInitialDate(settings.initial_balance_date || '');
  };

  const fetchBills = async () => {
    try {
      const response = await api.get('/bills');
      const bills = response.data?.data || [];
      setAllBills(bills);
      if (userId) await setUserCache(userId, 'bills', bills);
      return { online: true, hasData: true };
    } catch {
      const cached = userId ? await getUserCache<Bill[]>(userId, 'bills') : null;
      if (cached) {
        setAllBills(cached);
        return { online: false, hasData: true };
      }
      setAllBills([]);
      return { online: false, hasData: false };
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await api.get('/settings');
      const settings = response.data?.data as SettingsCache | undefined;
      if (settings) {
        hydrateSettings(settings);
        if (userId) await setUserCache(userId, 'settings', settings);
      } else {
        setConfigModalVisible(true);
      }
      return { online: true, hasData: Boolean(settings) };
    } catch {
      const cached = userId ? await getUserCache<SettingsCache>(userId, 'settings') : null;
      if (cached) {
        hydrateSettings(cached);
        return { online: false, hasData: true };
      }
      return { online: false, hasData: false };
    }
  };

  const loadAllData = useCallback(async () => {
    setLoading(true);
    try {
      const [billsResult, settingsResult] = await Promise.all([fetchBills(), fetchSettings()]);
      const fullyOnline = billsResult.online && settingsResult.online;
      const usableOfflineData = billsResult.hasData || settingsResult.hasData;
      setLoadState(fullyOnline ? 'ready' : usableOfflineData ? 'offline-cache' : 'unavailable');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', loadAllData);
    return unsubscribe;
  }, [navigation, loadAllData]);

  const onRefresh = () => {
    setRefreshing(true);
    loadAllData();
  };

  const formatCurrencyInput = (value: string) => {
    const digits = value.replace(/[^0-9]/g, '');
    if (!digits) return '';
    return (Number(digits) / 100).toFixed(2).replace('.', ',');
  };

  const saveSettings = async () => {
    if (savingSettings) return;
    if (!initialBalance || !emergencyGoal) {
      Alert.alert('Campos obrigatórios', 'Informe o saldo atual e a meta da reserva de emergência.');
      return;
    }

    const balance = Number(initialBalance.replace(',', '.'));
    const goal = Number(emergencyGoal.replace(',', '.'));
    if (!Number.isFinite(balance) || !Number.isFinite(goal)) {
      Alert.alert('Valores inválidos', 'Revise os valores informados antes de salvar.');
      return;
    }

    setSavingSettings(true);
    try {
      await api.post('/settings', {
        initial_balance: balance,
        emergency_fund_goal: goal,
        initial_balance_date: initialDate || new Date().toISOString().split('T')[0],
      });
      setConfigModalVisible(false);
      await loadAllData();
    } catch {
      Alert.alert('Não foi possível salvar', 'Verifique sua conexão e tente novamente. Nenhum valor foi alterado.');
    } finally {
      setSavingSettings(false);
    }
  };

  const getDaysUntilDue = (dueDate: string) => {
    if (!dueDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${dueDate}T00:00:00`);
    return Math.ceil((due.getTime() - today.getTime()) / 86400000);
  };

  const filteredByDate = useMemo(() => allBills.filter((bill) => {
    if (bill.is_recurring || !bill.due_date) return false;
    const due = new Date(`${bill.due_date}T00:00:00`);
    return due.getMonth() === selectedMonth && due.getFullYear() === selectedYear;
  }), [allBills, selectedMonth, selectedYear]);

  const pendingBills = useMemo(
    () => filteredByDate.filter((bill) => bill.status === 'pending' || bill.status === 'overdue'),
    [filteredByDate],
  );
  const paidBills = useMemo(
    () => filteredByDate.filter((bill) => bill.status === 'paid' || bill.status === 'aprovado'),
    [filteredByDate],
  );

  const displayedBills = activeTab === 'pending'
    ? pendingBills
    : activeTab === 'paid'
      ? paidBills
      : filteredByDate;

  const sortedBills = useMemo(() => [...displayedBills].sort((a, b) => {
    if (activeTab === 'paid') {
      return new Date(b.payment_date || b.due_date).getTime() - new Date(a.payment_date || a.due_date).getTime();
    }
    return (getDaysUntilDue(a.due_date) ?? 999) - (getDaysUntilDue(b.due_date) ?? 999);
  }), [displayedBills, activeTab]);

  const totalPending = pendingBills.reduce((sum, bill) => sum + Number(bill.amount), 0);
  const totalPaid = paidBills.reduce((sum, bill) => sum + Number(bill.amount), 0);
  const overdueBills = pendingBills.filter((bill) => (getDaysUntilDue(bill.due_date) ?? 0) < 0);

  const goToPrevMonth = () => {
    if (selectedMonth === 0) {
      setSelectedMonth(11);
      setSelectedYear((year) => year - 1);
    } else {
      setSelectedMonth((month) => month - 1);
    }
  };

  const goToNextMonth = () => {
    if (selectedMonth === 11) {
      setSelectedMonth(0);
      setSelectedYear((year) => year + 1);
    } else {
      setSelectedMonth((month) => month + 1);
    }
  };

  const goToCurrentMonth = () => {
    const current = new Date();
    setSelectedMonth(current.getMonth());
    setSelectedYear(current.getFullYear());
  };

  const isCurrentMonth = selectedMonth === now.getMonth() && selectedYear === now.getFullYear();
  const selectedPeriod = `${MONTH_NAMES[selectedMonth]} ${selectedYear}`;

  const renderBill = ({ item }: { item: Bill }) => {
    const isPaid = item.status === 'paid' || item.status === 'aprovado';
    const daysUntil = getDaysUntilDue(item.due_date);
    const isOverdue = daysUntil !== null && daysUntil < 0 && !isPaid;
    const isUrgent = daysUntil !== null && daysUntil >= 0 && daysUntil <= 3 && !isPaid;
    const statusLabel = isPaid ? 'Pago' : isOverdue ? 'Vencida' : 'Pendente';
    const description = item.description || `Fatura ${item.id.substring(0, 5)}`;

    return (
      <TouchableOpacity
        style={[styles.card, isPaid && styles.cardPaid, isOverdue && styles.cardOverdue]}
        activeOpacity={0.75}
        onPress={() => navigation.navigate('BillHistory', { billId: item.id })}
        accessibilityRole="button"
        accessibilityLabel={`${description}. ${formatBRL(item.amount)}. Status ${statusLabel}. ${isPaid && item.payment_date ? `Pago em ${formatDate(item.payment_date)}` : `Vence em ${formatDate(item.due_date)}`}`}
        accessibilityHint="Abre os detalhes e o histórico desta fatura"
      >
        <View style={[styles.cardIcon, isPaid ? styles.cardIconPaid : isOverdue ? styles.cardIconOverdue : styles.cardIconPending]}>
          <Ionicons accessibilityElementsHidden name={isPaid ? 'checkmark' : isOverdue ? 'alert' : 'time'} size={18} color="#fff" />
        </View>

        <View style={styles.cardCenter}>
          <Text style={styles.cardTitle} numberOfLines={2}>{description}</Text>
          <Text style={styles.cardDate}>
            {isPaid && item.payment_date ? `Pago em ${formatDate(item.payment_date)}` : `Vence ${formatDate(item.due_date)}`}
          </Text>
          <Text style={styles.cardStatus}>{statusLabel}</Text>
        </View>

        <View style={styles.cardRight}>
          <Text style={[styles.cardAmount, isPaid && styles.cardAmountPaid]} numberOfLines={1} adjustsFontSizeToFit>
            {formatBRL(item.amount)}
          </Text>
          {isUrgent && !isPaid && <Text style={styles.urgentText}>{daysUntil === 0 ? 'Vence hoje' : `Vence em ${daysUntil} dias`}</Text>}
          {isOverdue && <Text style={styles.overdueText}>Pagamento atrasado</Text>}
          {isPaid && item.receipt_url && <Text style={styles.receiptText}>Comprovante disponível</Text>}
        </View>
        <Ionicons accessibilityElementsHidden name="chevron-forward" size={16} color="#94a3b8" />
      </TouchableOpacity>
    );
  };

  const tabConfig: { key: TabKey; label: string; count: number; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'pending', label: 'A pagar', count: pendingBills.length, icon: 'alert-circle' },
    { key: 'paid', label: 'Pagas', count: paidBills.length, icon: 'checkmark-circle' },
    { key: 'all', label: 'Todas', count: filteredByDate.length, icon: 'list' },
  ];

  const quickActions = [
    { label: 'Rendas', icon: 'cash' as const, route: 'Income', hint: 'Abre o controle de rendas' },
    { label: 'Saúde', icon: 'heart' as const, route: 'Insights', hint: 'Abre os indicadores financeiros' },
    { label: 'Fixas', icon: 'repeat' as const, route: 'RecurringBill', hint: 'Abre as faturas recorrentes' },
    { label: 'Nova', icon: 'add' as const, route: 'Details', hint: 'Cria uma nova fatura' },
  ];

  const renderHeader = () => (
    <View>
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerCopy}>
            <Text accessibilityRole="header" style={styles.title}>FinanceFlow</Text>
            <Text style={styles.subtitle}>Visão financeira de {selectedPeriod}</Text>
          </View>
          <TouchableOpacity
            style={styles.settingsBtn}
            onPress={() => setConfigModalVisible(true)}
            accessibilityRole="button"
            accessibilityLabel="Abrir configurações financeiras"
            accessibilityHint="Permite editar saldo inicial e meta de reserva"
          >
            <Ionicons accessibilityElementsHidden name="settings-sharp" size={22} color="#fff" />
          </TouchableOpacity>
        </View>

        <View style={styles.summaryRow} accessible accessibilityLabel={`${pendingBills.length} pendentes, total ${formatBRL(totalPending)}. ${paidBills.length} pagas, total ${formatBRL(totalPaid)}.`}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{pendingBills.length} pendente{pendingBills.length !== 1 ? 's' : ''}</Text>
            <Text style={styles.summaryValue} numberOfLines={1} adjustsFontSizeToFit>{formatBRL(totalPending)}</Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>{paidBills.length} paga{paidBills.length !== 1 ? 's' : ''}</Text>
            <Text style={[styles.summaryValue, styles.summaryPaid]} numberOfLines={1} adjustsFontSizeToFit>{formatBRL(totalPaid)}</Text>
          </View>
        </View>

        {overdueBills.length > 0 && (
          <View style={styles.overdueAlert} accessibilityLiveRegion="polite">
            <Ionicons accessibilityElementsHidden name="warning" size={15} color="#fff" />
            <Text style={styles.overdueAlertText}>{overdueBills.length} conta{overdueBills.length !== 1 ? 's' : ''} vencida{overdueBills.length !== 1 ? 's' : ''}</Text>
          </View>
        )}
      </View>

      <NetworkStatus isOffline={loadState === 'offline-cache'} onRetry={loadAllData} />

      <View style={styles.monthFilter} accessibilityLabel={`Período selecionado: ${selectedPeriod}`}>
        <TouchableOpacity
          onPress={goToPrevMonth}
          style={styles.monthArrow}
          accessibilityRole="button"
          accessibilityLabel="Mês anterior"
        >
          <Ionicons accessibilityElementsHidden name="chevron-back" size={20} color="#4f46e5" />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={goToCurrentMonth}
          style={styles.monthLabel}
          accessibilityRole="button"
          accessibilityLabel={`${selectedPeriod}${isCurrentMonth ? ', mês atual' : ', tocar para voltar ao mês atual'}`}
        >
          <Text style={styles.monthText}>{selectedPeriod}</Text>
          {!isCurrentMonth && <Text style={styles.monthReset}>Voltar para este mês</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={goToNextMonth}
          style={styles.monthArrow}
          accessibilityRole="button"
          accessibilityLabel="Próximo mês"
        >
          <Ionicons accessibilityElementsHidden name="chevron-forward" size={20} color="#4f46e5" />
        </TouchableOpacity>
      </View>

      <View style={styles.tabBar} accessibilityRole="tablist">
        {tabConfig.map((tab) => {
          const selected = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, selected && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={`${tab.label}, ${tab.count} item${tab.count === 1 ? '' : 's'}`}
            >
              <Ionicons accessibilityElementsHidden name={tab.icon} size={15} color={selected ? '#4338ca' : '#64748b'} />
              <Text style={[styles.tabText, selected && styles.tabTextActive]}>{tab.label}</Text>
              <Text style={[styles.tabCount, selected && styles.tabCountActive]}>{tab.count}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.quickActions} accessibilityLabel="Atalhos financeiros">
        {quickActions.map((action) => (
          <TouchableOpacity
            key={action.route}
            style={styles.quickBtn}
            onPress={() => navigation.navigate(action.route)}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={action.hint}
          >
            <Ionicons accessibilityElementsHidden name={action.icon} size={18} color="#4338ca" />
            <Text style={styles.quickBtnText}>{action.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.stateContainer} accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color="#4f46e5" />
        <Text style={styles.stateTitle}>Carregando seu mês</Text>
        <Text style={styles.stateText}>Buscando faturas e configurações financeiras.</Text>
      </View>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <View style={styles.stateContainer} accessibilityLiveRegion="assertive">
        <Ionicons accessibilityElementsHidden name="cloud-offline-outline" size={52} color="#64748b" />
        <Text style={styles.stateTitle}>Não foi possível carregar seus dados</Text>
        <Text style={styles.stateText}>Não há cache disponível para esta conta. Verifique sua conexão e tente novamente.</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={loadAllData}
          accessibilityRole="button"
          accessibilityLabel="Tentar carregar os dados novamente"
        >
          <Ionicons accessibilityElementsHidden name="refresh" size={18} color="#fff" />
          <Text style={styles.retryButtonText}>Tentar novamente</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={sortedBills}
        keyExtractor={(item) => item.id}
        renderItem={renderBill}
        ListHeaderComponent={renderHeader}
        contentContainerStyle={styles.listContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#4f46e5']} />}
        ListEmptyComponent={
          <View style={styles.emptyContainer} accessibilityLiveRegion="polite">
            <Ionicons accessibilityElementsHidden name={activeTab === 'paid' ? 'checkmark-done-circle-outline' : 'file-tray-outline'} size={48} color="#94a3b8" />
            <Text style={styles.emptyTitle}>{activeTab === 'pending' ? 'Nada para pagar neste mês' : activeTab === 'paid' ? 'Nenhum pagamento neste mês' : 'Nenhuma fatura neste mês'}</Text>
            <Text style={styles.emptyText}>{activeTab === 'pending' ? `Não há faturas pendentes em ${selectedPeriod}.` : activeTab === 'paid' ? `Nenhum pagamento foi registrado em ${selectedPeriod}.` : `Nenhuma fatura foi encontrada em ${selectedPeriod}.`}</Text>
          </View>
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('Details')}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Adicionar nova fatura"
        accessibilityHint="Abre o formulário de criação de fatura"
      >
        <Ionicons accessibilityElementsHidden name="add" size={28} color="#fff" />
      </TouchableOpacity>

      <Modal visible={configModalVisible} animationType="slide" transparent onRequestClose={() => !savingSettings && setConfigModalVisible(false)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.modalOverlay}>
          <View style={styles.modalContainer} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.modalTitle}>Configurações financeiras</Text>
            <Text style={styles.modalSub}>Defina o saldo inicial e a meta da reserva de emergência.</Text>

            <Text style={styles.modalLabel}>Saldo atual</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.currencyPrefix}>R$</Text>
              <TextInput
                style={styles.modalInputAmount}
                keyboardType="decimal-pad"
                placeholder="0,00"
                value={initialBalance}
                onChangeText={(text) => setInitialBalance(formatCurrencyInput(text))}
                accessibilityLabel="Saldo atual em reais"
                returnKeyType="next"
              />
            </View>

            <Text style={styles.modalLabel}>Meta da reserva de emergência</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.currencyPrefix}>R$</Text>
              <TextInput
                style={styles.modalInputAmount}
                keyboardType="decimal-pad"
                placeholder="0,00"
                value={emergencyGoal}
                onChangeText={(text) => setEmergencyGoal(formatCurrencyInput(text))}
                accessibilityLabel="Meta da reserva de emergência em reais"
                returnKeyType="done"
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setConfigModalVisible(false)}
                disabled={savingSettings}
                accessibilityRole="button"
                accessibilityState={{ disabled: savingSettings }}
              >
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtn, savingSettings && styles.buttonDisabled]}
                onPress={saveSettings}
                disabled={savingSettings}
                accessibilityRole="button"
                accessibilityLabel="Salvar configurações financeiras"
                accessibilityState={{ disabled: savingSettings, busy: savingSettings }}
              >
                {savingSettings ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalBtnText}>Salvar</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f1f5f9' },
  stateContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: '#f8fafc' },
  stateTitle: { marginTop: 16, fontSize: 20, lineHeight: 26, fontWeight: '800', color: '#0f172a', textAlign: 'center' },
  stateText: { marginTop: 8, fontSize: 14, lineHeight: 21, color: '#475569', textAlign: 'center' },
  retryButton: { minHeight: 48, marginTop: 20, borderRadius: 12, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#4f46e5' },
  retryButtonText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  header: { marginHorizontal: -16, marginTop: -8, paddingHorizontal: 20, paddingTop: 42, paddingBottom: 20, backgroundColor: '#4338ca', borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 16 },
  headerCopy: { flex: 1 },
  title: { fontSize: 26, fontWeight: '900', color: '#fff', letterSpacing: -0.5 },
  subtitle: { fontSize: 13, lineHeight: 19, color: '#e0e7ff', marginTop: 2 },
  settingsBtn: { width: 48, height: 48, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.16)', justifyContent: 'center', alignItems: 'center' },
  summaryRow: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 12, alignItems: 'center' },
  summaryCard: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  summaryDivider: { width: 1, height: 38, backgroundColor: 'rgba(255,255,255,0.24)' },
  summaryLabel: { color: '#e0e7ff', fontSize: 12, fontWeight: '600', marginBottom: 3 },
  summaryValue: { width: '100%', textAlign: 'center', color: '#fff', fontSize: 18, fontWeight: '900' },
  summaryPaid: { color: '#d1fae5' },
  overdueAlert: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 10, backgroundColor: '#991b1b', paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10 },
  overdueAlertText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  monthFilter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 14, backgroundColor: '#fff', borderRadius: 14, paddingVertical: 4, paddingHorizontal: 4 },
  monthArrow: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  monthLabel: { flex: 1, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  monthText: { fontSize: 16, fontWeight: '800', color: '#1e293b' },
  monthReset: { fontSize: 11, color: '#4338ca', fontWeight: '700', marginTop: 2 },
  tabBar: { flexDirection: 'row', marginTop: 10, backgroundColor: '#fff', borderRadius: 14, padding: 4 },
  tab: { flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderRadius: 10, gap: 4 },
  tabActive: { backgroundColor: '#eef2ff' },
  tabText: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  tabTextActive: { color: '#4338ca', fontWeight: '800' },
  tabCount: { minWidth: 20, textAlign: 'center', fontSize: 11, fontWeight: '800', color: '#475569' },
  tabCountActive: { color: '#4338ca' },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10, marginBottom: 4 },
  quickBtn: { minHeight: 48, flexGrow: 1, flexBasis: '45%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 12, gap: 7 },
  quickBtnText: { fontSize: 12, fontWeight: '800', color: '#334155' },
  listContainer: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 110 },
  card: { minHeight: 82, flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 14, borderRadius: 14, marginBottom: 8, gap: 10 },
  cardPaid: { backgroundColor: '#f8fafc' },
  cardOverdue: { backgroundColor: '#fff7f7', borderWidth: 1, borderColor: '#fecaca' },
  cardIcon: { width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  cardIconPending: { backgroundColor: '#a16207' },
  cardIconPaid: { backgroundColor: '#047857' },
  cardIconOverdue: { backgroundColor: '#b91c1c' },
  cardCenter: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 14, lineHeight: 19, fontWeight: '800', color: '#1e293b' },
  cardDate: { fontSize: 11, lineHeight: 16, color: '#64748b', marginTop: 3 },
  cardStatus: { fontSize: 11, lineHeight: 16, color: '#475569', fontWeight: '700', marginTop: 1 },
  cardRight: { maxWidth: '38%', alignItems: 'flex-end' },
  cardAmount: { width: '100%', textAlign: 'right', fontSize: 15, fontWeight: '900', color: '#1e293b' },
  cardAmountPaid: { color: '#475569' },
  urgentText: { marginTop: 4, fontSize: 10, lineHeight: 14, fontWeight: '800', color: '#92400e', textAlign: 'right' },
  overdueText: { marginTop: 4, fontSize: 10, lineHeight: 14, fontWeight: '800', color: '#991b1b', textAlign: 'right' },
  receiptText: { marginTop: 4, fontSize: 10, lineHeight: 14, fontWeight: '700', color: '#047857', textAlign: 'right' },
  emptyContainer: { alignItems: 'center', marginTop: 42, paddingHorizontal: 20 },
  emptyTitle: { marginTop: 12, fontSize: 17, fontWeight: '800', color: '#334155', textAlign: 'center' },
  emptyText: { textAlign: 'center', color: '#64748b', marginTop: 6, fontSize: 14, lineHeight: 21 },
  fab: { position: 'absolute', bottom: 28, right: 24, width: 58, height: 58, borderRadius: 18, backgroundColor: '#4338ca', justifyContent: 'center', alignItems: 'center', elevation: 8, shadowColor: '#312e81', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.58)', justifyContent: 'center', padding: 20 },
  modalContainer: { backgroundColor: '#fff', borderRadius: 20, padding: 24, elevation: 10 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#1e293b', marginBottom: 8 },
  modalSub: { fontSize: 13, color: '#64748b', marginBottom: 12, lineHeight: 19 },
  modalLabel: { fontSize: 13, fontWeight: '700', color: '#475569', marginBottom: 6, marginTop: 12 },
  inputWrapper: { minHeight: 52, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, paddingLeft: 12 },
  currencyPrefix: { fontSize: 15, fontWeight: '700', color: '#64748b', marginRight: 4 },
  modalInputAmount: { flex: 1, minHeight: 52, paddingHorizontal: 10, fontSize: 16, color: '#1e293b' },
  modalActions: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 24, gap: 12 },
  cancelBtn: { flex: 1, minHeight: 48, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' },
  cancelBtnText: { color: '#475569', fontWeight: '800' },
  modalBtn: { flex: 2, minHeight: 48, backgroundColor: '#4338ca', paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  buttonDisabled: { opacity: 0.65 },
});