import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  Image, TouchableOpacity, Dimensions, Linking
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

interface BillDetail {
  id: string;
  description: string;
  amount: number;
  due_date: string;
  barcode: string | null;
  status: string;
  payment_date: string | null;
  receipt_url: string | null;
  is_recurring: boolean;
  parent_bill_id: string | null;
}

const { width } = Dimensions.get('window');

export default function BillHistoryScreen({ route, navigation }: any) {
  const { billId } = route.params;
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [history, setHistory] = useState<BillDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    fetchDetail();
  }, []);

  const fetchDetail = async () => {
    try {
      const response = await api.get(`/bills/${billId}/detail`);
      setBill(response.data.bill);
      setHistory(response.data.history || []);
    } catch (error) {
      console.error('Erro ao buscar detalhes:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('pt-BR');
  };

  const getStatusConfig = (status: string, dueDate: string) => {
    const isPaid = status === 'paid' || status === 'aprovado';
    if (isPaid) {
      return { label: 'Pago', color: '#10b981', bg: '#ecfdf5', icon: 'checkmark-circle' as const };
    }

    // Se não pago, checar se está vencido pela data
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate + 'T00:00:00');

    if (due < today || status === 'overdue') {
      return { label: 'Vencida', color: '#ef4444', bg: '#fef2f2', icon: 'alert-circle' as const };
    }

    return { label: 'Pendente', color: '#f59e0b', bg: '#fffbeb', icon: 'time' as const };
  };

  const getDaysUntilDue = (dueDate: string) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate + 'T00:00:00');
    return Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.loadingText}>Carregando detalhes...</Text>
      </View>
    );
  }

  if (!bill) {
    return (
      <View style={styles.loadingContainer}>
        <Ionicons name="alert-circle" size={48} color="#ef4444" />
        <Text style={styles.errorText}>Fatura não encontrada</Text>
      </View>
    );
  }

  const isPaid = bill.status === 'paid' || bill.status === 'aprovado';
  const statusConfig = getStatusConfig(bill.status, bill.due_date);
  const daysUntil = getDaysUntilDue(bill.due_date);
  const isOverdue = daysUntil < 0 && !isPaid;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Hero Card */}
      <View style={[styles.heroCard, { borderColor: statusConfig.color }]}>
        <View style={styles.heroHeader}>
          <View style={[styles.statusChip, { backgroundColor: statusConfig.bg }]}>
            <Ionicons name={statusConfig.icon} size={14} color={statusConfig.color} />
            <Text style={[styles.statusChipText, { color: statusConfig.color }]}>
              {statusConfig.label}
            </Text>
          </View>
          {bill.is_recurring && (
            <View style={styles.recurringChip}>
              <Ionicons name="repeat" size={12} color="#8b5cf6" />
              <Text style={styles.recurringChipText}>Recorrente</Text>
            </View>
          )}
        </View>

        <Text style={styles.heroTitle}>{bill.description}</Text>

        <Text style={styles.heroAmount}>
          R$ {Number(bill.amount).toFixed(2)}
        </Text>

        <View style={styles.heroDivider} />

        <View style={styles.heroInfoRow}>
          <View style={styles.heroInfoItem}>
            <Ionicons name="calendar-outline" size={16} color="#94a3b8" />
            <Text style={styles.heroInfoLabel}>Vencimento</Text>
            <Text style={styles.heroInfoValue}>{formatDate(bill.due_date)}</Text>
          </View>
          {isPaid && bill.payment_date && (
            <View style={styles.heroInfoItem}>
              <Ionicons name="checkmark-done-outline" size={16} color="#10b981" />
              <Text style={styles.heroInfoLabel}>Pago em</Text>
              <Text style={[styles.heroInfoValue, { color: '#10b981' }]}>
                {formatDate(bill.payment_date)}
              </Text>
            </View>
          )}
          {isOverdue && (
            <View style={styles.heroInfoItem}>
              <Ionicons name="warning-outline" size={16} color="#ef4444" />
              <Text style={styles.heroInfoLabel}>Atraso</Text>
              <Text style={[styles.heroInfoValue, { color: '#ef4444' }]}>
                {Math.abs(daysUntil)} dia{Math.abs(daysUntil) > 1 ? 's' : ''}
              </Text>
            </View>
          )}
          {!isPaid && !isOverdue && (
            <View style={styles.heroInfoItem}>
              <Ionicons name="hourglass-outline" size={16} color="#f59e0b" />
              <Text style={styles.heroInfoLabel}>Faltam</Text>
              <Text style={[styles.heroInfoValue, { color: '#f59e0b' }]}>
                {daysUntil} dia{daysUntil > 1 ? 's' : ''}
              </Text>
            </View>
          )}
        </View>

        {bill.barcode && (
          <View style={styles.barcodeBox}>
            <Text style={styles.barcodeLabel}>Código / Linha Digitável</Text>
            <Text style={styles.barcodeValue} selectable>{bill.barcode}</Text>
          </View>
        )}
      </View>

      {/* Comprovante Section */}
      {isPaid && bill.receipt_url && (
        <View style={styles.receiptSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="document-attach" size={18} color="#6366f1" />
            <Text style={styles.sectionTitle}>Comprovante de Pagamento</Text>
          </View>
          {!imageError ? (
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => {
                if (bill.receipt_url) Linking.openURL(bill.receipt_url);
              }}
            >
              <Image
                source={{ uri: bill.receipt_url }}
                style={styles.receiptImage}
                resizeMode="contain"
                onError={() => setImageError(true)}
              />
              <View style={styles.receiptOverlay}>
                <Ionicons name="expand-outline" size={16} color="#fff" />
                <Text style={styles.receiptOverlayText}>Toque para ampliar</Text>
              </View>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.receiptFallback}
              onPress={() => {
                if (bill.receipt_url) Linking.openURL(bill.receipt_url);
              }}
            >
              <Ionicons name="link-outline" size={20} color="#6366f1" />
              <Text style={styles.receiptFallbackText}>Abrir comprovante no navegador</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Action Buttons for Pending Bills */}
      {!isPaid && (
        <View style={styles.actionSection}>
          <TouchableOpacity
            style={styles.payButton}
            onPress={() => navigation.navigate('Payment')}
          >
            <Ionicons name="wallet" size={20} color="#fff" />
            <Text style={styles.payButtonText}>Registrar Pagamento</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* History Section */}
      {history.length > 0 && (
        <View style={styles.historySection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="time" size={18} color="#6366f1" />
            <Text style={styles.sectionTitle}>
              Histórico ({history.length} registro{history.length > 1 ? 's' : ''})
            </Text>
          </View>

          {history.map((item) => {
            const itemStatus = getStatusConfig(item.status, item.due_date);
            const itemIsPaid = item.status === 'paid' || item.status === 'aprovado';
            return (
              <TouchableOpacity
                key={item.id}
                style={styles.historyCard}
                onPress={() => {
                  navigation.push('BillHistory', { billId: item.id });
                }}
                activeOpacity={0.7}
              >
                <View style={[styles.historyDot, { backgroundColor: itemStatus.color }]} />
                <View style={styles.historyContent}>
                  <Text style={styles.historyDesc} numberOfLines={1}>
                    {item.description}
                  </Text>
                  <Text style={styles.historyMeta}>
                    {formatDate(item.due_date)} • R$ {Number(item.amount).toFixed(2)}
                  </Text>
                </View>
                <View style={[styles.historyBadge, { backgroundColor: itemStatus.bg }]}>
                  <Text style={[styles.historyBadgeText, { color: itemStatus.color }]}>
                    {itemStatus.label}
                  </Text>
                </View>
                {itemIsPaid && item.receipt_url && (
                  <Ionicons name="attach" size={14} color="#10b981" style={{ marginLeft: 6 }} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {history.length === 0 && (
        <View style={styles.emptyHistory}>
          <Ionicons name="file-tray-outline" size={36} color="#cbd5e1" />
          <Text style={styles.emptyHistoryText}>
            Nenhum histórico de pagamentos anteriores para esta conta.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f1f5f9',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#64748b',
  },
  errorText: {
    marginTop: 12,
    fontSize: 16,
    color: '#ef4444',
    fontWeight: '600',
  },

  // Hero Card
  heroCard: {
    margin: 16,
    padding: 20,
    backgroundColor: '#fff',
    borderRadius: 20,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    borderTopWidth: 4,
  },
  heroHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    gap: 4,
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '700',
  },
  recurringChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
    backgroundColor: '#f5f3ff',
    gap: 4,
  },
  recurringChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8b5cf6',
  },
  heroTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1e293b',
    marginBottom: 6,
  },
  heroAmount: {
    fontSize: 32,
    fontWeight: '900',
    color: '#1e293b',
    letterSpacing: -0.5,
  },
  heroDivider: {
    height: 1,
    backgroundColor: '#e2e8f0',
    marginVertical: 16,
  },
  heroInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  heroInfoItem: {
    alignItems: 'center',
    gap: 4,
  },
  heroInfoLabel: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '500',
  },
  heroInfoValue: {
    fontSize: 14,
    color: '#1e293b',
    fontWeight: '700',
  },
  barcodeBox: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  barcodeLabel: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '600',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  barcodeValue: {
    fontSize: 13,
    color: '#475569',
    fontFamily: 'monospace',
    lineHeight: 20,
  },

  // Receipt
  receiptSection: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1e293b',
  },
  receiptImage: {
    width: '100%',
    height: 250,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
  },
  receiptOverlay: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  receiptOverlayText: {
    fontSize: 11,
    color: '#fff',
    fontWeight: '600',
  },
  receiptFallback: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    backgroundColor: '#f5f3ff',
    borderRadius: 12,
  },
  receiptFallbackText: {
    fontSize: 13,
    color: '#6366f1',
    fontWeight: '600',
  },

  // Actions
  actionSection: {
    marginHorizontal: 16,
    marginBottom: 16,
  },
  payButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#10b981',
    paddingVertical: 16,
    borderRadius: 14,
    elevation: 3,
  },
  payButtonText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },

  // History
  historySection: {
    marginHorizontal: 16,
    marginBottom: 16,
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  historyCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f1f5f9',
  },
  historyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 12,
  },
  historyContent: {
    flex: 1,
  },
  historyDesc: {
    fontSize: 13,
    fontWeight: '600',
    color: '#334155',
  },
  historyMeta: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  historyBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  historyBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },

  // Empty
  emptyHistory: {
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 16,
    paddingVertical: 24,
    backgroundColor: '#fff',
    borderRadius: 16,
  },
  emptyHistoryText: {
    marginTop: 10,
    fontSize: 13,
    color: '#94a3b8',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
});
