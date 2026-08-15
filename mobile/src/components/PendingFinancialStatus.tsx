import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import { useNavigationState } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../services/AuthContext';
import {
  IdempotentOperation,
  listPendingOperationsForOwner,
  PendingOperationWithType,
} from '../services/idempotentMutation';

const OPERATION_LABELS: Record<IdempotentOperation, string> = {
  bill_create: 'fatura',
  income_create: 'renda',
  reserve_add: 'reserva',
  recurring_template_create: 'conta recorrente',
};

const operationSummary = (pending: PendingOperationWithType[]) => {
  const counts = new Map<IdempotentOperation, number>();
  for (const item of pending) {
    counts.set(item.operation, (counts.get(item.operation) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([operation, count]) => `${count} ${OPERATION_LABELS[operation]}${count === 1 ? '' : 's'}`)
    .join(', ');
};

/**
 * Privacy-safe durable status for ambiguous financial work.
 *
 * The banner intentionally exposes only operation categories/counts. It never
 * renders the persisted payload, amount, title or idempotency key. Route changes,
 * foreground transitions and authenticated-owner changes refresh the owner-scoped
 * SecureStore-backed pending state so a form can be closed without making an
 * unresolved financial action disappear from the UI.
 */
export default function PendingFinancialStatus() {
  const { session } = useAuth();
  const navigationIndex = useNavigationState((state) => state.index);
  const ownerId = session?.user.id ?? null;
  const ownerRef = useRef<string | null>(ownerId);
  const requestSequence = useRef(0);
  const [pending, setPending] = useState<PendingOperationWithType[]>([]);

  ownerRef.current = ownerId;

  const refresh = useCallback(async () => {
    const requestedOwner = ownerRef.current;
    const requestId = ++requestSequence.current;
    if (!requestedOwner) {
      setPending([]);
      return;
    }

    try {
      const records = await listPendingOperationsForOwner(requestedOwner);
      if (
        requestSequence.current === requestId
        && ownerRef.current === requestedOwner
      ) {
        setPending(records);
      }
    } catch {
      // Pending-state visibility must never disclose storage errors or block the
      // authenticated navigator. Reconciliation remains the authoritative path.
      if (
        requestSequence.current === requestId
        && ownerRef.current === requestedOwner
      ) {
        setPending([]);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [ownerId, navigationIndex, refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  if (!ownerId || pending.length === 0) return null;

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
  copy: { flex: 1 },
  title: { color: '#78350f', fontSize: 13, lineHeight: 18, fontWeight: '800' },
  text: { marginTop: 2, color: '#92400e', fontSize: 12, lineHeight: 17 },
});
