import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ActivityIndicator, Alert, Modal, FlatList
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';

export default function IncomeScreen({ navigation }: any) {
  const [incomes, setIncomes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);

  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('salary'); // salary, extra, adjustment

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue) {
      const val = (Number(numericValue) / 100).toFixed(2);
      setAmount(val.replace('.', ','));
    } else {
      setAmount('');
    }
  };

  const fetchIncomes = async () => {
    try {
      const response = await api.get('/incomes');
      setIncomes(response.data.data || []);
    } catch (error) {
      console.error(error);
      Alert.alert('Erro', 'Não foi possível carregar as rendas.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      fetchIncomes();
    });
    return unsubscribe;
  }, [navigation]);

  const handleSave = async () => {
    if (!title || !amount) {
      Alert.alert('Erro', 'Título e Valor são obrigatórios.');
      return;
    }

    const nAmount = parseFloat(amount.replace(',', '.'));
    if (isNaN(nAmount)) {
      Alert.alert('Erro', 'Valor inválido.');
      return;
    }

    try {
      const payload = {
        title,
        amount: nAmount,
        date: new Date().toISOString().split('T')[0],
        description: description || null,
        type,
        is_recurring: false
      };

      await api.post('/incomes', payload);
      Alert.alert('Sucesso', 'Renda adicionada!');
      setModalVisible(false);
      resetForm();
      fetchIncomes();
    } catch (error) {
      console.error(error);
      Alert.alert('Erro', 'Falha ao salvar a renda.');
    }
  };

  const resetForm = () => {
    setTitle('');
    setAmount('');
    setDescription('');
    setType('salary');
  };

  const renderIncome = ({ item }: { item: any }) => {
    let iconName: any = 'cash';
    let iconColor = '#10b981';

    if (item.type === 'extra') {
      iconName = 'briefcase';
      iconColor = '#3b82f6';
    } else if (item.type === 'adjustment') {
      iconName = 'options';
      iconColor = '#f59e0b';
    }

    return (
      <View style={styles.card}>
        <View style={styles.cardLeft}>
          <View style={[styles.cardIcon, { backgroundColor: iconColor }]}>
            <Ionicons name={iconName} size={20} color="#fff" />
          </View>
        </View>
        <View style={styles.cardCenter}>
          <Text style={styles.cardTitle}>{item.title}</Text>
          {item.description ? <Text style={styles.cardDesc}>{item.description}</Text> : null}
          <Text style={styles.cardDate}>{new Date(item.date).toLocaleDateString('pt-BR')}</Text>
        </View>
        <View style={styles.cardRight}>
          <Text style={styles.cardAmount}>R$ {Number(item.amount).toFixed(2)}</Text>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.loaderContainer}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={incomes}
        keyExtractor={item => item.id}
        renderItem={renderIncome}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="wallet-outline" size={48} color="#cbd5e1" />
            <Text style={styles.emptyText}>Nenhuma renda registrada ainda.</Text>
          </View>
        }
      />

      <TouchableOpacity
        style={styles.fab}
        onPress={() => setModalVisible(true)}
      >
        <Ionicons name="add" size={28} color="#fff" />
      </TouchableOpacity>

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={true}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <Text style={styles.modalTitle}>Adicionar Renda / Ajuste</Text>
            
            <Text style={styles.label}>Tipo</Text>
            <View style={styles.typeRow}>
              <TouchableOpacity
                style={[styles.typeBtn, type === 'salary' && styles.typeBtnActive]}
                onPress={() => setType('salary')}
              >
                <Text style={[styles.typeBtnText, type === 'salary' && { color: '#fff' }]}>Salário</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.typeBtn, type === 'extra' && styles.typeBtnActiveExtra]}
                onPress={() => setType('extra')}
              >
                <Text style={[styles.typeBtnText, type === 'extra' && { color: '#fff' }]}>Extra</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.typeBtn, type === 'adjustment' && styles.typeBtnActiveAdj]}
                onPress={() => setType('adjustment')}
              >
                <Text style={[styles.typeBtnText, type === 'adjustment' && { color: '#fff' }]}>Ajuste Manual</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Título *</Text>
            <TextInput
              style={styles.input}
              placeholder="Ex: Salário, iFood..."
              value={title}
              onChangeText={setTitle}
            />

            <Text style={styles.label}>Valor*</Text>
            <View style={styles.inputWrapper}>
              <Text style={styles.currencyPrefix}>R$</Text>
              <TextInput
                style={styles.inputAmount}
                placeholder="0,00"
                keyboardType="numeric"
                value={amount}
                onChangeText={handleAmountChange}
              />
            </View>

            <Text style={styles.label}>Descrição (Opcional)</Text>
            <TextInput
              style={styles.input}
              placeholder="Ex: Pagamento semanal..."
              value={description}
              onChangeText={setDescription}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => {
                  setModalVisible(false);
                  resetForm();
                }}
              >
                <Text style={styles.cancelBtnText}>Cancelar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.saveBtn}
                onPress={handleSave}
              >
                <Text style={styles.saveBtnText}>Salvar</Text>
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
    backgroundColor: '#f1f5f9'
  },
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  list: {
    padding: 16,
    paddingBottom: 100
  },
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
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e293b'
  },
  cardDesc: {
    fontSize: 12,
    color: '#64748b',
    marginTop: 2
  },
  cardDate: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 4
  },
  cardRight: {
    marginLeft: 10
  },
  cardAmount: {
    fontSize: 16,
    fontWeight: '800',
    color: '#10b981'
  },
  empty: {
    alignItems: 'center',
    marginTop: 60
  },
  emptyText: {
    color: '#94a3b8',
    marginTop: 12,
    fontSize: 14
  },
  fab: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#10b981',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 6,
    shadowColor: '#10b981',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 4 },
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end'
  },
  modalContainer: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    elevation: 10,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1e293b',
    marginBottom: 20
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
    marginBottom: 6,
    marginTop: 12
  },
  input: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 10,
    padding: 14,
    fontSize: 15,
    color: '#1e293b',
    minHeight: 52,
  },
  inputAmount: {
    flex: 1,
    padding: 14,
    fontSize: 15,
    color: '#1e293b',
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
  typeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  typeBtn: {
    flex: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    alignItems: 'center'
  },
  typeBtnActive: {
    backgroundColor: '#10b981',
    borderColor: '#10b981'
  },
  typeBtnActiveExtra: {
    backgroundColor: '#3b82f6',
    borderColor: '#3b82f6'
  },
  typeBtnActiveAdj: {
    backgroundColor: '#f59e0b',
    borderColor: '#f59e0b'
  },
  typeBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b'
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    gap: 12
  },
  cancelBtn: {
    flex: 1,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#f1f5f9',
    alignItems: 'center'
  },
  cancelBtnText: {
    color: '#64748b',
    fontWeight: '700'
  },
  saveBtn: {
    flex: 2,
    padding: 14,
    borderRadius: 12,
    backgroundColor: '#10b981',
    alignItems: 'center'
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16
  }
});
