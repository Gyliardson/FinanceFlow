import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { financialDateOnly, financialDaysBetween, formatFinancialDatePtBr } from '../services/financialDate';

interface BillDetail {
  id: string;
  description: string;
  amount: number;
  due_date: string;
  barcode: string | null;
  status: string;
  payment_date: string | null;
  is_recurring: boolean;
  parent_bill_id: string | null;
  has_receipt: boolean;
  legacy_receipt_requires_reconciliation: boolean;
}

type LoadFailure = 'not-found' | 'unavailable' | null;

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

export default function BillHistoryScreen({ route, navigation }: any) {
  const { billId } = route.params;
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [history, setHistory] = useState<BillDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<LoadFailure>(null);
  const [receiptOpening, setReceiptOpening] = useState(false);
  const [receiptFailure, setReceiptFailure] = useState<string | null>(null);

  const fetchDetail = async () => {
    setLoading(true);
    setFailure(null);
    setReceiptFailure(null);
    try {
      const response = await api.get(`/bills/${billId}/detail`);
      if (!response.data?.bill) {
        setBill(null);
        setHistory([]);
        setFailure('not-found');
        return;
      }
      setBill(response.data.bill);
      setHistory(response.data.history || []);
    } catch (error: any) {
      setBill(null);
      setHistory([]);
      setFailure(error?.response?.status === 404 ? 'not-found' : 'unavailable');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
  }, [billId]);

  const openPrivateReceipt = async () => {
    if (!bill?.has_receipt || receiptOpening) return;
    setReceiptOpening(true);
    setReceiptFailure(null);
    try {
      const response = await api.get(`/bills/${bill.id}/receipt`);
      const signedUrl = response.data?.url;
      if (typeof signedUrl !== 'string' || !signedUrl.trim()) {
        throw new Error('Missing signed receipt URL');
      }
      await Linking.openURL(signedUrl);
    } catch {
      setReceiptFailure('Não foi possível abrir o comprovante agora. Solicite um novo acesso e tente novamente.');
    } finally {
      setReceiptOpening(false);
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    try {
      return formatFinancialDatePtBr(dateStr);
    } catch {
      return dateStr;
    }
  };

  const getDaysUntilDue = (dueDate: string) => {
    try {
      return financialDaysBetween(financialDateOnly(), dueDate);
    } catch {
      return 0;
    }
  };

  const getStatusConfig = (status: string, dueDate: string) => {
    const isPaid = status === 'paid' || status === 'aprovado';
    if (isPaid) {
      return { label: 'Pago', color: '#047857', bg: '#ecfdf5', icon: 'checkmark-circle' as const };
    }

    if (getDaysUntilDue(dueDate) < 0 || status === 'overdue') {
      return { label: 'Vencida', color: '#b91c1c', bg: '#fef2f2', icon: 'alert-circle' as const };
    }

    return { label: 'Pendente', color: '#a16207', bg: '#fffbeb', icon: 'time' as const };
  };

  if (loading) {
    return (
      <View style={styles.stateContainer} accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color="#6366f1" />
        <Text style={styles.stateTitle}>Carregando fatura</Text>
        <Text style={styles.stateText}>Buscando detalhes e histórico de pagamentos.</Text>
      </View>
    );
  }

  if (!bill) {
    const notFound = failure === 'not-found';
    return (
      <View style={styles.stateContainer} accessibilityLiveRegion="assertive">
        <Ionicons name={notFound ? 'document-outline' : 'cloud-offline-outline'} size={48} color="#64748b" />
        <Text style={styles.stateTitle}>{notFound ? 'Fatura não encontrada' : 'Não foi possível carregar a fatura'}</Text>
        <Text style={styles.stateText}>
          {notFound
            ? 'Este registro pode ter sido removido ou não está disponível para sua conta.'
            : 'Verifique sua conexão e tente novamente. Nenhum dado foi alterado.'}
        </Text>
        {!notFound && (
          <TouchableOpacity
            style={styles.retryButton}
            onPress={fetchDetail}
            accessibilityRole="button"
            accessibilityLabel="Tentar carregar a fatura novamente"
          >
            <Ionicons name="refresh" size={18} color="#fff" />
            <Text style={styles.retryButtonText}>Tentar novamente</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const isPaid = bill.status === 'paid' || bill.status === 'aprovado';
  const statusConfig = getStatusConfig(bill.status, bill.due_date);
  const daysUntil = getDaysUntilDue(bill.due_date);
  const isOverdue = daysUntil < 0 && !isPaid;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={[styles.heroCard, { borderColor: statusConfig.color }]}>
        <View style={styles.heroHeader}>
          <View style={[styles.statusChip, { backgroundColor: statusConfig.bg }]} accessible accessibilityLabel={`Status ${statusConfig.label}`}>
            <Ionicons name={statusConfig.icon} size={14} color={statusConfig.color} />
            <Text style={[styles.statusChipText, { color: statusConfig.color }]}>{statusConfig.label}</Text>
          </View>
          {bill.is_recurring && (
            <View style={styles.recurringChip} accessible accessibilityLabel="Fatura recorrente">
              <Ionicons name="repeat" size={12} color="#7c3aed" />
              <Text style={styles.recurringChipText}>Recorrente</Text>
            </View>
          )}
        </View>

        <Text style={styles.heroTitle}>{bill.description || `Fatura ${bill.id.slice(0, 6)}`}</Text>
        <Text style={styles.heroAmount} adjustsFontSizeToFit numberOfLines={1}>{formatBRL(bill.amount)}</Text>
        <View style={styles.heroDivider} />

        <View style={styles.heroInfoRow}>
          <View style={styles.heroInfoItem}>
            <Ionicons name="calendar-outline" size={16} color="#64748b" />
            <Text style={styles.heroInfoLabel}>Vencimento</Text>
            <Text style={styles.heroInfoValue}>{formatDate(bill.due_date)}</Text>
          </View>
          {isPaid && bill.payment_date && (
            <View style={styles.heroInfoItem}>
              <Ionicons name="checkmark-done-outline" size={16} color="#047857" />
              <Text style={styles.heroInfoLabel}>Pago em</Text>
              <Text style={[styles.heroInfoValue, { color: '#047857' }]}>{formatDate(bill.payment_date)}</Text>
            </View>
          )}
          {isOverdue && (
            <View style={styles.heroInfoItem}>
              <Ionicons name="warning-outline" size={16} color="#b91c1c" />
              <Text style={styles.heroInfoLabel}>Atraso</Text>
              <Text style={[styles.heroInfoValue, { color: '#b91c1c' }]}>{Math.abs(daysUntil)} dia{Math.abs(daysUntil) === 1 ? '' : 's'}</Text>
            </View>
          )}
          {!isPaid && !isOverdue && (
            <View style={styles.heroInfoItem}>
              <Ionicons name="hourglass-outline" size={16} color="#a16207" />
              <Text style={styles.heroInfoLabel}>Prazo</Text>
              <Text style={[styles.heroInfoValue, { color: '#a16207' }]}>{daysUntil === 0 ? 'Vence hoje' : `${daysUntil} dia${daysUntil === 1 ? '' : 's'}`}</Text>
            </View>
          )}
        </View>

        {bill.barcode && (
          <View style={styles.barcodeBox}>
            <Text style={styles.barcodeLabel}>Código / linha digitável</Text>
            <Text style={styles.barcodeValue} selectable>{bill.barcode}</Text>
          </View>
        )}
      </View>

      {isPaid && bill.has_receipt && (
        <View style={styles.receiptSection}>
          <View style={styles.sectionHeader}>
            <Ionicons name="document-attach" size={18} color="#6366f1" />
            <Text style={styles.sectionTitle} accessibilityRole="header">Comprovante de pagamento</Text>
          </View>
          <Text style={styles.receiptPrivacyText}>
            O comprovante é privado. Um acesso temporário é solicitado somente quando você decide abri-lo.
          </Text>
          <TouchableOpacity
            style={[styles.receiptButton, receiptOpening && styles.receiptButtonDisabled]}
            onPress={openPrivateReceipt}
            disabled={receiptOpening}
            accessibilityRole="button"
            accessibilityLabel={receiptOpening ? 'Solicitando acesso ao comprovante' : 'Abrir comprovante de pagamento'}
            accessibilityHint="Solicita um link temporário e abre o comprovante em visualização externa"
          >
            {receiptOpening ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Ionicons name="open-outline" size={19} color="#fff" />
            )}
            <Text style={styles.receiptButtonText}>{receiptOpening ? 'Solicitando acesso…' : 'Abrir comprovante'}</Text>
          </TouchableOpacity>
          {receiptFailure && (
            <View style={styles.receiptFailure} accessibilityLiveRegion="assertive">
              <Ionicons name="alert-circle-outline" size={17} color="#b91c1c" />
              <Text style={styles.receiptFailureText}>{receiptFailure}</Text>
            </View>
          )}
        </View>
      )}

      {isPaid && bill.legacy_receipt_requires_reconciliation && (
        <View style={styles.receiptSection} accessibilityLiveRegion="polite">
          <View style={styles.sectionHeader}>
            <Ionicons name="shield-outline" size={18} color="#a16207" />
            <Text style={styles.sectionTitle} accessibilityRole="header">Comprovante legado</Text>
          </View>
          <Text style={styles.legacyReceiptText}>
            Este registro usa o formato antigo de comprovante e precisa ser reconciliado antes de poder gerar acesso privado temporário.
          </Text>
        </View>
      )}

      {!isPaid && (
        <View style={styles.actionSection}>
          <TouchableOpacity
            style={styles.payButton}
            onPress={() => navigation.navigate('Payment', { billId: bill.id })}
            accessibilityRole="button"
            accessibilityLabel={`Registrar pagamento de ${bill.description || 'fatura'}, ${formatBRL(bill.amount)}`}
          >
            <Ionicons name="wallet" size={20} color="#fff" />
            <Text style={styles.payButtonText}>Registrar pagamento</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.historySection}>
        <View style={styles.sectionHeader}>
          <Ionicons name="time" size={18} color="#6366f1" />
          <Text style={styles.sectionTitle} accessibilityRole="header">Histórico ({history.length})</Text>
        </View>

        {history.length === 0 ? (
          <View style={styles.emptyHistory}>
            <Ionicons name="file-tray-outline" size={36} color="#94a3b8" />
            <Text style={styles.emptyHistoryTitle}>Sem registros anteriores</Text>
            <Text style={styles.emptyHistoryText}>Quando houver outras ocorrências desta conta, elas aparecerão aqui.</Text>
          </View>
        ) : (
          history.map((item) => {
            const itemStatus = getStatusConfig(item.status, item.due_date);
            const itemIsPaid = item.status === 'paid' || item.status === 'aprovado';
            return (
              <TouchableOpacity
                key={item.id}
                style={styles.historyCard}
                onPress={() => navigation.push('BillHistory', { billId: item.id })}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${item.description || 'Fatura'}, ${formatBRL(item.amount)}, ${itemStatus.label}, vencimento ${formatDate(item.due_date)}`}
              >
                <View style={[styles.historyDot, { backgroundColor: itemStatus.color }]} />
                <View style={styles.historyContent}>
                  <Text style={styles.historyDesc}>{item.description || 'Fatura sem descrição'}</Text>
                  <Text style={styles.historyMeta}>{formatDate(item.due_date)} • {formatBRL(item.amount)}</Text>
                </View>
                <View style={[styles.historyBadge, { backgroundColor: itemStatus.bg }]}>
                  <Text style={[styles.historyBadgeText, { color: itemStatus.color }]}>{itemStatus.label}</Text>
                </View>
                {itemIsPaid && item.has_receipt && <Ionicons name="attach" size={14} color="#047857" style={styles.attachmentIcon} />}
                {itemIsPaid && item.legacy_receipt_requires_reconciliation && <Ionicons name="warning-outline" size={14} color="#a16207" style={styles.attachmentIcon} />}
              </TouchableOpacity>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f1f5f9' },
  content: { paddingBottom: 40 },
  stateContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, backgroundColor: '#f1f5f9' },
  stateTitle: { marginTop: 14, fontSize: 18, fontWeight: '800', color: '#1e293b', textAlign: 'center' },
  stateText: { marginTop: 6, fontSize: 14, lineHeight: 20, color: '#64748b', textAlign: 'center' },
  retryButton: { minHeight: 48, marginTop: 20, paddingHorizontal: 18, borderRadius: 12, backgroundColor: '#6366f1', flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  retryButtonText: { color: '#fff', fontWeight: '800' },
  heroCard: { margin: 16, padding: 20, backgroundColor: '#fff', borderRadius: 20, elevation: 4, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, borderTopWidth: 4 },
  heroHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 12 },
  statusChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, gap: 4 },
  statusChipText: { fontSize: 12, fontWeight: '700' },
  recurringChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 20, backgroundColor: '#f5f3ff', gap: 4 },
  recurringChipText: { fontSize: 11, fontWeight: '600', color: '#7c3aed' },
  heroTitle: { fontSize: 18, lineHeight: 24, fontWeight: '800', color: '#1e293b', marginBottom: 6 },
  heroAmount: { fontSize: 32, fontWeight: '900', color: '#1e293b', letterSpacing: -0.5 },
  heroDivider: { height: 1, backgroundColor: '#e2e8f0', marginVertical: 16 },
  heroInfoRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around', gap: 16 },
  heroInfoItem: { minWidth: 90, alignItems: 'center', gap: 4 },
  heroInfoLabel: { fontSize: 11, color: '#64748b', fontWeight: '500' },
  heroInfoValue: { fontSize: 14, color: '#1e293b', fontWeight: '700', textAlign: 'center' },
  barcodeBox: { marginTop: 16, padding: 12, backgroundColor: '#f8fafc', borderRadius: 12, borderWidth: 1, borderColor: '#e2e8f0' },
  barcodeLabel: { fontSize: 11, color: '#64748b', fontWeight: '600', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
  barcodeValue: { fontSize: 13, color: '#475569', fontFamily: 'monospace', lineHeight: 20 },
  receiptSection: { marginHorizontal: 16, marginBottom: 16, backgroundColor: '#fff', borderRadius: 16, padding: 16, elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
  sectionTitle: { flexShrink: 1, fontSize: 15, fontWeight: '700', color: '#1e293b' },
  receiptPrivacyText: { fontSize: 13, lineHeight: 19, color: '#64748b', marginBottom: 14 },
  receiptButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, paddingHorizontal: 14, backgroundColor: '#4f46e5', borderRadius: 12 },
  receiptButtonDisabled: { opacity: 0.72 },
  receiptButtonText: { fontSize: 14, color: '#fff', fontWeight: '800' },
  receiptFailure: { marginTop: 12, flexDirection: 'row', alignItems: 'flex-start', gap: 7, padding: 10, borderRadius: 10, backgroundColor: '#fef2f2' },
  receiptFailureText: { flex: 1, fontSize: 12, lineHeight: 18, color: '#991b1b' },
  legacyReceiptText: { fontSize: 13, lineHeight: 19, color: '#854d0e', backgroundColor: '#fffbeb', borderRadius: 10, padding: 12 },
  actionSection: { marginHorizontal: 16, marginBottom: 16 },
  payButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#047857', paddingVertical: 16, paddingHorizontal: 16, borderRadius: 14, elevation: 3 },
  payButtonText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  historySection: { marginHorizontal: 16, marginBottom: 16, backgroundColor: '#fff', borderRadius: 16, padding: 16, elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  historyCard: { minHeight: 64, flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f1f5f9' },
  historyDot: { width: 8, height: 8, borderRadius: 4, marginRight: 12 },
  historyContent: { flex: 1, minWidth: 0, paddingRight: 8 },
  historyDesc: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: '#334155' },
  historyMeta: { fontSize: 11, color: '#64748b', marginTop: 4 },
  historyBadge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 10 },
  historyBadgeText: { fontSize: 10, fontWeight: '700' },
  attachmentIcon: { marginLeft: 6 },
  emptyHistory: { alignItems: 'center', paddingVertical: 22, paddingHorizontal: 12 },
  emptyHistoryTitle: { marginTop: 10, fontSize: 14, fontWeight: '700', color: '#475569' },
  emptyHistoryText: { marginTop: 4, fontSize: 13, lineHeight: 18, color: '#64748b', textAlign: 'center' },
});