import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, RefreshControl, Animated
} from 'react-native';
import api from '../services/api';
import { Ionicons } from '@expo/vector-icons';

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

type TabKey = 'pending' | 'paid' | 'all';

const MONTH_NAMES = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'
];

export default function HomeScreen({ navigation }: any) {
  const [allBills, setAllBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('pending');

  // Filter state
  const now = new Date();
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());

  const fetchBills = useCallback(async () => {
    try {
      const response = await api.get('/bills');
      setAllBills(response.data.data || []);
    } catch (error) {
      console.error("Erro ao buscar boletos:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchBills();
    });
    return unsubscribe;
  }, [navigation, fetchBills]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchBills();
  };

  const getDaysUntilDue = (dueDate: string) => {
    if (!dueDate) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate + 'T00:00:00');
    return Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };

  // ---------- Filtering Logic ----------
  const filteredByDate = allBills.filter(b => {
    if (b.is_recurring) return false; // Hide recurring templates
    if (!b.due_date) return false;
    const d = new Date(b.due_date + 'T00:00:00');
    return d.getMonth() === selectedMonth && d.getFullYear() === selectedYear;
  });

  const pendingBills = filteredByDate.filter(
    b => b.status === 'pending' || b.status === 'overdue'
  );
  const paidBills = filteredByDate.filter(
    b => b.status === 'paid' || b.status === 'aprovado'
  );

  const displayedBills = activeTab === 'pending'
    ? pendingBills
    : activeTab === 'paid'
      ? paidBills
      : filteredByDate;

  // Sort: overdue first, then by due_date asc for pending; newest first for paid
  const sortedBills = [...displayedBills].sort((a, b) => {
    if (activeTab === 'paid') {
      return new Date(b.payment_date || b.due_date).getTime() -
             new Date(a.payment_date || a.due_date).getTime();
    }
    const daysA = getDaysUntilDue(a.due_date) ?? 999;
    const daysB = getDaysUntilDue(b.due_date) ?? 999;
    return daysA - daysB;
  });

  // Summary calculations
  const totalPending = pendingBills.reduce((sum, b) => sum + Number(b.amount), 0);
  const totalPaid = paidBills.reduce((sum, b) => sum + Number(b.amount), 0);
  const overdueBills = pendingBills.filter(b => {
    const d = getDaysUntilDue(b.due_date);
    return d !== null && d < 0;
  });

  // ---------- Month Navigation ----------
  const goToPrevMonth = () => {
    if (selectedMonth === 0) {
      setSelectedMonth(11);
      setSelectedYear(y => y - 1);
    } else {
      setSelectedMonth(m => m - 1);
    }
  };

  const goToNextMonth = () => {
    if (selectedMonth === 11) {
      setSelectedMonth(0);
      setSelectedYear(y => y + 1);
    } else {
      setSelectedMonth(m => m + 1);
    }
  };

  const goToCurrentMonth = () => {
    const n = new Date();
    setSelectedMonth(n.getMonth());
    setSelectedYear(n.getFullYear());
  };

  const isCurrentMonth = selectedMonth === now.getMonth() && selectedYear === now.getFullYear();

  // ---------- Render ----------

  const renderBill = ({ item }: { item: Bill }) => {
    const isPaid = item.status === 'paid' || item.status === 'aprovado';
    const daysUntil = getDaysUntilDue(item.due_date);
    const isOverdue = daysUntil !== null && daysUntil < 0 && !isPaid;
    const isUrgent = daysUntil !== null && daysUntil >= 0 && daysUntil <= 3 && !isPaid;

    return (
      <TouchableOpacity
        style={[
          styles.card,
          isPaid && styles.cardPaid,
          isOverdue && styles.cardOverdue,
        ]}
        activeOpacity={0.75}
        onPress={() => navigation.navigate('BillHistory', { billId: item.id })}
      >
        <View style={styles.cardLeft}>
          <View style={[
            styles.cardIcon,
            isPaid ? styles.cardIconPaid : isOverdue ? styles.cardIconOverdue : styles.cardIconPending
          ]}>
            <Ionicons
              name={isPaid ? 'checkmark' : isOverdue ? 'alert' : 'time'}
              size={18}
              color="#fff"
            />
          </View>
        </View>

        <View style={styles.cardCenter}>
          <View style={styles.cardTitleRow}>
            {item.is_recurring && (
              <Ionicons name="repeat" size={12} color="#8b5cf6" style={{ marginRight: 4 }} />
            )}
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.description || `Fatura #${item.id.substring(0, 5)}`}
            </Text>
          </View>

          <Text style={styles.cardDate}>
            {isPaid && item.payment_date
              ? `Pago em ${new Date(item.payment_date + 'T00:00:00').toLocaleDateString('pt-BR')}`
              : `Vence ${item.due_date ? new Date(item.due_date + 'T00:00:00').toLocaleDateString('pt-BR') : '-'}`
            }
          </Text>
        </View>

        <View style={styles.cardRight}>
          <Text style={[styles.cardAmount, isPaid && { color: '#64748b' }]}>
            R$ {Number(item.amount).toFixed(2)}
          </Text>

          {isUrgent && !isPaid && (
            <View style={[styles.urgentBadge, daysUntil === 0 && { backgroundColor: '#ef4444' }]}>
              <Text style={styles.urgentBadgeText}>
                {daysUntil === 0 ? 'HOJE' : `${daysUntil}d`}
              </Text>
            </View>
          )}

          {isOverdue && (
            <View style={[styles.urgentBadge, { backgroundColor: '#ef4444' }]}>
              <Text style={styles.urgentBadgeText}>Vencida</Text>
            </View>
          )}

          {isPaid && item.receipt_url && (
            <View style={styles.receiptDot}>
              <Ionicons name="attach" size={12} color="#10b981" />
            </View>
          )}
        </View>

        <Ionicons name="chevron-forward" size={16} color="#cbd5e1" style={{ marginLeft: 4 }} />
      </TouchableOpacity>
    );
  };

  const tabConfig: { key: TabKey; label: string; count: number; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: 'pending', label: 'A Pagar', count: pendingBills.length, icon: 'alert-circle' },
    { key: 'paid', label: 'Pagas', count: paidBills.length, icon: 'checkmark-circle' },
    { key: 'all', label: 'Todas', count: filteredByDate.length, icon: 'list' },
  ];

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.title}>FinanceFlow</Text>
            <Text style={styles.subtitle}>Controle Financeiro</Text>
          </View>
        </View>

        {/* Summary Cards */}
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>
              {pendingBills.length} pendente{pendingBills.length !== 1 ? 's' : ''}
            </Text>
            <Text style={styles.summaryValue}>
              R$ {totalPending.toFixed(2)}
            </Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryCard}>
            <Text style={styles.summaryLabel}>
              {paidBills.length} paga{paidBills.length !== 1 ? 's' : ''}
            </Text>
            <Text style={[styles.summaryValue, { color: '#a7f3d0' }]}>
              R$ {totalPaid.toFixed(2)}
            </Text>
          </View>
        </View>

        {overdueBills.length > 0 && (
          <View style={styles.overdueAlert}>
            <Ionicons name="warning" size={14} color="#fef2f2" />
            <Text style={styles.overdueAlertText}>
              {overdueBills.length} conta{overdueBills.length > 1 ? 's' : ''} vencida{overdueBills.length > 1 ? 's' : ''}!
            </Text>
          </View>
        )}
      </View>

      {/* Month Filter */}
      <View style={styles.monthFilter}>
        <TouchableOpacity onPress={goToPrevMonth} style={styles.monthArrow}>
          <Ionicons name="chevron-back" size={20} color="#6366f1" />
        </TouchableOpacity>

        <TouchableOpacity onPress={goToCurrentMonth} style={styles.monthLabel}>
          <Text style={styles.monthText}>
            {MONTH_NAMES[selectedMonth]} {selectedYear}
          </Text>
          {!isCurrentMonth && (
            <Text style={styles.monthReset}>Ir para hoje</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={goToNextMonth} style={styles.monthArrow}>
          <Ionicons name="chevron-forward" size={20} color="#6366f1" />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        {tabConfig.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Ionicons
              name={tab.icon}
              size={14}
              color={activeTab === tab.key ? '#6366f1' : '#94a3b8'}
            />
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
            {tab.count > 0 && (
              <View style={[styles.tabBadge, activeTab === tab.key && styles.tabBadgeActive]}>
                <Text style={[styles.tabBadgeText, activeTab === tab.key && styles.tabBadgeTextActive]}>
                  {tab.count}
                </Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Quick Actions */}
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.quickBtn}
          onPress={() => navigation.navigate('RecurringBill')}
        >
          <View style={[styles.quickBtnIcon, { backgroundColor: '#f5f3ff' }]}>
            <Ionicons name="repeat" size={16} color="#8b5cf6" />
          </View>
          <Text style={styles.quickBtnText}>Recorrente</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.quickBtn}
          onPress={() => navigation.navigate('Payment')}
        >
          <View style={[styles.quickBtnIcon, { backgroundColor: '#ecfdf5' }]}>
            <Ionicons name="wallet" size={16} color="#10b981" />
          </View>
          <Text style={styles.quickBtnText}>Pagar</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.quickBtn}
          onPress={() => navigation.navigate('Details')}
        >
          <View style={[styles.quickBtnIcon, { backgroundColor: '#eff6ff' }]}>
            <Ionicons name="add" size={16} color="#3b82f6" />
          </View>
          <Text style={styles.quickBtnText}>Nova</Text>
        </TouchableOpacity>
      </View>

      {/* Bill List */}
      {loading ? (
        <ActivityIndicator size="large" color="#6366f1" style={styles.loader} />
      ) : (
        <FlatList
          data={sortedBills}
          keyExtractor={(item) => item.id}
          renderItem={renderBill}
          contentContainerStyle={styles.listContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#6366f1']} />}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Ionicons
                name={activeTab === 'paid' ? 'checkmark-done-circle-outline' : 'file-tray-outline'}
                size={48}
                color="#cbd5e1"
              />
              <Text style={styles.emptyText}>
                {activeTab === 'pending'
                  ? `Nenhuma conta pendente\nem ${MONTH_NAMES[selectedMonth]}/${selectedYear}.`
                  : activeTab === 'paid'
                    ? `Nenhum pagamento registrado\nem ${MONTH_NAMES[selectedMonth]}/${selectedYear}.`
                    : `Nenhuma fatura em\n${MONTH_NAMES[selectedMonth]}/${selectedYear}.`
                }
              </Text>
            </View>
          }
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={styles.fab}
        onPress={() => navigation.navigate('Details')}
        activeOpacity={0.85}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },

  // Header
  header: {
    paddingHorizontal: 20,
    paddingTop: 45,
    paddingBottom: 20,
    backgroundColor: '#4f46e5',
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    elevation: 8,
    shadowColor: '#4f46e5',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#c7d2fe',
    marginTop: 2,
  },
  summaryRow: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  summaryCard: {
    flex: 1,
    alignItems: 'center',
  },
  summaryDivider: {
    width: 1,
    height: 30,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  summaryLabel: {
    color: '#c7d2fe',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  summaryValue: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
  },
  overdueAlert: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 10,
    backgroundColor: 'rgba(239,68,68,0.25)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  overdueAlertText: {
    color: '#fecaca',
    fontSize: 12,
    fontWeight: '700',
  },

  // Month Filter
  monthFilter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
    marginHorizontal: 16,
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 6,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  monthArrow: {
    padding: 8,
  },
  monthLabel: {
    flex: 1,
    alignItems: 'center',
  },
  monthText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#1e293b',
    textTransform: 'capitalize',
  },
  monthReset: {
    fontSize: 10,
    color: '#6366f1',
    fontWeight: '600',
    marginTop: 1,
  },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 4,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    gap: 4,
  },
  tabActive: {
    backgroundColor: '#eef2ff',
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94a3b8',
  },
  tabTextActive: {
    color: '#6366f1',
    fontWeight: '800',
  },
  tabBadge: {
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    minWidth: 18,
    alignItems: 'center',
  },
  tabBadgeActive: {
    backgroundColor: '#c7d2fe',
  },
  tabBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#64748b',
  },
  tabBadgeTextActive: {
    color: '#4f46e5',
  },

  // Quick Actions
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 10,
    marginBottom: 4,
  },
  quickBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    elevation: 1,
    gap: 6,
  },
  quickBtnIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
  },

  // Cards
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    padding: 14,
    borderRadius: 14,
    marginBottom: 8,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  cardPaid: {
    opacity: 0.7,
  },
  cardOverdue: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  cardLeft: {
    marginRight: 12,
  },
  cardIcon: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIconPending: {
    backgroundColor: '#f59e0b',
  },
  cardIconPaid: {
    backgroundColor: '#10b981',
  },
  cardIconOverdue: {
    backgroundColor: '#ef4444',
  },
  cardCenter: {
    flex: 1,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e293b',
    flex: 1,
  },
  cardDate: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 3,
  },
  cardRight: {
    alignItems: 'flex-end',
    marginLeft: 8,
  },
  cardAmount: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1e293b',
  },
  urgentBadge: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginTop: 4,
  },
  urgentBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '800',
  },
  receiptDot: {
    marginTop: 4,
  },

  // List
  listContainer: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 100,
  },
  loader: {
    flex: 1,
    justifyContent: 'center',
  },
  emptyContainer: {
    alignItems: 'center',
    marginTop: 50,
    paddingHorizontal: 20,
  },
  emptyText: {
    textAlign: 'center',
    color: '#94a3b8',
    marginTop: 12,
    fontSize: 14,
    lineHeight: 22,
  },

  // FAB
  fab: {
    position: 'absolute',
    bottom: 28,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: '#6366f1',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
    shadowColor: '#6366f1',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
});
