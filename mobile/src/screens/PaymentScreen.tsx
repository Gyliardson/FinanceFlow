import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, FlatList,
  ActivityIndicator, Alert, Image, Platform
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import api from '../services/api';
import { cancelNotificationsForBill } from '../services/NotificationService';

interface Bill {
  id: string;
  description: string;
  amount: number;
  due_date: string;
  status: string;
}

export default function PaymentScreen({ navigation, route }: any) {
  const [pendingBills, setPendingBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Se veio da tela de compartilhamento com uma imagem prévia
  const sharedImageUri = route?.params?.sharedImageUri || null;

  useEffect(() => {
    fetchPendingBills();
    if (sharedImageUri) {
      setReceiptUri(sharedImageUri);
    }
  }, []);

  const fetchPendingBills = async () => {
    try {
      const response = await api.get('/bills/pending');
      setPendingBills(response.data.data || []);
    } catch (error) {
      console.error('Erro ao buscar pendentes:', error);
      Alert.alert('Erro', 'Não foi possível carregar as faturas pendentes.');
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
      // Pagar sem comprovante
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
                cancelNotificationsForBill(selectedBill.id).catch(console.warn);
                Alert.alert('✅ Pago!', `"${selectedBill.description}" foi registrada como paga!`, [
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

    // Pagar com comprovante
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', {
        uri: receiptUri,
        name: `comprovante_${selectedBill.id}.jpg`,
        type: 'image/jpeg',
      } as any);

      const response = await api.post(`/bills/${selectedBill.id}/pay`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 120000, // 2 minutos para upload de imagens grandes
      });

      cancelNotificationsForBill(selectedBill.id).catch(console.warn);

      Alert.alert(
        '✅ Pagamento Registrado!',
        `"${selectedBill.description}" foi paga e o comprovante salvo no histórico.`,
        [{ text: 'Excelente!', onPress: () => navigation.goBack() }]
      );
    } catch (error: any) {
      console.error('Erro pagamento:', error?.response?.data || error.message);
      const detail = error?.response?.data?.detail;
      const isTimeout = error?.code === 'ECONNABORTED';
      const errorMsg = isTimeout
        ? 'O envio demorou demais. Verifique sua conexão e tente novamente com uma imagem menor.'
        : detail || 'Não foi possível processar o pagamento. Tente novamente.';
      Alert.alert('Erro no Pagamento', errorMsg);
    } finally {
      setUploading(false);
    }
  };

  const getDaysUntilDue = (dueDate: string) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(dueDate + 'T00:00:00');
    const diff = Math.ceil((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    return diff;
  };

  const renderBill = ({ item }: { item: Bill }) => {
    const isSelected = selectedBill?.id === item.id;
    const daysUntil = getDaysUntilDue(item.due_date);
    const isOverdue = daysUntil < 0;
    const isUrgent = daysUntil >= 0 && daysUntil <= 3;

    return (
      <TouchableOpacity
        style={[
          styles.billCard,
          isSelected && styles.billCardSelected,
          isOverdue && styles.billCardOverdue,
        ]}
        onPress={() => setSelectedBill(item)}
        activeOpacity={0.7}
      >
        <View style={styles.billCardRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.billTitle, isSelected && { color: '#fff' }]} numberOfLines={1}>
              {item.description}
            </Text>
            <Text style={[styles.billAmount, isSelected && { color: '#e8f8f5' }]}>
              R$ {Number(item.amount).toFixed(2)}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[styles.billDue, isSelected && { color: '#e8f8f5' }]}>
              {item.due_date ? new Date(item.due_date + 'T00:00:00').toLocaleDateString('pt-BR') : '-'}
            </Text>
            {isOverdue && (
              <View style={styles.overdueTag}>
                <Text style={styles.overdueTagText}>VENCIDA!</Text>
              </View>
            )}
            {isUrgent && !isOverdue && (
              <View style={[styles.overdueTag, { backgroundColor: '#f39c12' }]}>
                <Text style={styles.overdueTagText}>{daysUntil === 0 ? 'HOJE!' : `${daysUntil}d`}</Text>
              </View>
            )}
          </View>
          {isSelected && (
            <Ionicons name="checkmark-circle" size={28} color="#fff" style={{ marginLeft: 10 }} />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Registrar Pagamento</Text>
        <Text style={styles.headerSubtitle}>
          Escolha a fatura que você pagou e anexe o comprovante.
        </Text>
      </View>

      {/* Comprovante Section */}
      <View style={styles.receiptSection}>
        {receiptUri ? (
          <View style={styles.receiptPreview}>
            <Image source={{ uri: receiptUri }} style={styles.receiptImage} />
            <TouchableOpacity style={styles.removeReceipt} onPress={() => setReceiptUri(null)}>
              <Ionicons name="close-circle" size={28} color="#e74c3c" />
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.receiptButtons}>
            <TouchableOpacity style={styles.receiptBtn} onPress={handlePickReceipt}>
              <Ionicons name="images" size={24} color="#3498db" />
              <Text style={styles.receiptBtnText}>Galeria</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.receiptBtn, { borderColor: '#e67e22' }]} onPress={handleTakePhoto}>
              <Ionicons name="camera" size={24} color="#e67e22" />
              <Text style={[styles.receiptBtnText, { color: '#e67e22' }]}>Fotografar</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Lista de faturas pendentes */}
      <Text style={styles.sectionTitle}>Selecione qual conta foi paga:</Text>

      {loading ? (
        <ActivityIndicator size="large" color="#3498db" style={{ marginTop: 30 }} />
      ) : (
        <FlatList
          data={pendingBills}
          keyExtractor={(item) => item.id}
          renderItem={renderBill}
          contentContainerStyle={styles.listContainer}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              Nenhuma fatura pendente.{'\n'}Todas as contas estão em dia! 🎉
            </Text>
          }
        />
      )}

      {/* Botão de confirmar */}
      <TouchableOpacity
        style={[styles.confirmButton, (!selectedBill || uploading) && styles.confirmButtonDisabled]}
        onPress={handleConfirmPayment}
        disabled={!selectedBill || uploading}
      >
        {uploading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <View style={styles.confirmContent}>
            <Ionicons name="wallet" size={22} color="#fff" />
            <Text style={styles.confirmText}>
              {selectedBill
                ? `  Confirmar Pagamento de "${selectedBill.description.substring(0, 20)}..."`
                : '  Selecione uma fatura acima'}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa' },
  header: {
    padding: 20,
    paddingTop: 15,
    backgroundColor: '#27ae60',
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    elevation: 5,
  },
  headerTitle: { fontSize: 24, fontWeight: 'bold', color: '#fff' },
  headerSubtitle: { fontSize: 13, color: '#d5f5e3', marginTop: 5 },
  receiptSection: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 10,
  },
  receiptButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  receiptBtn: {
    flex: 0.48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#3498db',
    backgroundColor: '#fff',
    elevation: 2,
  },
  receiptBtnText: {
    marginLeft: 8,
    fontSize: 14,
    fontWeight: 'bold',
    color: '#3498db',
  },
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
    top: 5,
    right: 5,
    backgroundColor: '#fff',
    borderRadius: 14,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#2c3e50',
    marginHorizontal: 16,
    marginBottom: 8,
  },
  listContainer: {
    paddingHorizontal: 16,
    paddingBottom: 90,
  },
  billCard: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    marginBottom: 10,
    elevation: 2,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  billCardSelected: {
    backgroundColor: '#27ae60',
    borderColor: '#1e8449',
  },
  billCardOverdue: {
    borderColor: '#e74c3c',
    borderWidth: 2,
  },
  billCardRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  billTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#2c3e50',
  },
  billAmount: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#2c3e50',
    marginTop: 2,
  },
  billDue: {
    fontSize: 12,
    color: '#7f8c8d',
  },
  overdueTag: {
    backgroundColor: '#e74c3c',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginTop: 4,
  },
  overdueTagText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  emptyText: {
    textAlign: 'center',
    color: '#7f8c8d',
    marginTop: 40,
    fontSize: 16,
    lineHeight: 24,
  },
  confirmButton: {
    position: 'absolute',
    bottom: 20,
    left: 16,
    right: 16,
    backgroundColor: '#27ae60',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    elevation: 6,
  },
  confirmButtonDisabled: {
    backgroundColor: '#95a5a6',
  },
  confirmContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  confirmText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900',
  },
});
