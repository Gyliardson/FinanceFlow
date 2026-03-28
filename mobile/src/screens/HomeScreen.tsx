import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl, Alert } from 'react-native';
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

export default function HomeScreen({ navigation }: any) {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  /*
  =============================================================================
  [FUNCIONALIDADE DESATIVADA] - Scraper de Boletos (DAS MEI, TIM, Unopar)
  =============================================================================
  Esta funcionalidade de scraping (busca automática) foi desenvolvida para compor
  o portfólio do projeto, demonstrando a capacidade de construir web scrapers
  complexos integrados ao backend (ex: bypass de captcha, navegação em SPAs).
  
  Por questões de custos de hospedagem (visto que scrapers que utilizam navegadores 
  headless exigem mais memória RAM do que os planos gratuitos do Render, por exemplo, 
  disponibilizam), essas integrações estão desativadas por padrão.

  Caso decida rodar este projeto em uma máquina/VPS com recursos adequados, 
  você pode descomentar a função e o botão abaixo para reativar e utilizar
  a automação sem problemas.
  =============================================================================
  */

  const fetchBills = async () => {
    try {
      const response = await api.get('/bills');
      setBills(response.data.data || []);
    } catch (error) {
      console.error("Erro ao buscar boletos:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchBills();
    });
    return unsubscribe;
  }, [navigation]);

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

  const pendingBills = bills.filter(b => b.status === 'pending' && !b.is_recurring);
  const paidBills = bills.filter(b => b.status === 'paid' || b.status === 'aprovado');
  const recurringTemplates = bills.filter(b => b.is_recurring === true);

  const totalPending = pendingBills.reduce((sum, b) => sum + Number(b.amount), 0);

  const renderBill = ({ item }: { item: Bill }) => {
    const isPaid = item.status === 'paid' || item.status === 'aprovado';
    const daysUntil = getDaysUntilDue(item.due_date);
    const isOverdue = daysUntil !== null && daysUntil < 0 && !isPaid;
    const isUrgent = daysUntil !== null && daysUntil >= 0 && daysUntil <= 3 && !isPaid;

    return (
      <View style={[styles.card, isOverdue && styles.cardOverdue, isPaid && styles.cardPaid]}>
        <View style={styles.cardHeader}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
            {item.is_recurring && (
              <Ionicons name="repeat" size={14} color="#8e44ad" style={{ marginRight: 6 }} />
            )}
            <Text style={styles.cardTitle} numberOfLines={1}>
              {item.description || `Fatura #${item.id.substring(0, 5)}`}
            </Text>
          </View>
          <View style={[
            styles.badge,
            isPaid ? styles.badgePaid : isOverdue ? styles.badgeOverdue : styles.badgePending
          ]}>
            <Text style={styles.badgeText}>
              {isPaid ? 'Pago' : isOverdue ? 'Vencida' : 'Pendente'}
            </Text>
          </View>
        </View>

        <Text style={styles.cardAmount}>R$ {Number(item.amount).toFixed(2)}</Text>

        <View style={styles.cardFooter}>
          <Text style={styles.cardDate}>
            {isPaid && item.payment_date
              ? `Pago em: ${new Date(item.payment_date + 'T00:00:00').toLocaleDateString('pt-BR')}`
              : `Vence: ${item.due_date ? new Date(item.due_date + 'T00:00:00').toLocaleDateString('pt-BR') : 'Não especificada'}`
            }
          </Text>
          {isUrgent && !isPaid && (
            <View style={[styles.urgentTag, daysUntil === 0 && { backgroundColor: '#e74c3c' }]}>
              <Text style={styles.urgentTagText}>
                {daysUntil === 0 ? 'HOJE!' : `${daysUntil}d restante${daysUntil > 1 ? 's' : ''}`}
              </Text>
            </View>
          )}
        </View>

        {item.receipt_url && isPaid && (
          <View style={styles.receiptIndicator}>
            <Ionicons name="document-attach" size={12} color="#27ae60" />
            <Text style={styles.receiptText}>Comprovante salvo</Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header com resumo */}
      <View style={styles.header}>
        <Text style={styles.title}>FinanceFlow</Text>
        <Text style={styles.subtitle}>Suas Faturas</Text>
        {pendingBills.length > 0 && (
          <View style={styles.summaryRow}>
            <Text style={styles.summaryText}>
              {pendingBills.length} pendente{pendingBills.length > 1 ? 's' : ''}
            </Text>
            <Text style={styles.summaryAmount}>
              R$ {totalPending.toFixed(2)}
            </Text>
          </View>
        )}
      </View>

      {/* Ações rápidas */}
      <View style={styles.quickActions}>
        <TouchableOpacity
          style={styles.actionButton}
          onPress={() => navigation.navigate('RecurringBill')}
        >
          <Ionicons name="repeat" size={20} color="#8e44ad" />
          <Text style={styles.actionText}>Conta Recorrente</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, { borderColor: '#27ae60' }]}
          onPress={() => navigation.navigate('Payment')}
        >
          <Ionicons name="wallet" size={20} color="#27ae60" />
          <Text style={[styles.actionText, { color: '#27ae60' }]}>Registrar Pagamento</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color="#3498db" style={styles.loader} />
      ) : (
        <FlatList
          data={[...pendingBills, ...paidBills]}
          keyExtractor={(item) => item.id}
          renderItem={renderBill}
          contentContainerStyle={styles.listContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <Text style={styles.emptyText}>Nenhuma fatura encontrada.{'\n'}Adicione uma tocando no botão abaixo!</Text>
          }
        />
      )}

      <TouchableOpacity 
        style={styles.fab}
        onPress={() => navigation.navigate('Details')}
      >
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa' },
  header: { 
    padding: 16, paddingTop: 45, paddingBottom: 20, backgroundColor: '#3498db', 
    borderBottomLeftRadius: 20, borderBottomRightRadius: 20, elevation: 5 
  },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 16, color: '#f1f2f6', marginTop: 3 },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    marginTop: 12,
  },
  summaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  summaryAmount: { color: '#fff', fontSize: 18, fontWeight: '900' },
  quickActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginTop: 14,
    marginBottom: 6,
  },
  actionButton: {
    flex: 0.48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#8e44ad',
    backgroundColor: '#fff',
    elevation: 2,
  },
  actionText: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: 'bold',
    color: '#8e44ad',
  },
  loader: { flex: 1, justifyContent: 'center' },
  listContainer: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 100 },
  card: { 
    backgroundColor: '#fff', padding: 16, borderRadius: 12, marginBottom: 12, 
    elevation: 3, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    borderLeftWidth: 4, borderLeftColor: '#e74c3c',
  },
  cardPaid: {
    borderLeftColor: '#2ecc71',
    opacity: 0.75,
  },
  cardOverdue: {
    borderLeftColor: '#c0392b',
    backgroundColor: '#fef9f9',
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardTitle: { fontSize: 14, fontWeight: '600', color: '#2c3e50', flex: 1, marginRight: 10 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgePaid: { backgroundColor: '#2ecc71' },
  badgePending: { backgroundColor: '#e74c3c' },
  badgeOverdue: { backgroundColor: '#c0392b' },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: 'bold' },
  cardAmount: { fontSize: 22, fontWeight: 'bold', color: '#2c3e50', marginBottom: 4 },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardDate: { fontSize: 13, color: '#7f8c8d' },
  urgentTag: {
    backgroundColor: '#f39c12',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  urgentTagText: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  receiptIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#ecf0f1',
  },
  receiptText: { fontSize: 11, color: '#27ae60', marginLeft: 5 },
  emptyText: { textAlign: 'center', color: '#7f8c8d', marginTop: 50, fontSize: 16, lineHeight: 24 },
  fab: { 
    position: 'absolute', bottom: 30, right: 30, width: 60, height: 60, borderRadius: 30, 
    backgroundColor: '#3498db', justifyContent: 'center', alignItems: 'center', 
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 3 } 
  }
});
