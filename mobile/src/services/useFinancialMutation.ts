import { useCallback, useEffect, useRef } from 'react';
import { AxiosRequestConfig } from 'axios';
import { postFinancialMutation } from './api';
import {
  createFinancialIntentId,
  isDefinitiveClientRejection,
  subscribeFinancialIntentClosed,
} from './idempotentMutation';

export function useFinancialMutation<T = any>(url: string) {
  const intentIdRef = useRef<string | null>(null);

  useEffect(() => subscribeFinancialIntentClosed((closedIntentId) => {
    if (intentIdRef.current === closedIntentId) {
      intentIdRef.current = null;
    }
  }), []);

  const mutate = useCallback(async (
    payload: Record<string, unknown>,
    config: AxiosRequestConfig = {},
  ) => {
    const intentId = intentIdRef.current ?? createFinancialIntentId();
    intentIdRef.current = intentId;

    try {
      const response = await postFinancialMutation<T>(url, payload, intentId, config);
      // The response interceptor closes the persisted intent and notifies this hook.
      // Clear defensively as well in case a custom adapter bypasses that listener.
      if (intentIdRef.current === intentId) intentIdRef.current = null;
      return response;
    } catch (error) {
      if (isDefinitiveClientRejection(error) && intentIdRef.current === intentId) {
        intentIdRef.current = null;
      }
      throw error;
    }
  }, [url]);

  const startNewIntent = useCallback(() => {
    intentIdRef.current = null;
  }, []);

  return { mutate, startNewIntent };
}
