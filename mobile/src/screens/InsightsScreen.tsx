import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { useFinancialMutation } from '../services/useFinancialMutation';

interface InsightData {
  current_balance: number;
  estimated_surplus: number;
  emergency_fund_goal: number;
  emergency_fund_balance: number | string | null;
  insight: string | null;
}

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

export default function InsightsScreen({ navigation }: any) {
  const [data, setData] = useState<InsightData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshingAI, setRefreshingAI] = useState(false);
  const [reconcilingSnapshot, setReconcilingSnapshot] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [goalModalVisible, setGoalModalVisible] = useState(false);
  const [reserveAmount, setReserveAmount] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [submittingReserve, setSubmittingReserve] = useState(false);
  const [submittingGoal, setSubmittingGoal] = useState(false);
  const snapshotGeneration = useRef(0);
  const reserveMutation = useFinancialMutation('/insights/reserve');
  const intentLocked = reserveMutation.hasActiveIntent;
  const snapshotBusy = reconcilingSnapshot || refreshingAI || submittingReserve || submittingGoal;

  const fetchInsights = async () => {
    const generation = ++snapshotGeneration.current;
    setReconcilingSnapshot(true);
    setLoadError(false);
    try {
      const resp = await api.get('/insights');
      if (generation !== snapshotGeneration.current) return;
      if (resp.data?.data) setData(resp.data.data);
      else {
        setData(null);
        setLoadError(true);
      }
    } catch (e: any) {
      if (generation !== snapshotGeneration.current) return;
      if (e.response?.status === 400) {
        Alert.alert('Configuração pendente', 'Configure o saldo inicial na tela principal antes de acessar os insights.');
        navigation.goBack();
        return;
      }
      setLoadError(true);
    } finally {
      if (generation === snapshotGeneration.current) {
        setLoading(false);
        setReconcilingSnapshot(false);
      }
    }
  };

  const handleRefreshAI = async () => {
    if (snapshotBusy) return;
    const generation = ++snapshotGeneration.current;
    setRefreshingAI(true);
    try {
      const resp = await api.post('/insights/refresh');
      if (generation !== snapshotGeneration.current) return;
      if (resp.data?.data) {
        setData(resp.data.data);
        setLoadError(false);
        Alert.alert('Análise atualizada', 'O insight financeiro foi atualizado com sucesso.');
      }
    } catch {
      if (generation !== snapshotGeneration.current) return;
      Alert.alert('Não foi possível atualizar', 'Tente novamente quando a conexão estiver estável.');
    } finally {
      if (generation === snapshotGeneration.current) {
        setRefreshingAI(false);
      }
    }
  };

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    setReserveAmount(numericValue ? (Number(numericValue) / 100).toFixed(2).replace('.', ',') : '');
  };

  const handleGoalAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    setNewGoal(numericValue ? (Number(numericValue) / 100).toFixed(2).replace('.', ',') : '');
  };

  const closeReserveModal = () => {
    if (submittingReserve) return;
    reserveMutation.startNewIntent();
    setModalVisible(false);
    setReserveAmount('');
  };

  const handleSaveReserve = async () => {
    if (submittingReserve || refreshingAI || reconcilingSnapshot || !reserveAmount) return;
    const amountVal = Number(reserveAmount.replace(',', '.'));
    if (!Number.isFinite(amountVal) || amountVal <= 0) {
      Alert.alert('Valor inválido', 'Informe um valor maior que zero.');
      return;
    }

    setSubmittingReserve(true);
    try {
      await reserveMutation.mutate({ amount: amountVal });
      setModalVisible(false);
      setReserveAmount('');
      Alert.alert('Reserva atualizada', 'O valor foi adicionado à sua reserva de emergência.');
      await fetchInsights();
    } catch {
      Alert.alert(
        'Resultado ainda não confirmado',
        'O valor desta intenção foi bloqueado. Tente novamente para reutilizar a mesma identidade e o payload original, ou cancele e abra novamente para iniciar outra intenção.'
      );
    } finally {
      setSubmittingReserve(false);
    }
  };

  const handleSaveGoal = async () => {
    if (submittingGoal || refreshingAI || reconcilingSnapshot || !newGoal) return;
    const goalVal = Number(newGoal.replace(',', '.'));
    if (!Number.isFinite(goalVal) || goalVal <= 0) {
      Alert.alert('Meta inválida', 'Informe uma meta maior que zero.');
      return;
    }
    setSubmittingGoal(true);
    try {
      await api.patch('/settings/emergency-fund-goal', { emergency_fund_goal: goalVal });
      setGoalModalVisible(false);
      Alert.alert('Meta atualizada', 'A meta da reserva de emergência foi salva.');
      await fetchInsights();
    } catch {
      Alert.alert(
        'Resultado não confirmado',
        'Não foi possível confirmar se a meta foi salva. Recarregue os dados para reconciliar o estado antes de tentar novamente.',
      );
    } finally {
      setSubmittingGoal(false);
    }
  };

  useEffect(() => {
    void fetchInsights();
    return () => {
      snapshotGeneration.current += 1;
    };
  }, []);

  if (loading) {
    return (
      <View style={styles.stateContainer} accessibilityLiveRegion="polite">
        <ActivityIndicator size="large" color="#4f46e5" />
        <Text style={styles.stateTitle}>Carregando panorama financeiro</Text>
        <Text style={styles.stateText}>Reunindo saldo, reserva e análise do mês.</Text>
      </View>
    );
  }

  if (loadError || !data) {
    return (
      <View style={styles.stateContainer} accessibilityLiveRegion="assertive">
        <Ionicons accessibilityElementsHidden name="cloud-offline-outline" size={48} color="#64748b" />
        <Text style={styles.stateTitle}>Insights indisponíveis</Text>
        <Text style={styles.stateText}>Não foi possível carregar seus dados financeiros agora.</Text>
        <TouchableOpacity style={styles.retryButton} onPress={() => { setLoading(true); void fetchInsights(); }} accessibilityRole="button" accessibilityLabel="Tentar carregar os insights novamente">
          <Ionicons accessibilityElementsHidden name="refresh" size={18} color="#fff" />
          <Text style={styles.retryButtonText}>Tentar novamente</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const safeFund = Number(data.emergency_fund_balance ?? 0);
  const safeGoal = Number(data.emergency_fund_goal ?? 0);
  const progressPercent = safeGoal > 0 ? Math.min(100, Math.max(0, (safeFund / safeGoal) * 100)) : 0;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollContainer} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.headerCard} accessible accessibilityLabel={`Saldo atual ${formatBRL(data.current_balance)}. Sobra estimada ${formatBRL(data.estimated_surplus)}.`}>
          <View style={styles.rowBetween}><Text style={styles.headerLabel}>Saldo atual</Text><Ionicons accessibilityElementsHidden name="wallet-outline" size={20} color="#e0e7ff" /></View>
          <Text style={styles.balanceText} adjustsFontSizeToFit numberOfLines={1}>{formatBRL(data.current_balance)}</Text>
          <View style={styles.divider} />
          <Text style={styles.headerLabel}>Sobra estimada após compromissos</Text>
          <Text style={styles.surplusText} adjustsFontSizeToFit numberOfLines={1}>{formatBRL(data.estimated_surplus)}</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle} accessibilityRole="header">Reserva de emergência</Text>
            <TouchableOpacity style={[styles.addReserveBtn, snapshotBusy && styles.buttonDisabled]} disabled={snapshotBusy} onPress={() => setModalVisible(true)} accessibilityRole="button" accessibilityLabel="Adicionar valor à reserva de emergência" accessibilityState={{ disabled: snapshotBusy }}><Ionicons accessibilityElementsHidden name="add" size={16} color="#fff" /><Text style={styles.addReserveBtnText}>Guardar</Text></TouchableOpacity>
          </View>
          <View style={styles.goalRow}>
            <View style={styles.goalCopy}><Text style={styles.goalText}>Meta: {formatBRL(safeGoal)}</Text><Text style={styles.savedText}>Guardado: {formatBRL(safeFund)}</Text></View>
            <TouchableOpacity style={[styles.iconButton, snapshotBusy && styles.buttonDisabled]} disabled={snapshotBusy} onPress={() => { setNewGoal(safeGoal.toFixed(2).replace('.', ',')); setGoalModalVisible(true); }} accessibilityRole="button" accessibilityLabel="Editar meta da reserva de emergência" accessibilityState={{ disabled: snapshotBusy }}><Ionicons accessibilityElementsHidden name="create-outline" size={20} color="#6366f1" /></TouchableOpacity>
          </View>
          <View style={styles.progressBarBg} accessible accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: Math.round(progressPercent) }} accessibilityLabel="Progresso da reserva de emergência"><View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} /></View>
          <Text style={styles.progressText}>{progressPercent.toFixed(1)}% da meta concluída</Text>
        </View>

        <View style={styles.section}>
          <View style={styles.rowBetween}><Text style={styles.sectionTitle} accessibilityRole="header">Análise do consultor IA</Text><Ionicons accessibilityElementsHidden name="hardware-chip-outline" size={20} color="#4f46e5" /></View>
          <View style={styles.insightBox}><Text style={styles.insightText}>{data.insight || 'Nenhuma análise recente está disponível.'}</Text></View>
          {reconcilingSnapshot && <Text style={styles.reconcilingText} accessibilityLiveRegion="polite">Reconciliando dados financeiros…</Text>}
          <TouchableOpacity style={[styles.refreshBtn, snapshotBusy && styles.buttonDisabled]} onPress={handleRefreshAI} disabled={snapshotBusy} accessibilityRole="button" accessibilityLabel="Gerar nova análise financeira com inteligência artificial" accessibilityState={{ disabled: snapshotBusy, busy: refreshingAI || reconcilingSnapshot }}>
            {refreshingAI ? <ActivityIndicator size="small" color="#fff" /> : <><Ionicons accessibilityElementsHidden name="refresh" size={16} color="#fff" /><Text style={styles.refreshBtnText}>Atualizar análise</Text></>}
          </TouchableOpacity>
        </View>
      </ScrollView>

      <Modal visible={modalVisible} animationType="slide" transparent onRequestClose={closeReserveModal}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContainer} accessibilityViewIsModal>
            <Text style={styles.modalTitle} accessibilityRole="header">Guardar dinheiro</Text>
            {intentLocked && <Text style={styles.intentNotice}>Resultado anterior indeterminado: o valor está bloqueado para que o retry repita exatamente a mesma intenção.</Text>}
            <Text style={styles.modalLabel}>Valor a guardar</Text>
            <View style={styles.inputWrapper}><Text style={styles.currencyPrefix}>R$</Text><TextInput style={styles.modalInputAmount} keyboardType="numeric" placeholder="0,00" value={reserveAmount} onChangeText={handleAmountChange} editable={!submittingReserve && !intentLocked && !refreshingAI && !reconcilingSnapshot} accessibilityLabel="Valor a guardar na reserva de emergência" /></View>
            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={closeReserveModal} disabled={submittingReserve} accessibilityRole="button"><Text style={styles.cancelBtnText}>Cancelar</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.saveBtn, (submittingReserve || refreshingAI || reconcilingSnapshot) && styles.buttonDisabled]} onPress={handleSaveReserve} disabled={submittingReserve || refreshingAI || reconcilingSnapshot} accessibilityRole="button" accessibilityLabel="Confirmar valor da reserva" accessibilityHint={intentLocked ? 'Repete a mesma intenção da reserva com o valor original' : 'Adiciona o valor à reserva'} accessibilityState={{ disabled: submittingReserve || refreshingAI || reconcilingSnapshot, busy: submittingReserve }}>{submittingReserve ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>{intentLocked ? 'Tentar mesma intenção' : 'Confirmar'}</Text>}</TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal visible={goalModalVisible} animationType="slide" transparent onRequestClose={() => !submittingGoal && setGoalModalVisible(false)}>
        <KeyboardAvoidingView style={styles.modalOverlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={styles.modalContainer} accessibilityViewIsModal>
            <Text style={styles.modalTitle} accessibilityRole="header">Editar meta</Text>
            <Text style={styles.modalLabel}>Nova meta total</Text>
            <View style={styles.inputWrapper}><Text style={styles.currencyPrefix}>R$</Text><TextInput style={styles.modalInputAmount} keyboardType="numeric" value={newGoal} onChangeText={handleGoalAmountChange} editable={!submittingGoal && !refreshingAI && !reconcilingSnapshot} accessibilityLabel="Nova meta total da reserva de emergência" /></View>
            <View style={styles.modalActions}><TouchableOpacity style={styles.cancelBtn} onPress={() => setGoalModalVisible(false)} disabled={submittingGoal}><Text style={styles.cancelBtnText}>Cancelar</Text></TouchableOpacity><TouchableOpacity style={[styles.saveBtn, (submittingGoal || refreshingAI || reconcilingSnapshot) && styles.buttonDisabled]} onPress={handleSaveGoal} disabled={submittingGoal || refreshingAI || reconcilingSnapshot}>{submittingGoal ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Salvar meta</Text>}</TouchableOpacity></View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f1f5f9' }, scrollContainer: { flex: 1 }, scrollContent: { paddingBottom: 40 },
  stateContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 28, backgroundColor: '#f1f5f9' }, stateTitle: { marginTop: 14, fontSize: 18, fontWeight: '800', color: '#1e293b', textAlign: 'center' }, stateText: { marginTop: 6, fontSize: 14, lineHeight: 20, color: '#64748b', textAlign: 'center' }, retryButton: { minHeight: 48, marginTop: 20, paddingHorizontal: 18, borderRadius: 12, backgroundColor: '#4f46e5', flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }, retryButtonText: { color: '#fff', fontWeight: '800' },
  headerCard: { backgroundColor: '#4f46e5', margin: 16, borderRadius: 18, padding: 20, elevation: 4, shadowColor: '#4f46e5', shadowOpacity: 0.3, shadowOffset: { width: 0, height: 4 } }, rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 6 }, headerLabel: { color: '#e0e7ff', fontSize: 14, fontWeight: '600' }, balanceText: { color: '#fff', fontSize: 32, fontWeight: '800', marginTop: 4 }, divider: { height: 1, backgroundColor: '#6366f1', marginVertical: 16 }, surplusText: { color: '#c7d2fe', fontSize: 22, fontWeight: '700', marginTop: 4 },
  section: { backgroundColor: '#fff', marginHorizontal: 16, marginBottom: 16, borderRadius: 16, padding: 20, elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowOffset: { width: 0, height: 2 } }, sectionTitle: { flexShrink: 1, fontSize: 16, fontWeight: '700', color: '#1e293b' }, goalRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8, marginBottom: 14 }, goalCopy: { flex: 1 }, goalText: { fontSize: 14, color: '#334155', fontWeight: '700' }, savedText: { fontSize: 14, color: '#047857', fontWeight: '800', marginTop: 6 }, iconButton: { minWidth: 44, minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#eef2ff' }, progressBarBg: { height: 12, backgroundColor: '#e2e8f0', borderRadius: 6, overflow: 'hidden', marginBottom: 8 }, progressBarFill: { height: '100%', backgroundColor: '#10b981' }, progressText: { fontSize: 12, color: '#047857', fontWeight: '700', textAlign: 'right' },
  insightBox: { backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 12, padding: 16, marginTop: 8, marginBottom: 16 }, insightText: { fontSize: 14, lineHeight: 22, color: '#334155' }, reconcilingText: { marginBottom: 10, color: '#475569', fontSize: 12, lineHeight: 18, fontWeight: '600' }, refreshBtn: { minHeight: 48, backgroundColor: '#10b981', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', padding: 14, borderRadius: 12, gap: 8 }, refreshBtnText: { color: '#fff', fontWeight: '700' }, addReserveBtn: { minHeight: 44, flexDirection: 'row', alignItems: 'center', backgroundColor: '#10b981', paddingHorizontal: 12, borderRadius: 10, gap: 4 }, addReserveBtnText: { color: '#fff', fontWeight: '700' }, buttonDisabled: { opacity: 0.65 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 }, modalContainer: { backgroundColor: '#fff', borderRadius: 20, padding: 24, elevation: 10 }, modalTitle: { fontSize: 20, fontWeight: '800', color: '#1e293b', marginBottom: 8 }, intentNotice: { padding: 10, borderRadius: 10, backgroundColor: '#fffbeb', color: '#92400e', fontSize: 12, lineHeight: 18, fontWeight: '700' }, modalLabel: { fontSize: 13, fontWeight: '600', color: '#475569', marginBottom: 6, marginTop: 12 }, inputWrapper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 10, paddingLeft: 12 }, currencyPrefix: { fontSize: 15, fontWeight: '700', color: '#64748b', marginRight: 4 }, modalInputAmount: { flex: 1, padding: 14, fontSize: 15, color: '#1e293b', minHeight: 52 }, modalActions: { flexDirection: 'row', marginTop: 24, gap: 12 }, cancelBtn: { flex: 1, minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: '#f1f5f9', alignItems: 'center', justifyContent: 'center' }, cancelBtnText: { color: '#475569', fontWeight: '700' }, saveBtn: { flex: 2, minHeight: 48, padding: 14, borderRadius: 12, backgroundColor: '#10b981', alignItems: 'center', justifyContent: 'center' }, saveBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
