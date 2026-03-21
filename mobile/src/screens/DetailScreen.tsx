import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

export default function DetailScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Detalhes da Fatura</Text>
      <Text style={styles.subtitle}>Aqui implementaremos envio de arquivos e consulta à API via OCR.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#f5f5f5', alignItems: 'center', justifyContent: 'center', padding: 20
  },
  title: {
    fontSize: 22, fontWeight: 'bold', color: '#2c3e50', marginBottom: 10
  },
  subtitle: {
    fontSize: 16, color: '#7f8c8d', textAlign: 'center'
  }
});
