import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface NetworkStatusProps {
  isOffline: boolean;
  cachedAt?: number | null;
  onRetry?: () => void;
}

function describeFreshness(cachedAt: number | null | undefined): string {
  if (!cachedAt || !Number.isFinite(cachedAt) || cachedAt <= 0) {
    return 'Exibindo dados salvos anteriormente; o horário da última atualização não está disponível.';
  }

  return `Última atualização salva: ${new Date(cachedAt).toLocaleString('pt-BR')}.`;
}

export default function NetworkStatus({ isOffline, cachedAt, onRetry }: NetworkStatusProps) {
  if (!isOffline) return null;
  const freshness = describeFreshness(cachedAt);

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityLabel={`Modo offline. ${freshness}`}
      style={styles.container}
    >
      <View style={styles.content}>
        <Ionicons accessibilityElementsHidden name="cloud-offline" size={18} color="#fff" />
        <View style={styles.copy}>
          <Text style={styles.title}>Você está offline</Text>
          <Text style={styles.text}>{freshness}</Text>
          <Text style={styles.readOnlyText}>Alterações financeiras exigem conexão.</Text>
        </View>
      </View>
      {onRetry && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Tentar atualizar dados"
          accessibilityHint="Tenta conectar novamente ao FinanceFlow"
          hitSlop={8}
          style={styles.retryBtn}
          onPress={onRetry}
        >
          <Text style={styles.retryText}>Tentar novamente</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#92400e',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginTop: 10,
    marginHorizontal: 16,
    borderRadius: 12,
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  content: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  copy: {
    flex: 1,
  },
  title: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '800',
  },
  text: {
    color: '#fef3c7',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '600',
  },
  readOnlyText: {
    color: '#fff7ed',
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '700',
    marginTop: 2,
  },
  retryBtn: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
});
