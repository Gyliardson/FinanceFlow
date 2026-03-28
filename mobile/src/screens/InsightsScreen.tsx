import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Modal, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

export default function InsightsScreen({ navigation }: any) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [refreshingAI, setRefreshingAI] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [goalModalVisible, setGoalModalVisible] = useState(false);
  const [reserveAmount, setReserveAmount] = useState('');
  const [newGoal, setNewGoal] = useState('');
  const [submittingReserve, setSubmittingReserve] = useState(false);
  const [submittingGoal, setSubmittingGoal] = useState(false);

  const fetchInsights = async () => {
    try {
      const resp = await api.get('/insights');
      if (resp.data?.data) {
        setData(resp.data.data);
      }
    } catch (e: any) {
      if (e.response?.status === 400) {
         Alert.alert('Configuração Pendente', 'Você precisa configurar o saldo inicial na Tela Inicial.');
         navigation.goBack();
      } else {
         console.error(e);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshAI = async () => {
    setRefreshingAI(true);
    try {
      const resp = await api.post('/insights/refresh');
      if (resp.data?.data) {
        setData(resp.data.data);
        Alert.alert('Sucesso', 'Análise atualizada com sucesso pela Inteligência Artificial.');
      }
    } catch (e) {
      console.error(e);
      Alert.alert('Erro', 'Não foi possível gerar um novo insight.');
    } finally {
      setRefreshingAI(false);
    }
  };

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue) {
      const val = (Number(numericValue) / 100).toFixed(2);
      setReserveAmount(val.replace('.', ','));
    } else {
      setReserveAmount('');
    }
  };

  const handleSaveReserve = async () => {
    if (!reserveAmount) return;
    const amountVal = parseFloat(reserveAmount.replace(',', '.'));
    if (isNaN(amountVal) || amountVal <= 0) {
      Alert.alert('Erro', 'Insira um valor válido.');
      return;
    }
    
    setSubmittingReserve(true);
    try {
      await api.post('/insights/reserve', { amount: amountVal });
      Alert.alert('Sucesso', 'Valor guardado na sua Reserva de Emergência!');
      setModalVisible(false);
      setReserveAmount('');
      fetchInsights();
    } catch (e) {
      console.error(e);
      Alert.alert('Erro', 'Não foi possível salvar o fundo.');
    } finally {
      setSubmittingReserve(false);
    }
  };

  const handleGoalAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue) {
      const val = (Number(numericValue) / 100).toFixed(2);
      setNewGoal(val.replace('.', ','));
    } else {
      setNewGoal('');
    }
  };

  const handleSaveGoal = async () => {
    if (!newGoal) return;
    const goalVal = parseFloat(newGoal.replace(',', '.'));
    if (isNaN(goalVal) || goalVal <= 0) {
      Alert.alert('Erro', 'Insira uma meta válida.');
      return;
    }

    setSubmittingGoal(true);
    try {
      // Fetch current settings directly from backend
      const setResp = await api.get('/settings');
      const currentSettings = setResp.data.data;
      
      // Update only the emergency_fund_goal seamlessly
      await api.post('/settings', {
        ...currentSettings,
        emergency_fund_goal: goalVal
      });

      Alert.alert('Sucesso', 'Meta de reserva atualizada!');
      setGoalModalVisible(false);
      fetchInsights();
    } catch (e) {
      console.error(e);
      Alert.alert('Erro', 'Não foi possível salvar a nova meta.');
    } finally {
      setSubmittingGoal(false);
    }
  };

  useEffect(() => {
    fetchInsights();
  }, []);

  if (loading) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (!data) {
    return (
      <View style={styles.loaderContainer}>
        <Text style={styles.errorText}>Nenhuma informação financeira disponível.</Text>
      </View>
    );
  }

  const { current_balance, estimated_surplus, emergency_fund_goal, insight, emergency_fund_balance } = data;
  const safe_fund = emergency_fund_balance ? parseFloat(emergency_fund_balance) : 0;
  const progressPercent = emergency_fund_goal > 0 
    ? Math.min(100, Math.max(0, (safe_fund / emergency_fund_goal) * 100))
    : 0;

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollContainer} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* Resumo Financeiro */}
      <View style={styles.headerCard}>
        <View style={styles.rowBetween}>
          <Text style={styles.headerLabel}>Saldo Atual Real</Text>
          <Ionicons name="wallet-outline" size={20} color="#e0e7ff" />
        </View>
        <Text style={styles.balanceText}>R$ {current_balance?.toFixed(2)}</Text>
        
        <View style={styles.divider} />

        <View style={styles.rowBetween}>
          <Text style={styles.headerLabel}>Sobra Estimada</Text>
        </View>
        <Text style={styles.surplusText}>R$ {estimated_surplus?.toFixed(2)}</Text>
      </View>

      {/* Seção Reserva de Emergência (Gráfico em Barra) */}
      <View style={styles.section}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Reserva de Emergência</Text>
          <TouchableOpacity 
            style={styles.addReserveBtn} 
            onPress={() => setModalVisible(true)}
          >
            <Ionicons name="add" size={16} color="#fff" />
            <Text style={styles.addReserveBtnText}>Guardar</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.goalRow}>
          <Text style={styles.goalText}>Meta: R$ {Number(emergency_fund_goal || 0).toFixed(2)}</Text>
          <TouchableOpacity onPress={() => {
            setNewGoal(Number(emergency_fund_goal || 0).toFixed(2).replace('.', ','));
            setGoalModalVisible(true);
          }}>
            <Ionicons name="create-outline" size={16} color="#6366f1" style={{marginLeft: 8, marginTop: -14}} />
          </TouchableOpacity>
        </View>
        <Text style={styles.savedText}>Guardado: R$ {safe_fund.toFixed(2)}</Text>
        
        <View style={styles.progressBarBg}>
          <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
        </View>
        <Text style={styles.progressText}>{progressPercent.toFixed(1)}% concluído</Text>
      </View>

      {/* Seção Análise de IA */}
      <View style={styles.section}>
        <View style={styles.rowBetween}>
          <Text style={styles.sectionTitle}>Análise do Consultor IA</Text>
          <Ionicons name="hardware-chip-outline" size={20} color="#4f46e5" />
        </View>

        <View style={styles.insightBox}>
          <Text style={styles.insightText}>{insight || 'Sem dados recentes da IA.'}</Text>
        </View>

        <TouchableOpacity 
          style={styles.refreshBtn} 
          onPress={handleRefreshAI}
          disabled={refreshingAI}
        >
          {refreshingAI ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <Ionicons name="refresh" size={16} color="#fff" />
              <Text style={styles.refreshBtnText}>Gerar Nova Análise (Usar IA)</Text>
            </>
          )}
        </TouchableOpacity>
        <Text style={styles.hintText}>
          A IA analisa as finanças deste mês. Um cache automático foi ativado para evitar consumo extra. Clique apenas se houver grandes mudanças.
        </Text>
      </View>

    </ScrollView>

      {/* Modal Adicionar à Reserva */}
      <Modal visible={modalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>Guardar Dinheiro</Text>
            <Text style={styles.modalSub}>
              Adicione saldo à sua Reserva de Emergência. Esse valor será deduzido logicamente do seu saldo principal para garantir que não o gaste.
            </Text>

            <Text style={styles.modalLabel}>Qual valor deseja guardar?</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.currencyPrefix}>R$</Text>
              <TextInput
                style={styles.modalInputAmount}
                keyboardType="numeric"
                placeholder="0,00"
                value={reserveAmount}
                onChangeText={handleAmountChange}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => {
                  setModalVisible(false);
                  setReserveAmount('');
                }}
                disabled={submittingReserve}
              >
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleSaveReserve}
                disabled={submittingReserve}
              >
                {submittingReserve ? (
                   <ActivityIndicator color="#fff" size="small" />
                ) : (
                   <Text style={styles.saveBtnText}>Confirmar</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      {/* Modal Editar Meta */}
      <Modal visible={goalModalVisible} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>Editar Meta</Text>
            <Text style={styles.modalSub}>
              Ajuste sua meta total para a Reserva de Emergência.
            </Text>

            <Text style={styles.modalLabel}>Nova Meta Total</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.currencyPrefix}>R$</Text>
              <TextInput
                style={styles.modalInputAmount}
                keyboardType="numeric"
                placeholder="0,00"
                value={newGoal}
                onChangeText={handleGoalAmountChange}
              />
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setGoalModalVisible(false)}
                disabled={submittingGoal}
              >
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleSaveGoal}
                disabled={submittingGoal}
              >
                {submittingGoal ? (
                   <ActivityIndicator color="#fff" size="small" />
                ) : (
                   <Text style={styles.saveBtnText}>Salvar Meta</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  scrollContainer: {
    flex: 1,
  },
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: '#64748b',
    fontSize: 16,
  },
  headerCard: {
    backgroundColor: '#4f46e5',
    margin: 16,
    borderRadius: 16,
    padding: 20,
    elevation: 4,
    shadowColor: '#4f46e5',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  headerLabel: {
    color: '#e0e7ff',
    fontSize: 14,
    fontWeight: '600',
  },
  balanceText: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '800',
    marginTop: 4,
  },
  divider: {
    height: 1,
    backgroundColor: '#6366f1',
    marginVertical: 16,
  },
  surplusText: {
    color: '#a5b4fc',
    fontSize: 22,
    fontWeight: '700',
    marginTop: 4,
  },
  section: {
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 16,
    padding: 20,
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 2 },
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e293b',
    marginBottom: 8,
  },
  goalRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  goalText: {
    fontSize: 14,
    color: '#334155',
    fontWeight: '700',
    marginBottom: 16,
  },
  progressBarBg: {
    height: 12,
    backgroundColor: '#e2e8f0',
    borderRadius: 6,
    overflow: 'hidden',
    marginBottom: 8,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#10b981',
    borderRadius: 6,
  },
  progressText: {
    fontSize: 12,
    color: '#10b981',
    fontWeight: '700',
    textAlign: 'right',
  },
  insightBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    padding: 16,
    marginTop: 8,
    marginBottom: 16,
  },
  insightText: {
    fontSize: 14,
    lineHeight: 22,
    color: '#334155',
  },
  refreshBtn: {
    backgroundColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    borderRadius: 12,
    gap: 8,
  },
  refreshBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  hintText: {
    fontSize: 11,
    color: '#94a3b8',
    textAlign: 'center',
    marginTop: 12,
  },
  savedText: {
    fontSize: 14,
    color: '#10b981',
    fontWeight: '800',
    marginBottom: 6,
    marginTop: -10,
  },
  addReserveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#10b981',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    gap: 4,
  },
  addReserveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContainer: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    elevation: 10,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1e293b',
    marginBottom: 8,
  },
  modalSub: {
    fontSize: 13,
    color: '#64748b',
    marginBottom: 20,
    lineHeight: 18,
  },
  modalLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
    marginTop: 12,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    paddingLeft: 12,
  },
  currencyPrefix: {
    fontSize: 15,
    fontWeight: '700',
    color: '#64748b',
    marginRight: 4,
  },
  modalInputAmount: {
    flex: 1,
    padding: 14,
    fontSize: 15,
    color: '#1e293b',
    minHeight: 52,
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    gap: 12,
  },
  cancelBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
  },
  cancelBtnText: {
    color: '#64748b',
    fontWeight: '700',
  },
  saveBtn: {
    flex: 2,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center',
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  }
});
