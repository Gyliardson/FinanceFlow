import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import InsightsScreen from './InsightsScreen';

export default function InsightsPrivacyScreen(props: any) {
  return (
    <View style={styles.container}>
      <View
        style={styles.notice}
        accessible
        accessibilityRole="summary"
        accessibilityLabel="Privacidade da análise por inteligência artificial. A atualização envia ao Google Gemini apenas saldo atual, sobra estimada e meta da reserva. Faturas, recibos e transações individuais não fazem parte desse envio."
      >
        <Ionicons accessibilityElementsHidden name="shield-checkmark-outline" size={20} color="#4338ca" />
        <Text style={styles.noticeText}>
          <Text style={styles.noticeTitle}>Privacidade da análise IA. </Text>
          Ao tocar em “Atualizar análise”, o FinanceFlow envia ao Google Gemini apenas saldo atual,
          sobra estimada e meta da reserva. Faturas, recibos e transações individuais não fazem parte
          desse envio.
        </Text>
      </View>
      <View style={styles.content}>
        <InsightsScreen {...props} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f1f5f9' },
  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    padding: 12,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    borderRadius: 12,
    backgroundColor: '#eef2ff',
  },
  noticeText: { flex: 1, color: '#3730a3', fontSize: 12, lineHeight: 18 },
  noticeTitle: { fontWeight: '800' },
  content: { flex: 1 },
});
