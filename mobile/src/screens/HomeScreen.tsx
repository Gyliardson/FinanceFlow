import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import api from '../services/api';
import { Ionicons } from '@expo/vector-icons';

interface Bill {
  id: string;
  amount: number;
  due_date: string;
  barcode: string;
  status: string;
}

export default function HomeScreen({ navigation }: any) {
  const [bills, setBills] = useState<Bill[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchBills = async () => {
    try {
      const response = await api.get('/bills');
      // A API FastAPI retorna {"data": [ ... ]}
      setBills(response.data.data || []);
    } catch (error) {
      console.error("Erro ao buscar boletos:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    const unsubscribe = navigation.addListener('focus', () => {
      setLoading(true);
      fetchBills();
    });
    return unsubscribe;
  }, [navigation]);

  const onRefresh = () => {
    setRefreshing(true);
    fetchBills();
  };

  const renderBill = ({ item }: { item: Bill }) => {
    const isPaid = item.status === 'paid' || item.status === 'aprovado';
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Fatura #{item.id.substring(0, 5)}</Text>
          <View style={[styles.badge, isPaid ? styles.badgePaid : styles.badgePending]}>
            <Text style={styles.badgeText}>{isPaid ? 'Pago' : 'Pendente'}</Text>
          </View>
        </View>
        <Text style={styles.cardAmount}>R$ {Number(item.amount).toFixed(2)}</Text>
        <Text style={styles.cardDate}>Vence: {item.due_date || 'Não especificada'}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>FinanceFlow</Text>
        <Text style={styles.subtitle}>Suas Faturas</Text>
      </View>
      
      {loading ? (
        <ActivityIndicator size="large" color="#3498db" style={styles.loader} />
      ) : (
        <FlatList
          data={bills}
          keyExtractor={(item) => item.id}
          renderItem={renderBill}
          contentContainerStyle={styles.listContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <Text style={styles.emptyText}>Nenhuma fatura encontrada.{'\n'}Adicione uma tocando no botão abaixo!</Text>
          }
        />
      )}

      <TouchableOpacity 
        style={styles.fab}
        onPress={() => navigation.navigate('Details')}
      >
        <Ionicons name="add" size={30} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8f9fa' },
  header: { 
    padding: 20, paddingTop: 50, backgroundColor: '#3498db', 
    borderBottomLeftRadius: 20, borderBottomRightRadius: 20, elevation: 5 
  },
  title: { fontSize: 28, fontWeight: 'bold', color: '#fff' },
  subtitle: { fontSize: 16, color: '#f1f2f6', marginTop: 5 },
  loader: { flex: 1, justifyContent: 'center' },
  listContainer: { padding: 16, paddingBottom: 100 },
  card: { 
    backgroundColor: '#fff', padding: 16, borderRadius: 12, marginBottom: 16, 
    elevation: 3, shadowColor: '#000', shadowOpacity: 0.1, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } 
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: '#2c3e50' },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  badgePaid: { backgroundColor: '#2ecc71' },
  badgePending: { backgroundColor: '#e74c3c' },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: 'bold' },
  cardAmount: { fontSize: 24, fontWeight: 'bold', color: '#2c3e50', marginBottom: 4 },
  cardDate: { fontSize: 14, color: '#7f8c8d' },
  emptyText: { textAlign: 'center', color: '#7f8c8d', marginTop: 50, fontSize: 16, lineHeight: 24 },
  fab: { 
    position: 'absolute', bottom: 30, right: 30, width: 60, height: 60, borderRadius: 30, 
    backgroundColor: '#3498db', justifyContent: 'center', alignItems: 'center', 
    elevation: 6, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 4, shadowOffset: { width: 0, height: 3 } 
  }
});
