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

const OPERATION_LABEL: Record<IdempotentOperation, [string, string]> = {
  bill_create: ['fatura', 'faturas'],
  income_create: ['renda', 'rendas'],
  reserve_add: ['adição à reserva', 'adições à reserva'],
  recurring_template_create: ['conta recorrente', 'contas recorrentes'],
};

const acknowledgeAdditionalIntent = (
  operation: IdempotentOperation,
  unresolvedCount: number,
): Promise<void> => new Promise((resolve) => {
  const label = OPERATION_LABEL[operation][unresolvedCount === 1 ? 0 : 1];
  Alert.alert(
    'Operação anterior ainda não confirmada',
    `Há ${unresolvedCount} ${label} com resultado ainda não confirmado. Fechar o formulário anterior não cancelou essa operação. Ao continuar, você está criando uma operação financeira adicional, que poderá aparecer além da anterior quando a reconciliação terminar.`,
    [{
      text: 'Criar operação adicional',
      onPress: () => resolve(),
    }],
    { cancelable: false },
  );
});

export function useFinancialMutation<T = any>(url: string) {
  const intentIdRef = useRef<string | null>(null);
  const mutationInFlightRef = useRef(false);
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
    // React component state is presentation state, not a financial mutex. Claim
    // this hook synchronously before any awaited preflight so two rapid submits
    // cannot both observe an empty intent and manufacture distinct operations.
    if (mutationInFlightRef.current) {
      throw new Error('A financial mutation is already in progress for this form.');
    }
    mutationInFlightRef.current = true;

    try {
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
    } finally {
      // Release after every terminal transport/preflight outcome. Ambiguous
      // failures intentionally retain intentIdRef so a later deliberate retry
      // reuses the exact same durable identity and original payload.
      mutationInFlightRef.current = false;
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
