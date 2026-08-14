import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ActivityIndicator, Alert, Modal, FlatList, KeyboardAvoidingView, Platform, ScrollView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { financialDateOnly, formatFinancialDatePtBr } from '../services/financialDate';

interface Income {
  id: string;
  title: string;
  amount: number;
  date: string;
  description?: string | null;
  type: 'salary' | 'extra' | 'adjustment';
}

const formatMoney = (value: number) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
}).format(Number(value || 0));

const formatDateOnly = (value: string) => {
  try {
    return formatFinancialDatePtBr(value);
  } catch {
    return value;
  }
};

export default function IncomeScreen({ navigation }: any) {
  const [incomes, setIncomes] = useState<Income[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<Income['type']>('salary');

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue) {
      let valNum = Number(numericValue) / 100;
      if (valNum > 1000000) valNum = 1000000;
      setAmount(valNum.toFixed(2).replace('.', ','));
    } else {
      setAmount('');
    }
  };

  const fetchIncomes = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await api.get('/incomes');
      setIncomes(response.data.data || []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', fetchIncomes);
    return unsubscribe;
  }, [navigation]);

  const handleSave = async () => {
    if (saving) return;
    if (!title.trim() || !amount) {
      Alert.alert('Dados incompletos', 'Título e valor são obrigatórios.');
      return;
    }

    const nAmount = Number(amount.replace(',', '.'));
    if (!Number.isFinite(nAmount) || nAmount <= 0) {
      Alert.alert('Valor inválido', 'Informe um valor maior que zero.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        amount: nAmount,
        date: financialDateOnly(),
        description: description.trim() || null,
        type,
        is_recurring: false
      };

      await api.post('/incomes', payload);
      setModalVisible(false);
      resetForm();
      await fetchIncomes();
      Alert.alert('Renda adicionada', 'O lançamento foi salvo com sucesso.');
    } catch {
      Alert.alert('Não foi possível salvar', 'Confira sua conexão e tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  const resetForm = () => {
    setTitle('');
    setAmount('');
    setDescription('');
    setType('salary');
  };

  const closeModal = () => {
    if (saving) return;
    setModalVisible(false);
    resetForm();
  };

  const renderIncome = ({ item }: { item: Income }) => {
    let iconName: keyof typeof Ionicons.glyphMap = 'cash';
    let iconColor = '#15803d';

    if (item.type === 'extra') {
      iconName = 'briefcase';
      iconColor = '#1d4ed8';
    } else if (item.type === 'adjustment') {
      iconName = 'options';
      iconColor = '#b45309';
    }

    return (
      <View
        accessible
        accessibilityLabel={`${item.title}, ${formatMoney(item.amount)}, ${formatDateOnly(item.date)}`}
        style={styles.card}
      >
        <View style={styles.cardLeft}>
          <View style={[styles.cardIcon, { backgroundColor: iconColor }]}>
            <Ionicons accessibilityElementsHidden name={iconName} size={20} color="#fff" />
          </View>
        </View>
        <View style={styles.cardCenter}>
          <Text style={styles.cardTitle} numberOfLines={2}>{item.title}</Text>
          {item.description ? <Text style={styles.cardDesc} numberOfLines={3}>{item.description}</Text> : null}
          <Text style={styles.cardDate}>{formatDateOnly(item.date)}</Text>
        </View>
        <View style={styles.cardRight}>
          <Text style={styles.cardAmount} numberOfLines={1} adjustsFontSizeToFit>
            {formatMoney(item.amount)}
          </Text>
        </View>
      </View>
    );
  };

  const renderContent = () => {
    if (loading) {
      return (
        <View accessibilityLiveRegion="polite" style={styles.stateContainer}>
          <ActivityIndicator accessibilityLabel="Carregando rendas" size="large" color="#4f46e5" />
          <Text style={styles.stateTitle}>Carregando rendas</Text>
        </View>
      );
    }

    if (loadError) {
      return (
        <View accessibilityLiveRegion="polite" style={styles.stateContainer}>
          <Ionicons accessibilityElementsHidden name="cloud-offline-outline" size={34} color="#b45309" />
          <Text style={styles.stateTitle}>Não foi possível carregar as rendas</Text>
          <Text style={styles.stateText}>Verifique sua conexão e tente novamente.</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Tentar carregar rendas novamente"
            style={styles.retryBtn}
            onPress={fetchIncomes}
          >
            <Text style={styles.retryBtnText}>Tentar novamente</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <FlatList
        data={incomes}
        keyExtractor={item => item.id}
        renderItem={renderIncome}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.stateContainer}>
            <Ionicons accessibilityElementsHidden name="wallet-outline" size={42} color="#64748b" />
            <Text style={styles.stateTitle}>Nenhuma renda registrada</Text>
            <Text style={styles.stateText}>Adicione salário, renda extra ou um ajuste para começar.</Text>
          </View>
        }
      />
    );
  };

  return (
    <View style={styles.container}>
      {renderContent()}

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Adicionar renda"
        accessibilityHint="Abre o formulário para registrar uma nova renda"
        style={styles.fab}
        onPress={() => setModalVisible(true)}
      >
        <Ionicons accessibilityElementsHidden name="add" size={28} color="#fff" />
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}
        >
          <View accessibilityViewIsModal style={styles.modalContainer}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text accessibilityRole="header" style={styles.modalTitle}>Adicionar renda ou ajuste</Text>

              <Text style={styles.label}>Tipo</Text>
              <View accessibilityRole="radiogroup" style={styles.typeRow}>
                <TouchableOpacity
                  accessibilityRole="radio"
                  accessibilityLabel="Salário"
                  accessibilityState={{ selected: type === 'salary', disabled: saving }}
                  disabled={saving}
                  style={[styles.typeBtn, type === 'salary' && styles.typeBtnActive]}
                  onPress={() => setType('salary')}
                >
                  <Text style={[styles.typeBtnText, type === 'salary' && styles.typeBtnTextActive]}>Salário</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="radio"
                  accessibilityLabel="Renda extra"
                  accessibilityState={{ selected: type === 'extra', disabled: saving }}
                  disabled={saving}
                  style={[styles.typeBtn, type === 'extra' && styles.typeBtnActiveExtra]}
                  onPress={() => setType('extra')}
                >
                  <Text style={[styles.typeBtnText, type === 'extra' && styles.typeBtnTextActive]}>Extra</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="radio"
                  accessibilityLabel="Ajuste manual"
                  accessibilityState={{ selected: type === 'adjustment', disabled: saving }}
                  disabled={saving}
                  style={[styles.typeBtn, type === 'adjustment' && styles.typeBtnActiveAdj]}
                  onPress={() => setType('adjustment')}
                >
                  <Text style={[styles.typeBtnText, type === 'adjustment' && styles.typeBtnTextActive]}>Ajuste</Text>
                </TouchableOpacity>
              </View>

              <Text nativeID="income-title-label" style={styles.label}>Título</Text>
              <TextInput
                accessibilityLabel="Título da renda"
                accessibilityLabelledBy="income-title-label"
                editable={!saving}
                style={styles.input}
                placeholder="Ex.: Salário, iFood"
                value={title}
                onChangeText={setTitle}
                maxLength={100}
                returnKeyType="next"
              />

              <Text nativeID="income-amount-label" style={styles.label}>Valor</Text>
              <View style={styles.inputWrapper}>
                <Text style={styles.currencyPrefix}>R$</Text>
                <TextInput
                  accessibilityLabel="Valor da renda em reais"
                  accessibilityLabelledBy="income-amount-label"
                  editable={!saving}
                  style={styles.inputAmount}
                  placeholder="0,00"
                  keyboardType="numeric"
                  value={amount}
                  onChangeText={handleAmountChange}
                  returnKeyType="next"
                />
              </View>

              <Text nativeID="income-description-label" style={styles.label}>Descrição opcional</Text>
              <TextInput
                accessibilityLabel="Descrição opcional da renda"
                accessibilityLabelledBy="income-description-label"
                editable={!saving}
                style={[styles.input, styles.descriptionInput]}
                placeholder="Ex.: Pagamento semanal"
                value={description}
                onChangeText={setDescription}
                maxLength={255}
                multiline
                textAlignVertical="top"
              />

              <View style={styles.modalActions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Cancelar cadastro de renda"
                  accessibilityState={{ disabled: saving }}
                  disabled={saving}
                  style={styles.cancelBtn}
                  onPress={closeModal}
                >
                  <Text style={styles.cancelBtnText}>Cancelar</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={saving ? 'Salvando renda' : 'Salvar renda'}
                  accessibilityState={{ disabled: saving, busy: saving }}
                  disabled={saving}
                  style={[styles.saveBtn, saving && styles.saveBtnDisabled]}
                  onPress={handleSave}
                >
                  {saving ? <ActivityIndicator accessibilityLabel="Salvando renda" color="#fff" /> : <Text style={styles.saveBtnText}>Salvar</Text>}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9'
  },
  list: {
    padding: 16,
    paddingBottom: 100,
    flexGrow: 1,
  },
  stateContainer: {
    flex: 1,
    minHeight: 240,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 28,
  },
  stateTitle: {
    marginTop: 12,
    textAlign: 'center',
    color: '#1e293b',
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '800',
  },
  stateText: {
    marginTop: 5,
    textAlign: 'center',
    color: '#64748b',
    fontSize: 14,
    lineHeight: 20,
  },
  retryBtn: {
    minHeight: 44,
    justifyContent: 'center',
    marginTop: 16,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#1d4ed8',
  },
  retryBtnText: { color: '#fff', fontWeight: '800' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowOffset: { width: 0, height: 2 },
  },
  cardLeft: {
    marginRight: 12,
  },
  cardIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center'
  },
  cardCenter: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
    color: '#1e293b'
  },
  cardDesc: {
    fontSize: 12,
    lineHeight: 17,
    color: '#64748b',
    marginTop: 2
  },
  cardDate: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 4
  },
  cardRight: {
    maxWidth: '42%',
    marginLeft: 10
  },
  cardAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: '#15803d'
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#15803d',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#15803d',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
    justifyContent: 'flex-end'
  },
  modalContainer: {
    maxHeight: '92%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    elevation: 10,
  },
  modalTitle: {
    fontSize: 20,
    lineHeight: 27,
    fontWeight: '800',
    color: '#1e293b',
    marginBottom: 12
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#475569',
    marginBottom: 6,
    marginTop: 12
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    color: '#1e293b',
    minHeight: 52,
  },
  descriptionInput: { minHeight: 88 },
  inputAmount: {
    flex: 1,
    minHeight: 52,
    padding: 14,
    fontSize: 15,
    color: '#1e293b',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 10,
    paddingLeft: 12,
  },
  currencyPrefix: {
    fontSize: 15,
    fontWeight: '700',
    color: '#64748b',
    marginRight: 4,
  },
  typeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  typeBtn: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 8,
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    alignItems: 'center'
  },
  typeBtnActive: {
    backgroundColor: '#15803d',
    borderColor: '#15803d'
  },
  typeBtnActiveExtra: {
    backgroundColor: '#1d4ed8',
    borderColor: '#1d4ed8'
  },
  typeBtnActiveAdj: {
    backgroundColor: '#b45309',
    borderColor: '#b45309'
  },
  typeBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#475569'
  },
  typeBtnTextActive: { color: '#fff' },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    gap: 12
  },
  cancelBtn: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center'
  },
  cancelBtnText: {
    color: '#475569',
    fontWeight: '700'
  },
  saveBtn: {
    flex: 2,
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: '#15803d',
    alignItems: 'center'
  },
  saveBtnDisabled: { opacity: 0.65 },
  saveBtnText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16
  }
});
