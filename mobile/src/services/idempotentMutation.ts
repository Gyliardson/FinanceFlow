import AsyncStorage from '@react-native-async-storage/async-storage';

export type IdempotentOperation =
  | 'reserve_add'
  | 'bill_create'
  | 'income_create'
  | 'recurring_template_create';

interface PendingOperation {
  key: string;
  canonicalPayload: string;
  createdAt: number;
}

const LOCAL_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = normalizeValue((value as Record<string, unknown>)[key]);
        return result;
      }, {});
  }
  return value;
};

export const canonicalMutationPayload = (payload: Record<string, unknown>) =>
  JSON.stringify(normalizeValue(payload));

const ownerToken = (ownerId: string) => {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('Authenticated owner is required for financial mutations.');
  return encodeURIComponent(trimmed);
};

const pendingStorageKey = (ownerId: string, operation: IdempotentOperation) =>
  `@financeflow:idempotency:${ownerToken(ownerId)}:${operation}`;

const newOperationKey = () => {
  const randomPart = Math.random().toString(36).slice(2, 14);
  return `ff_${Date.now().toString(36)}_${randomPart}`;
};

const readPending = async (
  ownerId: string,
  operation: IdempotentOperation,
): Promise<PendingOperation[]> => {
  const raw = await AsyncStorage.getItem(pendingStorageKey(ownerId, operation));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - LOCAL_RETENTION_MS;
    return parsed.filter((item): item is PendingOperation => (
      item
      && typeof item.key === 'string'
      && typeof item.canonicalPayload === 'string'
      && typeof item.createdAt === 'number'
      && item.createdAt >= cutoff
    ));
  } catch {
    return [];
  }
};

const writePending = async (
  ownerId: string,
  operation: IdempotentOperation,
  operations: PendingOperation[],
) => {
  const storageKey = pendingStorageKey(ownerId, operation);
  if (operations.length === 0) {
    await AsyncStorage.removeItem(storageKey);
    return;
  }
  await AsyncStorage.setItem(storageKey, JSON.stringify(operations));
};

export const getOrCreatePendingOperation = async (
  ownerId: string,
  operation: IdempotentOperation,
  payload: Record<string, unknown>,
): Promise<PendingOperation> => {
  const canonicalPayload = canonicalMutationPayload(payload);
  const pending = await readPending(ownerId, operation);
  const existing = pending.find((item) => item.canonicalPayload === canonicalPayload);
  if (existing) return existing;

  const created: PendingOperation = {
    key: newOperationKey(),
    canonicalPayload,
    createdAt: Date.now(),
  };
  await writePending(ownerId, operation, [...pending, created]);
  return created;
};

export const clearPendingOperation = async (
  ownerId: string,
  operation: IdempotentOperation,
  key: string,
) => {
  const pending = await readPending(ownerId, operation);
  await writePending(ownerId, operation, pending.filter((item) => item.key !== key));
};

const isDefinitiveClientRejection = (error: any) => {
  const status = Number(error?.response?.status || 0);
  if (status < 400 || status >= 500) return false;
  // Request timeout/rate-limit style responses remain retryable with the SAME key.
  return status !== 408 && status !== 425 && status !== 429;
};

export const runIdempotentMutation = async <T>(
  ownerId: string,
  operation: IdempotentOperation,
  payload: Record<string, unknown>,
  request: (idempotencyKey: string) => Promise<T>,
): Promise<T> => {
  const pending = await getOrCreatePendingOperation(ownerId, operation, payload);
  try {
    const result = await request(pending.key);
    await clearPendingOperation(ownerId, operation, pending.key);
    return result;
  } catch (error) {
    // Network loss / 5xx means the server may already have committed. Preserve
    // the operation identity so reconnect, manual retry or app restart reuses it.
    if (isDefinitiveClientRejection(error)) {
      await clearPendingOperation(ownerId, operation, pending.key);
    }
    throw error;
  }
};

export const purgePendingOperationsForOwner = async (ownerId: string) => {
  await AsyncStorage.multiRemove(
    (['reserve_add', 'bill_create', 'income_create', 'recurring_template_create'] as IdempotentOperation[])
      .map((operation) => pendingStorageKey(ownerId, operation)),
  );
};
