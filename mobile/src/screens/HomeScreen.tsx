import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';

export default function HomeScreen({ navigation }: any) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>FinanceFlow</Text>
      <Text style={styles.subtitle}>Sua lista de contas a pagar</Text>
      
      <TouchableOpacity 
        style={styles.button}
        onPress={() => navigation.navigate('Details')}
      >
        <Text style={styles.buttonText}>Adicionar Fatura (OCR)</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#f5f5f5', alignItems: 'center', justifyContent: 'center', padding: 20
  },
  title: {
    fontSize: 28, fontWeight: 'bold', color: '#2c3e50', marginBottom: 10
  },
  subtitle: {
    fontSize: 16, color: '#7f8c8d', marginBottom: 30, textAlign: 'center'
  },
  button: {
    backgroundColor: '#3498db', paddingVertical: 14, paddingHorizontal: 30, borderRadius: 8, elevation: 3
  },
  buttonText: {
    color: '#fff', fontSize: 16, fontWeight: '600'
  }
});
