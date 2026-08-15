import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

export type IdempotentOperation =
  | 'reserve_add'
  | 'bill_create'
  | 'income_create'
  | 'recurring_template_create';

export interface PendingOperation {
  intentId: string;
  key: string;
  originalPayload: Record<string, unknown>;
  createdAt: number;
  state: 'pending';
}

export interface PendingOperationWithType extends PendingOperation {
  operation: IdempotentOperation;
}

export interface MutationSessionSnapshot {
  userId: string;
  accessToken: string;
  generation: number;
}

export interface PreparedPendingMutation extends PendingOperation {
  ownerId: string;
  accessToken: string;
  sessionGeneration: number;
}

type IntentClosedListener = (intentId: string) => void;

type PendingManifest = {
  version: 1;
  generation: string;
  chunks: number;
  totalLength: number;
};

const SECURE_CHUNK_SIZE = 1800;
const INTENT_ID_RE = /^fi_[A-Za-z0-9_-]{12,96}$/;
export const IDEMPOTENT_OPERATIONS: IdempotentOperation[] = [
  'reserve_add',
  'bill_create',
  'income_create',
  'recurring_template_create',
];

const storeQueues = new Map<string, Promise<void>>();
const intentClosedListeners = new Set<IntentClosedListener>();

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

export const createFinancialIntentId = () => {
  const randomPart = `${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`;
  return `fi_${Date.now().toString(36)}_${randomPart}`;
};

export const subscribeFinancialIntentClosed = (listener: IntentClosedListener): (() => void) => {
  intentClosedListeners.add(listener);
  return () => {
    intentClosedListeners.delete(listener);
  };
};

const notifyIntentClosed = (intentId: string) => {
  for (const listener of intentClosedListeners) listener(intentId);
};

const validateIntentId = (value: string) => {
  const intentId = typeof value === 'string' ? value.trim() : '';
  if (!INTENT_ID_RE.test(intentId)) {
    throw new Error('A valid explicit financial intent id is required.');
  }
  return intentId;
};

const ownerToken = (ownerId: string) => {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('Authenticated owner is required for financial mutations.');
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error('Authenticated owner cannot be represented as a SecureStore key.');
  }
  return trimmed;
};

const legacyOwnerToken = (ownerId: string) => {
  const trimmed = ownerId.trim();
  if (!trimmed) throw new Error('Authenticated owner is required for financial mutations.');
  return encodeURIComponent(trimmed);
};

const legacyAsyncPendingStorageKey = (ownerId: string, operation: IdempotentOperation) =>
  `@financeflow:idempotency:${legacyOwnerToken(ownerId)}:${operation}`;

export const pendingMutationStorageKey = (ownerId: string, operation: IdempotentOperation) =>
  `financeflow.idempotency.v5.${ownerToken(ownerId)}.${operation}.manifest`;

const pendingChunkKey = (
  ownerId: string,
  operation: IdempotentOperation,
  generation: string,
  index: number,
) => `financeflow.idempotency.v5.${ownerToken(ownerId)}.${operation}.${generation}.${index}`;

const newOperationKey = () => {
  const randomPart = Math.random().toString(36).slice(2, 14);
  return `ff_${Date.now().toString(36)}_${randomPart}`;
};

const newGeneration = () =>
  `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const parsePendingManifest = (raw: string): PendingManifest | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingManifest>;
    if (
      parsed.version !== 1
      || typeof parsed.generation !== 'string'
      || !/^[A-Za-z0-9._-]+$/.test(parsed.generation)
      || typeof parsed.chunks !== 'number'
      || !Number.isInteger(parsed.chunks)
      || parsed.chunks < 1
      || parsed.chunks > 4096
      || typeof parsed.totalLength !== 'number'
      || !Number.isInteger(parsed.totalLength)
      || parsed.totalLength < 1
    ) return null;
    return {
      version: 1,
      generation: parsed.generation,
      chunks: parsed.chunks,
      totalLength: parsed.totalLength,
    };
  } catch {
    return null;
  }
};

const cleanupPendingGeneration = async (
  ownerId: string,
  operation: IdempotentOperation,
  manifest: PendingManifest | null,
) => {
  if (!manifest) return;
  for (let index = 0; index < manifest.chunks; index += 1) {
    await SecureStore.deleteItemAsync(
      pendingChunkKey(ownerId, operation, manifest.generation, index),
    ).catch(() => undefined);
  }
};

const readSecurePendingRaw = async (
  ownerId: string,
  operation: IdempotentOperation,
): Promise<string | null> => {
  const manifestKey = pendingMutationStorageKey(ownerId, operation);
  const manifestRaw = await SecureStore.getItemAsync(manifestKey);
  if (manifestRaw === null) return null;
  const manifest = parsePendingManifest(manifestRaw);
  if (!manifest) {
    await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
    return null;
  }

  const chunks: string[] = [];
  for (let index = 0; index < manifest.chunks; index += 1) {
    const chunk = await SecureStore.getItemAsync(
      pendingChunkKey(ownerId, operation, manifest.generation, index),
    );
    if (chunk === null) {
      await cleanupPendingGeneration(ownerId, operation, manifest);
      await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
      return null;
    }
    chunks.push(chunk);
  }
  const raw = chunks.join('');
  if (raw.length !== manifest.totalLength) {
    await cleanupPendingGeneration(ownerId, operation, manifest);
    await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
    return null;
  }
  return raw;
};

const writeSecurePendingRaw = async (
  ownerId: string,
  operation: IdempotentOperation,
  raw: string,
) => {
  const manifestKey = pendingMutationStorageKey(ownerId, operation);
  const oldManifestRaw = await SecureStore.getItemAsync(manifestKey).catch(() => null);
  const oldManifest = oldManifestRaw ? parsePendingManifest(oldManifestRaw) : null;
  const generation = newGeneration();
  const chunks = raw.match(new RegExp(`.{1,${SECURE_CHUNK_SIZE}}`, 'gs')) ?? [];
  if (!chunks.length) throw new Error('Pending financial state cannot be empty');

  const manifest: PendingManifest = {
    version: 1,
    generation,
    chunks: chunks.length,
    totalLength: raw.length,
  };
  let written = 0;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await SecureStore.setItemAsync(
        pendingChunkKey(ownerId, operation, generation, index),
        chunks[index],
      );
      written += 1;
    }
    await SecureStore.setItemAsync(manifestKey, JSON.stringify(manifest));
  } catch (error) {
    for (let index = 0; index < written; index += 1) {
      await SecureStore.deleteItemAsync(
        pendingChunkKey(ownerId, operation, generation, index),
      ).catch(() => undefined);
    }
    throw error;
  }
  if (oldManifest && oldManifest.generation !== generation) {
    await cleanupPendingGeneration(ownerId, operation, oldManifest);
  }
};

const clearSecurePending = async (ownerId: string, operation: IdempotentOperation) => {
  const manifestKey = pendingMutationStorageKey(ownerId, operation);
  let manifest: PendingManifest | null = null;
  try {
    const raw = await SecureStore.getItemAsync(manifestKey);
    manifest = raw ? parsePendingManifest(raw) : null;
  } catch {
    // Continue: unreadable pending storage is never trusted.
  }
  await cleanupPendingGeneration(ownerId, operation, manifest);
  await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
};

const parsePayload = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const normalizePendingRecord = (item: unknown): PendingOperation | null => {
  if (!item || typeof item !== 'object') return null;
  const candidate = item as Partial<PendingOperation> & {
    canonicalPayload?: unknown;
  };

  if (
    typeof candidate.key !== 'string'
    || typeof candidate.createdAt !== 'number'
    || !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }

  let originalPayload = parsePayload(candidate.originalPayload);
  if (!originalPayload && typeof candidate.canonicalPayload === 'string') {
    try {
      originalPayload = parsePayload(JSON.parse(candidate.canonicalPayload));
    } catch {
      originalPayload = null;
    }
  }
  if (!originalPayload) return null;

  const explicitIntentId = typeof candidate.intentId === 'string' && INTENT_ID_RE.test(candidate.intentId)
    ? candidate.intentId
    : `fi_legacy_${candidate.key.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 99);

  return {
    intentId: explicitIntentId,
    key: candidate.key,
    originalPayload: JSON.parse(canonicalMutationPayload(originalPayload)) as Record<string, unknown>,
    createdAt: candidate.createdAt,
    state: 'pending',
  };
};

const writePendingUnlocked = async (
  ownerId: string,
  operation: IdempotentOperation,
  operations: PendingOperation[],
) => {
  if (operations.length === 0) {
    await clearSecurePending(ownerId, operation);
    return;
  }
  await writeSecurePendingRaw(ownerId, operation, JSON.stringify(operations));
};

const readPendingUnlocked = async (
  ownerId: string,
  operation: IdempotentOperation,
): Promise<PendingOperation[]> => {
  const legacyAsyncKey = legacyAsyncPendingStorageKey(ownerId, operation);
  let raw = await readSecurePendingRaw(ownerId, operation);
  let migratedFromAsync = false;

  if (raw === null) {
    raw = await AsyncStorage.getItem(legacyAsyncKey);
    if (raw !== null) migratedFromAsync = true;
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }

  // Ambiguous financial intents are not a cache. Wall-clock age cannot prove
  // whether the server committed an operation whose response was lost, so a
  // structurally valid pending record remains durable until authoritative
  // success or a definitive client rejection closes it.
  const normalized = Array.isArray(parsed)
    ? parsed
      .map(normalizePendingRecord)
      .filter((item): item is PendingOperation => Boolean(item))
    : [];

  const seenIntentIds = new Set<string>();
  const unique = normalized.filter((item) => {
    if (seenIntentIds.has(item.intentId)) return false;
    seenIntentIds.add(item.intentId);
    return true;
  });

  if (migratedFromAsync || JSON.stringify(parsed) !== JSON.stringify(unique)) {
    await writePendingUnlocked(ownerId, operation, unique);
  }
  if (migratedFromAsync) {
    await AsyncStorage.removeItem(legacyAsyncKey);
  }

  return unique;
};

const withStoreLock = async <T>(
  ownerId: string,
  operation: IdempotentOperation,
  task: () => Promise<T>,
): Promise<T> => {
  const storageKey = pendingMutationStorageKey(ownerId, operation);
  const previous = storeQueues.get(storageKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  storeQueues.set(storageKey, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (storeQueues.get(storageKey) === queued) {
      storeQueues.delete(storageKey);
    }
  }
};

export const getOrCreatePendingOperation = async (
  ownerId: string,
  operation: IdempotentOperation,
  intentIdValue: string,
  payload: Record<string, unknown>,
): Promise<PendingOperation> => withStoreLock(ownerId, operation, async () => {
  const intentId = validateIntentId(intentIdValue);
  const pending = await readPendingUnlocked(ownerId, operation);
  const existing = pending.find((item) => item.intentId === intentId);
  if (existing) return existing;

  const originalPayload = JSON.parse(canonicalMutationPayload(payload)) as Record<string, unknown>;
  const created: PendingOperation = {
    intentId,
    key: newOperationKey(),
    originalPayload,
    createdAt: Date.now(),
    state: 'pending',
  };
  await writePendingUnlocked(ownerId, operation, [...pending, created]);
  return created;
});

export const listPendingOperationsForOwner = async (
  ownerId: string,
): Promise<PendingOperationWithType[]> => {
  const result: PendingOperationWithType[] = [];
  for (const operation of IDEMPOTENT_OPERATIONS) {
    const records = await withStoreLock(ownerId, operation, () => readPendingUnlocked(ownerId, operation));
    result.push(...records.map((record) => ({ ...record, operation })));
  }
  return result.sort((left, right) => left.createdAt - right.createdAt);
};

export const clearPendingOperation = async (
  ownerId: string,
  operation: IdempotentOperation,
  key: string,
) => {
  let closedIntentIds: string[] = [];
  await withStoreLock(ownerId, operation, async () => {
    const pending = await readPendingUnlocked(ownerId, operation);
    closedIntentIds = pending.filter((item) => item.key === key).map((item) => item.intentId);
    await writePendingUnlocked(ownerId, operation, pending.filter((item) => item.key !== key));
  });
  closedIntentIds.forEach(notifyIntentClosed);
};

export const preparePendingMutation = async (
  snapshot: MutationSessionSnapshot,
  operation: IdempotentOperation,
  intentId: string,
  payload: Record<string, unknown>,
  isSessionCurrent: (snapshot: MutationSessionSnapshot) => Promise<boolean> | boolean,
): Promise<PreparedPendingMutation> => {
  if (!(await isSessionCurrent(snapshot))) {
    throw new Error('Authenticated session changed before preparing a financial mutation.');
  }
  const pending = await getOrCreatePendingOperation(snapshot.userId, operation, intentId, payload);
  if (!(await isSessionCurrent(snapshot))) {
    throw new Error('Authenticated session changed while preparing a financial mutation.');
  }
  return {
    ...pending,
    ownerId: snapshot.userId,
    accessToken: snapshot.accessToken,
    sessionGeneration: snapshot.generation,
  };
};

export const isDefinitiveClientRejection = (error: any) => {
  const status = Number(error?.response?.status || 0);
  if (status < 400 || status >= 500) return false;
  return ![401, 403, 408, 425, 429].includes(status);
};

export const runIdempotentMutation = async <T>(
  ownerId: string,
  operation: IdempotentOperation,
  intentId: string,
  payload: Record<string, unknown>,
  request: (idempotencyKey: string, originalPayload: Record<string, unknown>) => Promise<T>,
): Promise<T> => {
  const pending = await getOrCreatePendingOperation(ownerId, operation, intentId, payload);
  try {
    const result = await request(pending.key, pending.originalPayload);
    await clearPendingOperation(ownerId, operation, pending.key);
    return result;
  } catch (error) {
    if (isDefinitiveClientRejection(error)) {
      await clearPendingOperation(ownerId, operation, pending.key);
    }
    throw error;
  }
};

export const purgePendingOperationsForOwner = async (ownerId: string) => {
  for (const operation of IDEMPOTENT_OPERATIONS) {
    await withStoreLock(ownerId, operation, async () => {
      await clearSecurePending(ownerId, operation);
      await AsyncStorage.removeItem(legacyAsyncPendingStorageKey(ownerId, operation));
    });
  }
};