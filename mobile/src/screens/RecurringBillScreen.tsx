import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, ScrollView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { scheduleNotificationsForBill } from '../services/NotificationService';

export default function RecurringBillScreen({ navigation }: any) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [recurringDay, setRecurringDay] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAmountChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue) {
      let valNum = Number(numericValue) / 100;
      if (valNum > 1000000) valNum = 1000000;
      const val = valNum.toFixed(2);
      setAmount(val.replace('.', ','));
    } else {
      setAmount('');
    }
  };

  const handleDayChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue === '') {
      setRecurringDay('');
      return;
    }
    const day = parseInt(numericValue, 10);
    if (day >= 1 && day <= 31) {
      setRecurringDay(String(day));
    } else if (day > 31) {
      setRecurringDay('31');
    }
  };

  const handleSave = async () => {
    if (!title.trim()) {
      Alert.alert('Campo obrigatório', 'Informe o título/nome da conta.');
      return;
    }
    if (!amount) {
      Alert.alert('Campo obrigatório', 'Informe o valor da conta.');
      return;
    }
    if (!recurringDay) {
      Alert.alert('Campo obrigatório', 'Informe o dia do vencimento mensal.');
      return;
    }

    const cleanAmount = parseFloat(amount.replace(',', '.'));
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      Alert.alert('Valor inválido', 'Digite um valor numérico correto.');
      return;
    }

    setLoading(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        amount: cleanAmount,
        recurring_day: parseInt(recurringDay, 10),
        frequency: 'monthly',
      };

      const response = await api.post('/recurring-bills', payload);
      
      // Agendar notificações para a primeira instância em background
      if (response.data?.data?.[0]) {
        const newBill = response.data.data[0];
        scheduleNotificationsForBill(newBill.id, title.trim(), newBill.due_date).catch(err => {
          console.warn('Erro fatal ao agendar notificações em background:', err);
        });
      }
      
      Alert.alert(
        '✅ Conta Criada!',
        `"${title}" será cobrada todo dia ${recurringDay} de cada mês. Você receberá notificações automáticas antes do vencimento.`,
        [{ text: 'Perfeito!', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      console.error('Erro ao criar conta recorrente:', error?.response?.data || error.message);
      Alert.alert('Erro', error?.response?.data?.detail || 'Não foi possível cadastrar a conta recorrente.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      <View style={styles.header}>
        <View style={styles.iconRow}>
          <Ionicons name="repeat" size={28} color="#8e44ad" />
          <Text style={styles.title}>Nova Conta Recorrente</Text>
        </View>
        <Text style={styles.subtitle}>
          Configure uma conta que se repete todo mês. Você será notificado automaticamente antes de cada vencimento.
        </Text>
      </View>

      <View style={styles.form}>
        <Text style={styles.inputLabel}>Título da Conta *</Text>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          placeholder="Ex: Internet Vivo, Aluguel, Netflix..."
          placeholderTextColor="#95a5a6"
          maxLength={100}
        />

        <Text style={styles.inputLabel}>Descrição (opcional)</Text>
        <TextInput
          style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
          value={description}
          onChangeText={setDescription}
          placeholder="Anotações extras, número do contrato, etc."
          placeholderTextColor="#95a5a6"
          multiline
          maxLength={255}
        />

        <Text style={styles.inputLabel}>Valor Mensal (R$) *</Text>
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          value={amount}
          onChangeText={handleAmountChange}
          placeholder="0,00"
          placeholderTextColor="#95a5a6"
        />

        <Text style={styles.inputLabel}>Dia do Vencimento (1-31) *</Text>
        <TextInput
          style={styles.input}
          keyboardType="numeric"
          value={recurringDay}
          onChangeText={handleDayChange}
          placeholder="Ex: 10"
          placeholderTextColor="#95a5a6"
          maxLength={2}
        />

        <View style={styles.infoBox}>
          <Ionicons name="notifications-outline" size={20} color="#2980b9" />
          <Text style={styles.infoText}>
            Você receberá lembretes 3 dias antes do vencimento, e alertas reforçados no dia caso não registre o pagamento.
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.saveButton, loading && styles.saveButtonDisabled]}
          onPress={handleSave}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <View style={styles.saveButtonContent}>
              <Ionicons name="checkmark-circle" size={20} color="#fff" />
              <Text style={styles.saveButtonText}>  Cadastrar Conta Recorrente</Text>
            </View>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa' },
  header: {
    padding: 25,
    backgroundColor: '#fff',
    elevation: 2,
    marginBottom: 15,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  iconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#2c3e50',
    marginLeft: 10,
  },
  subtitle: {
    fontSize: 13,
    color: '#7f8c8d',
    lineHeight: 20,
  },
  form: {
    padding: 20,
    backgroundColor: '#fff',
    marginHorizontal: 16,
    borderRadius: 15,
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    marginBottom: 30,
  },
  inputLabel: {
    fontSize: 13,
    color: '#34495e',
    fontWeight: 'bold',
    marginBottom: 8,
  },
  input: {
    backgroundColor: '#f1f2f6',
    borderRadius: 10,
    paddingHorizontal: 15,
    paddingVertical: 14,
    marginBottom: 20,
    fontSize: 16,
    color: '#2c3e50',
    borderWidth: 1,
    borderColor: '#dcdde1',
  },
  infoBox: {
    flexDirection: 'row',
    backgroundColor: '#eaf6fd',
    padding: 14,
    borderRadius: 10,
    alignItems: 'flex-start',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#bde0f5',
  },
  infoText: {
    fontSize: 12,
    color: '#2c3e50',
    marginLeft: 10,
    flex: 1,
    lineHeight: 18,
  },
  saveButton: {
    backgroundColor: '#8e44ad',
    paddingVertical: 16,
    borderRadius: 10,
    alignItems: 'center',
    elevation: 3,
  },
  saveButtonDisabled: {
    opacity: 0.6,
  },
  saveButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '900',
  },
});
