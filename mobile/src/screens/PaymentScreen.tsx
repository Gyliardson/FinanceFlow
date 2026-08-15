import React, { useEffect, useRef, useState } from 'react';
import {
  AppState, View, Text, StyleSheet, TouchableOpacity, FlatList,
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

type SupportedReceiptMime = 'image/jpeg' | 'image/png' | 'image/webp';
type PaymentReconciliation = 'paid' | 'not-paid' | 'unavailable';

interface ReceiptSelection {
  uri: string;
  mimeType: SupportedReceiptMime;
}

const RECEIPT_EXTENSION_BY_MIME: Record<SupportedReceiptMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const normalizeReceiptMime = (value?: string | null): SupportedReceiptMime | null => {
  const normalized = value?.split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'image/jpeg';
  if (normalized === 'image/png') return 'image/png';
  if (normalized === 'image/webp') return 'image/webp';
  return null;
};

const inferReceiptMimeFromPath = (value?: string | null): SupportedReceiptMime | null => {
  if (!value) return null;
  const clean = value.split(/[?#]/, 1)[0].toLowerCase();
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.webp')) return 'image/webp';
  return null;
};

const receiptSelectionFromAsset = (asset: ImagePicker.ImagePickerAsset): ReceiptSelection | null => {
  const mimeType = normalizeReceiptMime(asset.mimeType)
    || inferReceiptMimeFromPath(asset.fileName)
    || inferReceiptMimeFromPath(asset.uri);
  return mimeType ? { uri: asset.uri, mimeType } : null;
};

const isAmbiguousReceiptPaymentFailure = (error: any) => {
  if (!error?.response) return true;
  const status = Number(error.response.status || 0);
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
};

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
  const [routedBillUnavailable, setRoutedBillUnavailable] = useState(false);
  const [receipt, setReceipt] = useState<ReceiptSelection | null>(null);
  const [uploading, setUploading] = useState(false);
  const [paymentAttemptActive, setPaymentAttemptActive] = useState(false);
  const paymentAttemptLock = useRef(false);
  const refreshGeneration = useRef(0);

  const routedBillId = route?.params?.billId || null;
  const sharedImageUri = route?.params?.sharedImageUri || null;
  const sharedImageMimeType = normalizeReceiptMime(route?.params?.sharedImageMimeType)
    || inferReceiptMimeFromPath(route?.params?.sharedImageFileName)
    || inferReceiptMimeFromPath(sharedImageUri);
  const attemptBusy = paymentAttemptActive || uploading;

  const beginPaymentAttempt = () => {
    if (paymentAttemptLock.current) return false;
    paymentAttemptLock.current = true;
    setPaymentAttemptActive(true);
    return true;
  };

  const endPaymentAttempt = () => {
    paymentAttemptLock.current = false;
    setPaymentAttemptActive(false);
  };

  const fetchPendingBills = async () => {
    if (paymentAttemptLock.current) return;
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setLoadError(false);
    try {
      const response = await api.get('/bills/pending');
      const bills = (response.data.data || []) as Bill[];
      if (generation !== refreshGeneration.current || paymentAttemptLock.current) return;

      setPendingBills(bills);
      if (routedBillId) {
        const routedBill = bills.find((bill) => bill.id === routedBillId);
        setSelectedBill(routedBill || null);
        setRoutedBillUnavailable(Boolean(routedBillId && !routedBill));
      } else {
        setSelectedBill((current) => current
          ? bills.find((bill) => bill.id === current.id) || null
          : null);
        setRoutedBillUnavailable(false);
      }
    } catch {
      if (generation !== refreshGeneration.current || paymentAttemptLock.current) return;
      setLoadError(true);
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  };

  useEffect(() => {
    void fetchPendingBills();

    const unsubscribeFocus = navigation.addListener('focus', () => {
      if (!paymentAttemptLock.current) void fetchPendingBills();
    });
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !paymentAttemptLock.current) {
        void fetchPendingBills();
      }
    });

    return () => {
      refreshGeneration.current += 1;
      unsubscribeFocus();
      appStateSubscription.remove();
    };
  }, [navigation, routedBillId]);

  useEffect(() => {
    if (!paymentAttemptLock.current && sharedImageUri && sharedImageMimeType) {
      setReceipt({ uri: sharedImageUri, mimeType: sharedImageMimeType });
    }
  }, [sharedImageUri, sharedImageMimeType]);

  const reconcileReceiptPayment = async (billId: string): Promise<PaymentReconciliation> => {
    try {
      const response = await api.get(`/bills/${billId}/detail`);
      const status = String(response.data?.bill?.status || '').toLowerCase();
      return status === 'paid' || status === 'aprovado' ? 'paid' : 'not-paid';
    } catch {
      return 'unavailable';
    }
  };

  const selectReceiptAsset = (asset: ImagePicker.ImagePickerAsset) => {
    if (paymentAttemptLock.current) return;
    const selection = receiptSelectionFromAsset(asset);
    if (!selection) {
      Alert.alert(
        'Formato não identificado',
        'Selecione um comprovante JPEG, PNG ou WebP com formato reconhecível.',
      );
      return;
    }
    setReceipt(selection);
  };

  const handlePickReceipt = async () => {
    if (paymentAttemptLock.current) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      return Alert.alert('Permissão necessária', 'Autorize o acesso à galeria para enviar comprovantes.');
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.length > 0) {
      selectReceiptAsset(result.assets[0]);
    }
  };

  const handleTakePhoto = async () => {
    if (paymentAttemptLock.current) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      return Alert.alert('Permissão necessária', 'Autorize o acesso à câmera.');
    }

    const result = await ImagePicker.launchCameraAsync({
      quality: 0.8,
    });

    if (!result.canceled && result.assets?.length > 0) {
      selectReceiptAsset(result.assets[0]);
    }
  };

  const handleConfirmPayment = async () => {
    if (!selectedBill) {
      Alert.alert('Selecione uma conta', 'Toque em uma das faturas pendentes abaixo para selecioná-la.');
      return;
    }
    if (!beginPaymentAttempt()) return;

    const attemptBill = selectedBill;
    const attemptReceipt = receipt;

    if (!attemptReceipt) {
      Alert.alert(
        'Sem comprovante',
        'Deseja registrar o pagamento sem anexar um comprovante?',
        [
          { text: 'Cancelar', style: 'cancel', onPress: endPaymentAttempt },
          {
            text: 'Sim, registrar',
            onPress: async () => {
              setUploading(true);
              try {
                await api.post(`/bills/${attemptBill.id}/pay-no-receipt`);
                cancelNotificationsForBill(attemptBill.id).catch(() => undefined);
                Alert.alert('Pagamento registrado', `“${attemptBill.description}” foi registrada como paga.`, [
                  { text: 'OK', onPress: () => navigation.goBack() }
                ]);
              } catch (error: any) {
                const detail = error?.response?.data?.detail;
                if (isAmbiguousReceiptPaymentFailure(error)) {
                  const reconciliation = await reconcileReceiptPayment(attemptBill.id);
                  if (reconciliation === 'paid') {
                    cancelNotificationsForBill(attemptBill.id).catch(() => undefined);
                    Alert.alert(
                      'Pagamento confirmado',
                      `“${attemptBill.description}” já consta como paga após reconciliar o estado da fatura.`,
                      [{ text: 'OK', onPress: () => navigation.goBack() }],
                    );
                    return;
                  }

                  const message = reconciliation === 'not-paid'
                    ? 'O servidor ainda não mostra esta fatura como paga. Como a tentativa anterior pode ter sido concluída enquanto a resposta se perdeu, atualize os dados e confirme o estado da fatura antes de registrar novamente.'
                    : 'Não foi possível consultar o estado autoritativo da fatura. Atualize os dados e confirme se o pagamento foi registrado antes de tentar novamente.';
                  Alert.alert('Resultado não confirmado', message);
                  return;
                }

                Alert.alert('Erro no pagamento', detail || 'Não foi possível registrar o pagamento. Revise os dados e tente novamente.');
              } finally {
                setUploading(false);
                endPaymentAttempt();
              }
            }
          }
        ],
        { cancelable: true, onDismiss: endPaymentAttempt },
      );
      return;
    }

    setUploading(true);
    try {
      const extension = RECEIPT_EXTENSION_BY_MIME[attemptReceipt.mimeType];
      const formData = new FormData();
      formData.append('file', {
        uri: attemptReceipt.uri,
        name: `comprovante_${attemptBill.id}.${extension}`,
        type: attemptReceipt.mimeType,
      } as any);

      await api.post(`/bills/${attemptBill.id}/pay`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000,
      });

      cancelNotificationsForBill(attemptBill.id).catch(() => undefined);

      Alert.alert(
        'Pagamento registrado',
        `“${attemptBill.description}” foi paga e o comprovante foi salvo no histórico.`,
        [{ text: 'OK', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      const detail = error?.response?.data?.detail;
      if (isAmbiguousReceiptPaymentFailure(error)) {
        const reconciliation = await reconcileReceiptPayment(attemptBill.id);
        if (reconciliation === 'paid') {
          cancelNotificationsForBill(attemptBill.id).catch(() => undefined);
          Alert.alert(
            'Pagamento confirmado',
            `“${attemptBill.description}” já consta como paga após reconciliar o estado da fatura.`,
            [{ text: 'OK', onPress: () => navigation.goBack() }],
          );
          return;
        }

        const message = reconciliation === 'not-paid'
          ? 'O servidor ainda não mostra esta fatura como paga. Como a tentativa anterior pode ter ficado em processamento, atualize os dados e confirme o estado da fatura antes de enviar outro comprovante.'
          : 'Não foi possível consultar o estado autoritativo da fatura. Atualize os dados e confirme se o pagamento foi registrado antes de enviar outro comprovante.';
        Alert.alert('Resultado não confirmado', message);
        return;
      }

      Alert.alert('Erro no pagamento', detail || 'Não foi possível processar o pagamento. Revise os dados e tente novamente.');
    } finally {
      setUploading(false);
      endPaymentAttempt();
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
        accessibilityState={{ selected: isSelected, disabled: attemptBusy }}
        disabled={attemptBusy}
        style={[
          styles.billCard,
          isSelected && styles.billCardSelected,
          isOverdue && styles.billCardOverdue,
          attemptBusy && styles.controlDisabled,
        ]}
        onPress={() => {
          setSelectedBill(item);
          setRoutedBillUnavailable(false);
        }}
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
            accessibilityState={{ disabled: attemptBusy }}
            disabled={attemptBusy}
            style={[styles.retryButton, attemptBusy && styles.controlDisabled]}
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
        {receipt ? (
          <View style={styles.receiptPreview}>
            <Image
              accessibilityLabel="Prévia do comprovante selecionado"
              source={{ uri: receipt.uri }}
              style={styles.receiptImage}
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Remover comprovante selecionado"
              accessibilityHint="Remove esta imagem antes de registrar o pagamento"
              accessibilityState={{ disabled: attemptBusy }}
              disabled={attemptBusy}
              hitSlop={8}
              style={[styles.removeReceipt, attemptBusy && styles.controlDisabled]}
              onPress={() => {
                if (!paymentAttemptLock.current) setReceipt(null);
              }}
            >
              <Ionicons accessibilityElementsHidden name="close-circle" size={30} color="#b91c1c" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.receiptButtons}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Selecionar comprovante da galeria"
              accessibilityState={{ disabled: attemptBusy }}
              disabled={attemptBusy}
              style={[styles.receiptBtn, attemptBusy && styles.controlDisabled]}
              onPress={handlePickReceipt}
            >
              <Ionicons accessibilityElementsHidden name="images" size={24} color="#2563eb" />
              <Text style={styles.receiptBtnText}>Galeria</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Fotografar comprovante"
              accessibilityState={{ disabled: attemptBusy }}
              disabled={attemptBusy}
              style={[styles.receiptBtn, styles.cameraBtn, attemptBusy && styles.controlDisabled]}
              onPress={handleTakePhoto}
            >
              <Ionicons accessibilityElementsHidden name="camera" size={24} color="#c2410c" />
              <Text style={[styles.receiptBtnText, styles.cameraBtnText]}>Fotografar</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {routedBillUnavailable && !loading && !loadError && (
        <View style={styles.routedBillWarning} accessibilityLiveRegion="assertive">
          <Ionicons accessibilityElementsHidden name="alert-circle-outline" size={20} color="#92400e" />
          <View style={styles.routedBillWarningContent}>
            <Text style={styles.routedBillWarningTitle}>Esta fatura não está mais disponível para pagamento</Text>
            <Text style={styles.routedBillWarningText}>
              Ela pode ter sido paga, removida ou deixado de estar disponível nesta conta. Selecione outra fatura pendente se quiser registrar um pagamento diferente.
            </Text>
          </View>
        </View>
      )}

      <Text style={styles.sectionTitle}>Selecione a conta que foi paga</Text>
      <View style={styles.listArea}>{renderListState()}</View>

      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={attemptBusy
          ? 'Pagamento em andamento'
          : selectedBill
            ? `Confirmar pagamento de ${selectedBill.description}`
            : 'Confirmar pagamento'}
        accessibilityHint={selectedBill ? 'Registra a fatura selecionada como paga' : 'Selecione uma fatura primeiro'}
        accessibilityState={{ disabled: !selectedBill || attemptBusy, busy: attemptBusy }}
        style={[styles.confirmButton, (!selectedBill || attemptBusy) && styles.confirmButtonDisabled]}
        onPress={handleConfirmPayment}
        disabled={!selectedBill || attemptBusy}
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
  routedBillWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#f59e0b',
    backgroundColor: '#fffbeb',
  },
  routedBillWarningContent: { flex: 1 },
  routedBillWarningTitle: {
    color: '#78350f',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '800',
  },
  routedBillWarningText: {
    color: '#92400e',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 2,
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
  controlDisabled: { opacity: 0.55 },
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