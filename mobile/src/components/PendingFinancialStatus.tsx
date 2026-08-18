import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useNavigationState } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../services/AuthContext';
import {
  IdempotentOperation,
  listPendingOperationsForOwner,
  PendingOperationWithType,
  subscribeFinancialIntentClosed,
} from '../services/idempotentMutation';

const OPERATION_LABELS: Record<IdempotentOperation, [string, string]> = {
  bill_create: ['fatura', 'faturas'],
  income_create: ['renda', 'rendas'],
  reserve_add: ['adição à reserva', 'adições à reserva'],
  recurring_template_create: ['conta recorrente', 'contas recorrentes'],
};

const operationSummary = (pending: PendingOperationWithType[]) => {
  const counts = new Map<IdempotentOperation, number>();
  for (const item of pending) {
    counts.set(item.operation, (counts.get(item.operation) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([operation, count]) => `${count} ${OPERATION_LABELS[operation][count === 1 ? 0 : 1]}`)
    .join(', ');
};

/**
 * Privacy-safe durable status for ambiguous financial work.
 *
 * The banner intentionally exposes only operation categories/counts. It never
 * renders the persisted payload, amount, title or idempotency key. Route changes,
 * foreground transitions, authenticated-owner changes and authoritative intent
 * closure refresh the owner-scoped SecureStore-backed pending state so a form can
 * be closed without making an unresolved financial action disappear from the UI.
 */
export default function PendingFinancialStatus() {
  const { session } = useAuth();
  const navigationIndex = useNavigationState((state) => state.index);
  const ownerId = session?.user.id ?? null;
  const ownerRef = useRef<string | null>(ownerId);
  const requestSequence = useRef(0);
  const [pending, setPending] = useState<PendingOperationWithType[]>([]);
  const [reconciliationUnavailable, setReconciliationUnavailable] = useState(false);

  ownerRef.current = ownerId;

  const refresh = useCallback(async () => {
    const requestedOwner = ownerRef.current;
    const requestId = ++requestSequence.current;
    if (!requestedOwner) {
      setPending([]);
      setReconciliationUnavailable(false);
      return;
    }

    try {
      const records = await listPendingOperationsForOwner(requestedOwner);
      if (
        requestSequence.current === requestId
        && ownerRef.current === requestedOwner
      ) {
        setPending(records);
        setReconciliationUnavailable(false);
      }
    } catch {
      // Never disclose storage details, durable payloads or replay identifiers.
      // An unreadable ambiguity is nevertheless not equivalent to an empty set:
      // show a privacy-safe blocking state so the safety behavior is explainable.
      if (
        requestSequence.current === requestId
        && ownerRef.current === requestedOwner
      ) {
        setPending([]);
        setReconciliationUnavailable(true);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [ownerId, navigationIndex, refresh]);

  useEffect(() => subscribeFinancialIntentClosed(() => {
    void refresh();
  }), [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  if (!ownerId) return null;

  if (reconciliationUnavailable) {
    return (
      <View
        style={[styles.banner, styles.blockedBanner]}
        accessible
        accessibilityLiveRegion="assertive"
        accessibilityRole="alert"
        accessibilityLabel="Reconciliação financeira indisponível. O estado seguro de operações anteriores não pôde ser lido. Por segurança, novas operações financeiras podem ficar bloqueadas até que esse estado volte a ser legível."
      >
        <Ionicons accessibilityElementsHidden name="warning-outline" size={20} color="#991b1b" />
        <View style={styles.copy}>
          <Text style={[styles.title, styles.blockedTitle]}>Reconciliação financeira indisponível</Text>
          <Text style={[styles.text, styles.blockedText]}>
            O estado seguro de operações anteriores não pôde ser lido. Por segurança, novas operações financeiras podem ficar bloqueadas até que esse estado volte a ser legível.
          </Text>
        </View>
      </View>
    );
  }

  if (pending.length === 0) return null;

  const summary = operationSummary(pending);
  const count = pending.length;

  return (
    <View
      style={styles.banner}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityRole="summary"
      accessibilityLabel={`${count} operação financeira${count === 1 ? '' : 's'} com resultado não confirmado: ${summary}. Fechar um formulário não cancela essas operações; elas continuam pendentes de reconciliação.`}
    >
      <Ionicons accessibilityElementsHidden name="sync-circle-outline" size={20} color="#92400e" />
      <View style={styles.copy}>
        <Text style={styles.title}>
          {count} operação{count === 1 ? '' : 'ões'} com resultado não confirmado
        </Text>
        <Text style={styles.text}>
          {summary}. Fechar um formulário não cancela uma operação com resultado desconhecido; ela continua pendente de reconciliação.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#fde68a',
    backgroundColor: '#fffbeb',
  },
  blockedBanner: { borderTopColor: '#fecaca', backgroundColor: '#fef2f2' },
  copy: { flex: 1 },
  title: { color: '#78350f', fontSize: 13, lineHeight: 18, fontWeight: '800' },
  blockedTitle: { color: '#7f1d1d' },
  text: { marginTop: 2, color: '#92400e', fontSize: 12, lineHeight: 17 },
  blockedText: { color: '#991b1b' },
});