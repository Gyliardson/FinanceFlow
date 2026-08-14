import { useCallback, useEffect, useRef, useState } from 'react';
import { AxiosRequestConfig } from 'axios';
import { postFinancialMutation } from './api';
import {
  createFinancialIntentId,
  isDefinitiveClientRejection,
  subscribeFinancialIntentClosed,
} from './idempotentMutation';

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
    clearLocalIntent();
  }, [clearLocalIntent]);

  return { mutate, startNewIntent, hasActiveIntent };
}
