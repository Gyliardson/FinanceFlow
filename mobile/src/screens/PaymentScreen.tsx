import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, Alert, Image
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { cancelNotificationsForBill } from '../services/NotificationService';
import { financialDateOnly, financialDaysBetween, formatFinancialDatePtBr } from '../services/financialDate';

interface Bill {
  id: string;
  description: string;
  amount: number;
  due_date: string;
  status: string;
}

const formatMoney = (value: number) => new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
}).format(Number(value || 0));

export default function PaymentScreen({ navigation, route }: any) {
  const [pendingBills, setPendingBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const sharedImageUri = route?.params?.sharedImageUri || null;

  useEffect(() => {
    fetchPendingBills();
    if (sharedImageUri) {
      setReceiptUri(sharedImageUri);
    }
  }, []);

  const fetchPendingBills = async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const response = await api.get('/bills/pending');
      setPendingBills(response.data.data || []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  };

  const handlePickReceipt = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return Alert.alert('Permissão necessária', 'Autorize o acesso à galeria para enviar comprovantes.');
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.length > 0) {
      setReceiptUri(result.assets[0].uri);
    }
  };

  const handleTakePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      return Alert.alert('Permissão necessária', 'Autorize o acesso à câmera.');
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.length > 0) {
      setReceiptUri(result.assets[0].uri);
    }
  };

  const handleConfirmPayment = async () => {
    if (!selectedBill) {
      Alert.alert('Selecione uma conta', 'Toque em uma das faturas pendentes abaixo para selecioná-la.');
      return;
    }

    if (!receiptUri) {
      Alert.alert(
        'Sem comprovante',
        'Deseja registrar o pagamento sem anexar um comprovante?',
        [
          { text: 'Cancelar', style: 'cancel' },
          {
            text: 'Sim, registrar',
            onPress: async () => {
              setUploading(true);
              try {
                await api.post(`/bills/${selectedBill.id}/pay-no-receipt`);
                cancelNotificationsForBill(selectedBill.id).catch(() => undefined);
                Alert.alert('Pagamento registrado', `“${selectedBill.description}” foi registrada como paga.`, [
                  { text: 'OK', onPress: () => navigation.goBack() }
                ]);
              } catch (error: any) {
                Alert.alert('Erro', error?.response?.data?.detail || 'Falha ao registrar pagamento.');
              } finally {
                setUploading(false);
              }
            }
          }
        ]
      );
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: receiptUri,
        name: `comprovante_${selectedBill.id}.jpg`,
        type: 'image/jpeg',
      } as any);

      await api.post(`/bills/${selectedBill.id}/pay`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      });

      cancelNotificationsForBill(selectedBill.id).catch(() => undefined);

      Alert.alert(
        'Pagamento registrado',
        `“${selectedBill.description}” foi paga e o comprovante foi salvo no histórico.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      const detail = error?.response?.data?.detail;
      const isTimeout = error?.code === 'ECONNABORTED';
      const errorMsg = isTimeout
        ? 'O envio demorou demais. Verifique sua conexão e tente novamente com uma imagem menor.'
        : detail || 'Não foi possível processar o pagamento. Tente novamente.';
      Alert.alert('Erro no pagamento', errorMsg);
    } finally {
      setUploading(false);
    }
  };

  const getDaysUntilDue = (dueDate: string) => {
    try {
      return financialDaysBetween(financialDateOnly(), dueDate);
    } catch {
      return 0;
    }
  };

  const renderBill = ({ item }: { item: Bill }) => {
    const isSelected = selectedBill?.id === item.id;
    const daysUntil = getDaysUntilDue(item.due_date);
    const isOverdue = daysUntil < 0;
    const isUrgent = daysUntil >= 0 && daysUntil <= 3;
    let dueLabel = 'sem vencimento';
    if (item.due_date) {
      try {
        dueLabel = formatFinancialDatePtBr(item.due_date);
      } catch {
        dueLabel = item.due_date;
      }
    }
    const statusLabel = isOverdue
      ? 'vencida'
      : isUrgent
        ? daysUntil === 0 ? 'vence hoje' : `vence em ${daysUntil} dias`
        : `vence em ${dueLabel}`;

    return (
      <TouchableOpacity
        accessibilityRole="radio"
        accessibilityLabel={`${item.description}, ${formatMoney(item.amount)}, ${statusLabel}`}
        accessibilityHint="Seleciona esta fatura para registrar o pagamento"
        accessibilityState={{ selected: isSelected }}
        style={[
          styles.billCard,
          isSelected && styles.billCardSelected,
          isOverdue && styles.billCardOverdue,
        ]}
        onPress={() => setSelectedBill(item)}
        activeOpacity={0.7}
      >
        <View style={styles.billCardRow}>
          <View style={styles.billMain}>
            <Text style={[styles.billTitle, isSelected && styles.textOnSelected]} numberOfLines={2}>
              {item.description}
            </Text>
            <Text style={[styles.billAmount, isSelected && styles.textOnSelected]}>
              {formatMoney(item.amount)}
            </Text>
          </View>
          <View style={styles.billMeta}>
            <Text style={[styles.billDue, isSelected && styles.textOnSelected]}>
              {dueLabel}
            </Text>
            {isOverdue && (
              <View style={styles.overdueTag}>
                <Text style={styles.overdueTagText}>Vencida</Text>
              </View>
            )}
            {isUrgent && !isOverdue && (
              <View style={[styles.overdueTag, styles.urgentTag]}>
                <Text style={styles.overdueTagText}>{daysUntil === 0 ? 'Hoje' : `${daysUntil}d`}</Text>
              </View>
            )}
          </View>
          {isSelected && (
            <Ionicons
              accessibilityElementsHidden
              name="checkmark-circle"
              size={28}
              color="#fff"
              style={styles.selectedIcon}
            />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderListState = () => {
    if (loading) {
      return (
        <View accessibilityLiveRegion="polite" style={styles.statePanel}>
          <ActivityIndicator accessibilityLabel="Carregando faturas pendentes" size="large" color="#2563eb" />
          <Text style={styles.stateTitle}>Carregando faturas</Text>
          <Text style={styles.stateText}>Buscando suas contas pendentes.</Text>
        </View>
      );
    }

    if (loadError) {
      return (
        <View accessibilityLiveRegion="polite" style={styles.statePanel}>
          <Ionicons accessibilityElementsHidden name="cloud-offline-outline" size={30} color="#b45309" />
          <Text style={styles.stateTitle}>Não foi possível carregar as faturas</Text>
          <Text style={styles.stateText}>Verifique sua conexão e tente novamente.</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Tentar carregar faturas novamente"
            style={styles.retryButton}
            onPress={fetchPendingBills}
          >
            <Text style={styles.retryButtonText}>Tentar novamente</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <FlatList
        accessibilityRole="radiogroup"
        data={pendingBills}
        keyExtractor={(item) => item.id}
        renderItem={renderBill}
        contentContainerStyle={styles.listContainer}
        ListEmptyComponent={
          <View style={styles.statePanel}>
            <Ionicons accessibilityElementsHidden name="checkmark-circle-outline" size={32} color="#15803d" />
            <Text style={styles.stateTitle}>Tudo em dia</Text>
            <Text style={styles.stateText}>Nenhuma fatura pendente para registrar agora.</Text>
          </View>
        }
      />
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.headerTitle}>Registrar pagamento</Text>
        <Text style={styles.headerSubtitle}>
          Escolha a fatura que você pagou e anexe o comprovante, se desejar.
        </Text>
      </View>

      <View style={styles.receiptSection}>
        {receiptUri ? (
          <View style={styles.receiptPreview}>
            <Image
              accessibilityLabel="Prévia do comprovante selecionado"
              source={{ uri: receiptUri }}
              style={styles.receiptImage}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Remover comprovante selecionado"
              accessibilityHint="Remove esta imagem antes de registrar o pagamento"
              hitSlop={8}
              style={styles.removeReceipt}
              onPress={() => setReceiptUri(null)}
            >
              <Ionicons accessibilityElementsHidden name="close-circle" size={30} color="#b91c1c" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.receiptButtons}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Selecionar comprovante da galeria"
              style={styles.receiptBtn}
              onPress={handlePickReceipt}
            >
              <Ionicons accessibilityElementsHidden name="images" size={24} color="#2563eb" />
              <Text style={styles.receiptBtnText}>Galeria</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Fotografar comprovante"
              style={[styles.receiptBtn, styles.cameraBtn]}
              onPress={handleTakePhoto}
            >
              <Ionicons accessibilityElementsHidden name="camera" size={24} color="#c2410c" />
              <Text style={[styles.receiptBtnText, styles.cameraBtnText]}>Fotografar</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <Text style={styles.sectionTitle}>Selecione a conta que foi paga</Text>
      <View style={styles.listArea}>{renderListState()}</View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={uploading
          ? 'Registrando pagamento'
          : selectedBill
            ? `Confirmar pagamento de ${selectedBill.description}`
            : 'Confirmar pagamento'}
        accessibilityHint={selectedBill ? 'Registra a fatura selecionada como paga' : 'Selecione uma fatura primeiro'}
        accessibilityState={{ disabled: !selectedBill || uploading, busy: uploading }}
        style={[styles.confirmButton, (!selectedBill || uploading) && styles.confirmButtonDisabled]}
        onPress={handleConfirmPayment}
        disabled={!selectedBill || uploading}
      >
        {uploading ? (
          <ActivityIndicator accessibilityLabel="Registrando pagamento" color="#fff" />
        ) : (
          <View style={styles.confirmContent}>
            <Ionicons accessibilityElementsHidden name="wallet" size={22} color="#fff" />
            <Text style={styles.confirmText} numberOfLines={2}>
              {selectedBill ? 'Confirmar pagamento' : 'Selecione uma fatura acima'}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    padding: 20,
    paddingTop: 15,
    backgroundColor: '#166534',
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    elevation: 5,
  },
  headerTitle: { fontSize: 24, fontWeight: '800', color: '#fff' },
  headerSubtitle: { fontSize: 14, lineHeight: 20, color: '#dcfce7', marginTop: 5 },
  receiptSection: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
  },
  receiptButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  receiptBtn: {
    flex: 1,
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2563eb',
    backgroundColor: '#fff',
    elevation: 1,
  },
  cameraBtn: { borderColor: '#c2410c' },
  receiptBtnText: {
    marginLeft: 8,
    fontSize: 14,
    fontWeight: '800',
    color: '#2563eb',
  },
  cameraBtnText: { color: '#c2410c' },
  receiptPreview: {
    alignItems: 'center',
    position: 'relative',
  },
  receiptImage: {
    width: '100%',
    height: 150,
    borderRadius: 12,
    resizeMode: 'cover',
  },
  removeReceipt: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    borderRadius: 22,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1e293b',
    marginHorizontal: 16,
    marginBottom: 8,
  },
  listArea: { flex: 1 },
  listContainer: {
    paddingHorizontal: 16,
    paddingBottom: 100,
    flexGrow: 1,
  },
  billCard: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 10,
    minHeight: 72,
    elevation: 2,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  billCardSelected: {
    backgroundColor: '#166534',
    borderColor: '#14532d',
  },
  billCardOverdue: {
    borderColor: '#b91c1c',
    borderWidth: 2,
  },
  billCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  billMain: { flex: 1, paddingRight: 8 },
  billMeta: { alignItems: 'flex-end' },
  billTitle: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '700',
    color: '#1e293b',
  },
  billAmount: {
    fontSize: 18,
    fontWeight: '800',
    color: '#0f172a',
    marginTop: 2,
  },
  billDue: {
    fontSize: 12,
    color: '#64748b',
  },
  textOnSelected: { color: '#fff' },
  overdueTag: {
    backgroundColor: '#b91c1c',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    marginTop: 4,
  },
  urgentTag: { backgroundColor: '#b45309' },
  overdueTagText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  selectedIcon: { marginLeft: 10 },
  statePanel: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
    minHeight: 180,
  },
  stateTitle: {
    textAlign: 'center',
    color: '#1e293b',
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '800',
    marginTop: 10,
  },
  stateText: {
    textAlign: 'center',
    color: '#64748b',
    marginTop: 4,
    fontSize: 14,
    lineHeight: 20,
  },
  retryButton: {
    minHeight: 44,
    justifyContent: 'center',
    marginTop: 16,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#1d4ed8',
  },
  retryButtonText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  confirmButton: {
    position: 'absolute',
    bottom: 20,
    left: 16,
    right: 16,
    minHeight: 54,
    backgroundColor: '#166534',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 6,
  },
  confirmButtonDisabled: {
    backgroundColor: '#64748b',
  },
  confirmContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  confirmText: {
    flexShrink: 1,
    color: '#fff',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '900',
    textAlign: 'center',
  },
});
