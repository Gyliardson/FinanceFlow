import axios from 'axios';
import {
  clearPendingOperation,
  IdempotentOperation,
  MutationSessionSnapshot,
  preparePendingMutation,
} from './idempotentMutation';

type AuthSessionSnapshotProvider = () =>
  Promise<MutationSessionSnapshot | null> | MutationSessionSnapshot | null;
type AuthSessionSnapshotValidator = (
  snapshot: MutationSessionSnapshot,
) => Promise<boolean> | boolean;

let authSessionSnapshotProvider: AuthSessionSnapshotProvider | null = null;
let authSessionSnapshotValidator: AuthSessionSnapshotValidator | null = null;

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

    const rawPayload = config.data && typeof config.data === 'object'
      ? config.data as Record<string, unknown>
      : {};
    const prepared = await preparePendingMutation(
      snapshot,
      operation,
      rawPayload,
      authSessionSnapshotValidator,
    );

    // The durable pending record owns both the key and the first submitted payload.
    // Retries must replay that exact snapshot instead of silently rebuilding fields.
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
    const status = Number(error?.response?.status || 0);
    const definitiveClientRejection = status >= 400 && status < 500
      && status !== 408
      && status !== 425
      && status !== 429;

    if (metadata && definitiveClientRejection) {
      await clearPendingOperation(metadata.ownerId, metadata.operation, metadata.key);
      pendingMetadataByKey.delete(metadata.key);
    }
    // Network loss and 5xx responses intentionally retain the original key+payload.
    return Promise.reject(error);
  },
);

export default api;
