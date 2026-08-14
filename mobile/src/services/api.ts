import axios from 'axios';
import {
  clearPendingOperation,
  getOrCreatePendingOperation,
  IdempotentOperation,
} from './idempotentMutation';

type AccessTokenProvider = () => Promise<string | null> | string | null;
type AuthenticatedUserIdProvider = () => Promise<string | null> | string | null;

let accessTokenProvider: AccessTokenProvider | null = null;
let authenticatedUserIdProvider: AuthenticatedUserIdProvider | null = null;

export function configureApiAccessTokenProvider(provider: AccessTokenProvider | null) {
  accessTokenProvider = provider;
}

export function configureApiAuthenticatedUserIdProvider(provider: AuthenticatedUserIdProvider | null) {
  authenticatedUserIdProvider = provider;
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
  const token = accessTokenProvider ? await accessTokenProvider() : null;

  config.headers.delete('X-API-KEY');
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  } else {
    config.headers.delete('Authorization');
  }

  const operation = operationForRequest(config.method, config.url);
  if (operation) {
    const ownerId = authenticatedUserIdProvider ? await authenticatedUserIdProvider() : null;
    if (!ownerId) {
      throw new Error('Authenticated user identity is required for financial mutations.');
    }
    const rawPayload = config.data && typeof config.data === 'object' ? config.data : {};
    const pending = await getOrCreatePendingOperation(ownerId, operation, rawPayload);
    config.headers.set('Idempotency-Key', pending.key);
    pendingMetadataByKey.set(pending.key, { ownerId, operation, key: pending.key });
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
    // Network loss and 5xx responses intentionally retain the operation identity:
    // PostgreSQL may already have committed, so a later retry must reuse the key.
    return Promise.reject(error);
  },
);

export default api;
