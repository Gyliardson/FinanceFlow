import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { scheduleNotificationsForBill } from '../services/NotificationService';
import { useFinancialMutation } from '../services/useFinancialMutation';

export default function RecurringBillScreen({ navigation }: any) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [recurringDay, setRecurringDay] = useState('');
  const [loading, setLoading] = useState(false);
  const recurringMutation = useFinancialMutation('/recurring-bills');
  const intentLocked = recurringMutation.hasActiveIntent;

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

  const handleDayChange = (text: string) => {
    const numericValue = text.replace(/[^0-9]/g, '');
    if (numericValue === '') {
      setRecurringDay('');
      return;
    }
    const day = parseInt(numericValue, 10);
    if (day >= 1 && day <= 31) setRecurringDay(String(day));
    else if (day > 31) setRecurringDay('31');
  };

  const handleSave = async () => {
    if (loading) return;
    if (!title.trim()) {
      Alert.alert('Campo obrigatório', 'Informe o título da conta.');
      return;
    }
    if (!amount) {
      Alert.alert('Campo obrigatório', 'Informe o valor mensal da conta.');
      return;
    }
    if (!recurringDay) {
      Alert.alert('Campo obrigatório', 'Informe o dia do vencimento mensal.');
      return;
    }

    const cleanAmount = Number(amount.replace(',', '.'));
    if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
      Alert.alert('Valor inválido', 'Informe um valor maior que zero.');
      return;
    }

    setLoading(true);
    try {
      const response = await recurringMutation.mutate({
        title: title.trim(),
        description: description.trim() || null,
        amount: cleanAmount,
        recurring_day: parseInt(recurringDay, 10),
        frequency: 'monthly',
      });

      if (response.data?.data?.[0]) {
        const newBill = response.data.data[0];
        scheduleNotificationsForBill(newBill.id, title.trim(), newBill.due_date).catch(() => undefined);
      }

      Alert.alert(
        'Conta recorrente criada',
        `“${title.trim()}” será cobrada todo dia ${recurringDay} de cada mês.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }],
      );
    } catch {
      Alert.alert(
        'Resultado ainda não confirmado',
        'Os valores desta intenção foram bloqueados. Tente novamente para reutilizar a mesma identidade e o payload original; sair desta tela e iniciar outro cadastro cria uma nova intenção.',
      );
    } finally {
      setLoading(false);
    }
  };

  const editable = !loading && !intentLocked;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.iconRow}>
            <Ionicons accessibilityElementsHidden name="repeat" size={28} color="#6d28d9" />
            <Text accessibilityRole="header" style={styles.title}>Nova conta recorrente</Text>
          </View>
          <Text style={styles.subtitle}>Configure uma conta mensal. O FinanceFlow gera as próximas instâncias e pode avisar antes do vencimento.</Text>
        </View>

        <View style={styles.form}>
          {intentLocked && <Text style={styles.intentNotice}>Resultado anterior indeterminado: campos bloqueados para que o retry repita exatamente a mesma intenção.</Text>}
          <Text nativeID="recurring-title-label" style={styles.inputLabel}>Título da conta</Text>
          <TextInput accessibilityLabel="Título da conta recorrente" accessibilityLabelledBy="recurring-title-label" editable={editable} style={styles.input} value={title} onChangeText={setTitle} placeholder="Ex.: Internet, aluguel, streaming" placeholderTextColor="#64748b" maxLength={100} returnKeyType="next" />
          <Text nativeID="recurring-description-label" style={styles.inputLabel}>Descrição opcional</Text>
          <TextInput accessibilityLabel="Descrição opcional da conta recorrente" accessibilityLabelledBy="recurring-description-label" editable={editable} style={[styles.input, styles.descriptionInput]} value={description} onChangeText={setDescription} placeholder="Anotações, contrato ou referência" placeholderTextColor="#64748b" multiline textAlignVertical="top" maxLength={255} />
          <Text nativeID="recurring-amount-label" style={styles.inputLabel}>Valor mensal</Text>
          <View style={styles.moneyInput}><Text style={styles.moneyPrefix}>R$</Text><TextInput accessibilityLabel="Valor mensal em reais" accessibilityLabelledBy="recurring-amount-label" editable={editable} style={styles.moneyTextInput} keyboardType="numeric" value={amount} onChangeText={handleAmountChange} placeholder="0,00" placeholderTextColor="#64748b" returnKeyType="next" /></View>
          <Text nativeID="recurring-day-label" style={styles.inputLabel}>Dia do vencimento</Text>
          <TextInput accessibilityLabel="Dia do vencimento mensal, de 1 a 31" accessibilityHint="Em meses mais curtos, o backend aplica a regra mensal validada" accessibilityLabelledBy="recurring-day-label" editable={editable} style={styles.input} keyboardType="number-pad" value={recurringDay} onChangeText={handleDayChange} placeholder="Ex.: 10" placeholderTextColor="#64748b" maxLength={2} returnKeyType="done" onSubmitEditing={handleSave} />

          <View accessible accessibilityLabel="Notificações: lembretes podem ser enviados antes do vencimento quando permitidos no dispositivo." style={styles.infoBox}>
            <Ionicons accessibilityElementsHidden name="notifications-outline" size={20} color="#1d4ed8" />
            <Text style={styles.infoText}>Se as notificações estiverem permitidas, o aplicativo pode enviar lembretes antes do vencimento.</Text>
          </View>

          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Cadastrar conta recorrente" accessibilityHint={intentLocked ? 'Repete a mesma intenção recorrente com os valores originais' : 'Salva esta conta e gera o primeiro vencimento mensal'} accessibilityState={{ disabled: loading, busy: loading }} style={[styles.saveButton, loading && styles.saveButtonDisabled]} onPress={handleSave} disabled={loading}>
            {loading ? <ActivityIndicator accessibilityLabel="Salvando conta recorrente" color="#fff" /> : <Text style={styles.saveButtonText}>{intentLocked ? 'Tentar mesma intenção' : 'Cadastrar conta recorrente'}</Text>}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' }, content: { paddingBottom: 40 },
  header: { padding: 24, backgroundColor: '#fff', elevation: 2, marginBottom: 16, borderBottomLeftRadius: 20, borderBottomRightRadius: 20 }, iconRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 }, title: { flexShrink: 1, fontSize: 22, lineHeight: 28, fontWeight: '800', color: '#1e293b', marginLeft: 10 }, subtitle: { fontSize: 14, color: '#475569', lineHeight: 21 },
  form: { padding: 20, backgroundColor: '#fff', marginHorizontal: 16, borderRadius: 15, elevation: 3, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, marginBottom: 30 }, intentNotice: { padding: 10, borderRadius: 10, backgroundColor: '#fffbeb', color: '#92400e', fontSize: 12, lineHeight: 18, fontWeight: '700', marginBottom: 12 }, inputLabel: { fontSize: 13, color: '#334155', fontWeight: '700', marginBottom: 8 }, input: { minHeight: 52, backgroundColor: '#f8fafc', borderRadius: 10, paddingHorizontal: 15, paddingVertical: 14, marginBottom: 20, fontSize: 16, color: '#1e293b', borderWidth: 1, borderColor: '#cbd5e1' }, descriptionInput: { minHeight: 88 }, moneyInput: { minHeight: 52, flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 10, borderWidth: 1, borderColor: '#cbd5e1', marginBottom: 20, paddingLeft: 15 }, moneyPrefix: { color: '#475569', fontWeight: '700', fontSize: 16 }, moneyTextInput: { flex: 1, minHeight: 50, paddingHorizontal: 8, color: '#1e293b', fontSize: 16 }, infoBox: { flexDirection: 'row', backgroundColor: '#eff6ff', padding: 14, borderRadius: 10, alignItems: 'flex-start', marginBottom: 20, borderWidth: 1, borderColor: '#bfdbfe' }, infoText: { fontSize: 13, color: '#334155', marginLeft: 10, flex: 1, lineHeight: 19 }, saveButton: { minHeight: 52, backgroundColor: '#6d28d9', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center', justifyContent: 'center', elevation: 3 }, saveButtonDisabled: { opacity: 0.65 }, saveButtonText: { color: '#fff', fontSize: 15, lineHeight: 20, fontWeight: '900', textAlign: 'center' },
});
