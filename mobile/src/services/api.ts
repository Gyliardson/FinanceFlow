import axios, { AxiosRequestConfig } from 'axios';
import {
  clearPendingOperation,
  IdempotentOperation,
  isDefinitiveClientRejection,
  listPendingOperationsForOwner,
  MutationSessionSnapshot,
  preparePendingMutation,
} from './idempotentMutation';

type AuthSessionSnapshotProvider = () =>
  Promise<MutationSessionSnapshot | null> | MutationSessionSnapshot | null;
type AuthSessionSnapshotValidator = (
  snapshot: MutationSessionSnapshot,
) => Promise<boolean> | boolean;

type FinancialRequestConfig = AxiosRequestConfig & {
  financeflowIntentId?: string;
};

let authSessionSnapshotProvider: AuthSessionSnapshotProvider | null = null;
let authSessionSnapshotValidator: AuthSessionSnapshotValidator | null = null;
let reconciliationInFlight: Promise<void> | null = null;

export function configureApiAuthSessionSnapshotProvider(
  provider: AuthSessionSnapshotProvider | null,
  validator: AuthSessionSnapshotValidator | null,
) {
  authSessionSnapshotProvider = provider;
  authSessionSnapshotValidator = validator;
}

const api = axios.create({
  baseURL: process.env.EXPO_PUBLIC_API_URL,
  timeout: 120000,
});

const operationForRequest = (method?: string, url?: string): IdempotentOperation | null => {
  if ((method || '').toLowerCase() !== 'post') return null;
  const normalized = (url || '').split('?')[0].replace(/\/$/, '');
  if (normalized === '/add-bill') return 'bill_create';
  if (normalized === '/incomes') return 'income_create';
  if (normalized === '/insights/reserve') return 'reserve_add';
  if (normalized === '/recurring-bills') return 'recurring_template_create';
  return null;
};

const routeForOperation = (operation: IdempotentOperation): string => {
  if (operation === 'bill_create') return '/add-bill';
  if (operation === 'income_create') return '/incomes';
  if (operation === 'reserve_add') return '/insights/reserve';
  return '/recurring-bills';
};

type PendingRequestMetadata = {
  ownerId: string;
  operation: IdempotentOperation;
  key: string;
};

const pendingMetadataByKey = new Map<string, PendingRequestMetadata>();

const requestIdempotencyKey = (config: any): string | null => {
  const headers = config?.headers;
  if (!headers) return null;
  const value = typeof headers.get === 'function'
    ? headers.get('Idempotency-Key')
    : headers['Idempotency-Key'] ?? headers['idempotency-key'];
  return typeof value === 'string' && value ? value : null;
};

api.interceptors.request.use(async (config) => {
  const snapshot = authSessionSnapshotProvider
    ? await authSessionSnapshotProvider()
    : null;

  config.headers.delete('X-API-KEY');
  if (snapshot) {
    config.headers.set('Authorization', `Bearer ${snapshot.accessToken}`);
  } else {
    config.headers.delete('Authorization');
  }

  const operation = operationForRequest(config.method, config.url);
  if (operation) {
    if (!snapshot || !authSessionSnapshotValidator) {
      throw new Error('A coherent authenticated session is required for financial mutations.');
    }

    const intentId = (config as FinancialRequestConfig).financeflowIntentId;
    if (!intentId) {
      throw new Error('Explicit logical intent identity is required for financial mutations.');
    }

    const rawPayload = config.data && typeof config.data === 'object'
      ? config.data as Record<string, unknown>
      : {};
    const prepared = await preparePendingMutation(
      snapshot,
      operation,
      intentId,
      rawPayload,
      authSessionSnapshotValidator,
    );

    // The durable pending record owns both the key and the first submitted payload.
    // The explicit intent id selects that record; payload equality is never used as
    // the identity of the user's action.
    config.data = prepared.originalPayload;
    config.headers.set('Authorization', `Bearer ${prepared.accessToken}`);
    config.headers.set('Idempotency-Key', prepared.key);
    pendingMetadataByKey.set(prepared.key, {
      ownerId: prepared.ownerId,
      operation,
      key: prepared.key,
    });
  }

  return config;
});

api.interceptors.response.use(
  async (response) => {
    const key = requestIdempotencyKey(response.config);
    const metadata = key ? pendingMetadataByKey.get(key) : undefined;
    if (metadata) {
      await clearPendingOperation(metadata.ownerId, metadata.operation, metadata.key);
      pendingMetadataByKey.delete(metadata.key);
    }
    return response;
  },
  async (error) => {
    const config = error?.config;
    const key = requestIdempotencyKey(config);
    const metadata = key ? pendingMetadataByKey.get(key) : undefined;

    if (metadata && isDefinitiveClientRejection(error)) {
      await clearPendingOperation(metadata.ownerId, metadata.operation, metadata.key);
      pendingMetadataByKey.delete(metadata.key);
    }
    // Network loss, auth/session loss, 5xx, 408/425/429 retain the original
    // explicit intent so it can be reconciled with the same key+payload later.
    return Promise.reject(error);
  },
);

export const postFinancialMutation = <T = any>(
  url: string,
  payload: Record<string, unknown>,
  intentId: string,
  config: AxiosRequestConfig = {},
) => api.post<T>(
  url,
  payload,
  { ...config, financeflowIntentId: intentId } as FinancialRequestConfig,
);

export const reconcilePendingFinancialMutations = async (): Promise<void> => {
  if (reconciliationInFlight) return reconciliationInFlight;

  const run = (async () => {
    const snapshot = authSessionSnapshotProvider
      ? await authSessionSnapshotProvider()
      : null;
    if (!snapshot || !authSessionSnapshotValidator) return;

    const pending = await listPendingOperationsForOwner(snapshot.userId);
    for (const operation of pending) {
      if (!(await authSessionSnapshotValidator(snapshot))) return;
      try {
        await postFinancialMutation(
          routeForOperation(operation.operation),
          operation.originalPayload,
          operation.intentId,
        );
      } catch {
        // The response interceptor applies the lifecycle policy. Retryable/ambiguous
        // failures remain durable; definitive client rejections are removed. Never
        // log the private financial payload while reconciling.
      }
    }
  })();

  reconciliationInFlight = run;
  try {
    await run;
  } finally {
    if (reconciliationInFlight === run) reconciliationInFlight = null;
  }
};

export default api;
