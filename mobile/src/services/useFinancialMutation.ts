import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { AxiosRequestConfig } from 'axios';
import { postFinancialMutation } from './api';
import { getValidAuthSessionSnapshot } from './authSession';
import {
  createFinancialIntentId,
  IdempotentOperation,
  isDefinitiveClientRejection,
  listPendingOperationsForOwner,
  subscribeFinancialIntentClosed,
} from './idempotentMutation';

const ROUTE_OPERATION: Record<string, IdempotentOperation> = {
  '/add-bill': 'bill_create',
  '/incomes': 'income_create',
  '/insights/reserve': 'reserve_add',
  '/recurring-bills': 'recurring_template_create',
};

const OPERATION_LABEL: Record<IdempotentOperation, string> = {
  bill_create: 'fatura',
  income_create: 'renda',
  reserve_add: 'reserva',
  recurring_template_create: 'conta recorrente',
};

const acknowledgeAdditionalIntent = (
  operation: IdempotentOperation,
  unresolvedCount: number,
): Promise<void> => new Promise((resolve) => {
  const label = OPERATION_LABEL[operation];
  Alert.alert(
    'Operação anterior ainda não confirmada',
    `Há ${unresolvedCount} ${label}${unresolvedCount === 1 ? '' : 's'} com resultado ainda não confirmado. Fechar o formulário anterior não cancelou essa operação. Ao continuar, você está criando uma operação financeira adicional, que poderá aparecer além da anterior quando a reconciliação terminar.`,
    [{
      text: 'Criar operação adicional',
      onPress: resolve,
    }],
    { cancelable: false },
  );
});

export function useFinancialMutation<T = any>(url: string) {
  const intentIdRef = useRef<string | null>(null);
  const [hasActiveIntent, setHasActiveIntent] = useState(false);

  const clearLocalIntent = useCallback((intentId?: string) => {
    if (!intentId || intentIdRef.current === intentId) {
      intentIdRef.current = null;
      setHasActiveIntent(false);
    }
  }, []);

  useEffect(() => subscribeFinancialIntentClosed((closedIntentId) => {
    clearLocalIntent(closedIntentId);
  }), [clearLocalIntent]);

  const mutate = useCallback(async (
    payload: Record<string, unknown>,
    config: AxiosRequestConfig = {},
  ) => {
    // Retry-in-place never prompts and never manufactures a new identity.
    // Only a fresh form intent is gated when another durable operation of the
    // same kind still has an unknown outcome for the current authenticated owner.
    if (!intentIdRef.current) {
      const operation = ROUTE_OPERATION[url];
      const snapshot = operation ? await getValidAuthSessionSnapshot() : null;
      if (operation && snapshot) {
        const pending = await listPendingOperationsForOwner(snapshot.userId);
        const unresolvedCount = pending.filter((item) => item.operation === operation).length;
        if (unresolvedCount > 0) {
          await acknowledgeAdditionalIntent(operation, unresolvedCount);
        }
      }
    }

    const intentId = intentIdRef.current ?? createFinancialIntentId();
    intentIdRef.current = intentId;
    setHasActiveIntent(true);

    try {
      const response = await postFinancialMutation<T>(url, payload, intentId, config);
      clearLocalIntent(intentId);
      return response;
    } catch (error) {
      if (isDefinitiveClientRejection(error)) {
        clearLocalIntent(intentId);
      }
      throw error;
    }
  }, [clearLocalIntent, url]);

  const startNewIntent = useCallback(() => {
    // This clears only the form-local handle. Unknown durable outcomes are never
    // deleted here; the global unresolved status and next-submit acknowledgement
    // make that lifecycle explicit while automatic reconciliation remains safe.
    clearLocalIntent();
  }, [clearLocalIntent]);

  return { mutate, startNewIntent, hasActiveIntent };
}
