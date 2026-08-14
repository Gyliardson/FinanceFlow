import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const LEGACY_CACHE_PREFIX = '@financeflow:user:';
const SECURE_CACHE_PREFIX = 'financeflow.cache.v2';
const CACHE_VERSION = 1;
const SECURE_CHUNK_SIZE = 1800;
const LEGACY_BILLS_KEY = '@bills_cache';
const LEGACY_SETTINGS_KEY = '@settings_cache';
const LEGACY_OWNER_KEY = '@financeflow:legacy-cache-owner:v1';

type FinancialResource = 'bills' | 'settings';

export interface UserCacheSnapshot<T> {
  data: T;
  cachedAt: number | null;
  version: number;
}

interface CacheEnvelope<T> {
  version: typeof CACHE_VERSION;
  cachedAt: number;
  data: T;
}

interface SecureCacheManifest {
  version: 1;
  generation: string;
  chunks: number;
  totalLength: number;
}

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('Authenticated user id is required for financial cache access');
  }
  return normalized;
}

function secureOwnerToken(userId: string): string {
  const normalized = normalizeUserId(userId);
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error('Authenticated user id cannot be represented as a SecureStore key');
  }
  return normalized;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isVersionedEnvelope(value: unknown): value is CacheEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CacheEnvelope<unknown>>;
  return Boolean(
    candidate.version === CACHE_VERSION
      && typeof candidate.cachedAt === 'number'
      && Number.isFinite(candidate.cachedAt)
      && candidate.cachedAt > 0
      && hasOwn(candidate, 'data')
  );
}

function looksLikeMalformedEnvelope(value: unknown): boolean {
  return Boolean(
    value
      && typeof value === 'object'
      && (hasOwn(value, 'version') || hasOwn(value, 'cachedAt'))
      && !isVersionedEnvelope(value)
  );
}

function isValidResourcePayload(resource: FinancialResource, value: unknown): boolean {
  if (resource === 'bills') return Array.isArray(value);
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseCacheSnapshot<T>(
  resource: FinancialResource,
  raw: string,
): UserCacheSnapshot<T> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (isVersionedEnvelope(parsed)) {
    if (!isValidResourcePayload(resource, parsed.data)) return null;
    return {
      data: parsed.data as T,
      cachedAt: parsed.cachedAt,
      version: parsed.version,
    };
  }

  if (looksLikeMalformedEnvelope(parsed) || !isValidResourcePayload(resource, parsed)) {
    return null;
  }

  return {
    data: parsed as T,
    cachedAt: null,
    version: 0,
  };
}

/** Legacy plaintext owner-scoped key used only for one-way migration/cleanup. */
export function userCacheKey(userId: string, resource: FinancialResource): string {
  return `${LEGACY_CACHE_PREFIX}${normalizeUserId(userId)}:${resource}`;
}

export function secureUserCacheManifestKey(userId: string, resource: FinancialResource): string {
  return `${SECURE_CACHE_PREFIX}.${secureOwnerToken(userId)}.${resource}.manifest`;
}

function secureChunkKey(
  userId: string,
  resource: FinancialResource,
  generation: string,
  index: number,
): string {
  return `${SECURE_CACHE_PREFIX}.${secureOwnerToken(userId)}.${resource}.${generation}.${index}`;
}

function newGeneration(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function parseManifest(raw: string): SecureCacheManifest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SecureCacheManifest>;
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
    ) {
      return null;
    }
    return {
      version: 1,
      generation: parsed.generation,
      chunks: parsed.chunks,
      totalLength: parsed.totalLength,
    };
  } catch {
    return null;
  }
}

async function cleanupGeneration(
  userId: string,
  resource: FinancialResource,
  manifest: SecureCacheManifest | null,
): Promise<void> {
  if (!manifest) return;
  for (let index = 0; index < manifest.chunks; index += 1) {
    try {
      await SecureStore.deleteItemAsync(
        secureChunkKey(userId, resource, manifest.generation, index),
      );
    } catch {
      // Cache cleanup is best effort; inaccessible chunks are never trusted.
    }
  }
}

async function readSecureCacheRaw(
  userId: string,
  resource: FinancialResource,
): Promise<{ state: 'missing' | 'corrupt' | 'ok'; raw?: string }> {
  const manifestKey = secureUserCacheManifestKey(userId, resource);
  const manifestRaw = await SecureStore.getItemAsync(manifestKey);
  if (manifestRaw === null) return { state: 'missing' };

  const manifest = parseManifest(manifestRaw);
  if (!manifest) {
    await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
    return { state: 'corrupt' };
  }

  const chunks: string[] = [];
  try {
    for (let index = 0; index < manifest.chunks; index += 1) {
      const value = await SecureStore.getItemAsync(
        secureChunkKey(userId, resource, manifest.generation, index),
      );
      if (value === null) {
        await cleanupGeneration(userId, resource, manifest);
        await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
        return { state: 'corrupt' };
      }
      chunks.push(value);
    }
  } catch {
    return { state: 'corrupt' };
  }

  const raw = chunks.join('');
  if (raw.length !== manifest.totalLength) {
    await cleanupGeneration(userId, resource, manifest);
    await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
    return { state: 'corrupt' };
  }
  return { state: 'ok', raw };
}

async function writeSecureCacheRaw(
  userId: string,
  resource: FinancialResource,
  raw: string,
): Promise<void> {
  const manifestKey = secureUserCacheManifestKey(userId, resource);
  const oldManifestRaw = await SecureStore.getItemAsync(manifestKey).catch(() => null);
  const oldManifest = oldManifestRaw ? parseManifest(oldManifestRaw) : null;
  const generation = newGeneration();
  const chunks = raw.match(new RegExp(`.{1,${SECURE_CHUNK_SIZE}}`, 'gs')) ?? [];
  if (!chunks.length) throw new Error('Financial cache payload cannot be empty');

  const newManifest: SecureCacheManifest = {
    version: 1,
    generation,
    chunks: chunks.length,
    totalLength: raw.length,
  };

  let written = 0;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await SecureStore.setItemAsync(
        secureChunkKey(userId, resource, generation, index),
        chunks[index],
      );
      written += 1;
    }
    await SecureStore.setItemAsync(manifestKey, JSON.stringify(newManifest));
  } catch (error) {
    for (let index = 0; index < written; index += 1) {
      await SecureStore.deleteItemAsync(
        secureChunkKey(userId, resource, generation, index),
      ).catch(() => undefined);
    }
    throw error;
  }

  if (oldManifest && oldManifest.generation !== generation) {
    await cleanupGeneration(userId, resource, oldManifest);
  }
}

async function discardLegacyOwnerCache(userId: string, resource: FinancialResource): Promise<void> {
  try {
    await AsyncStorage.removeItem(userCacheKey(userId, resource));
  } catch {
    // Legacy plaintext cleanup is best effort; it is never used as authoritative state.
  }
}

async function migrateLegacyOwnerCache<T>(
  userId: string,
  resource: FinancialResource,
): Promise<UserCacheSnapshot<T> | null> {
  const legacyKey = userCacheKey(userId, resource);
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(legacyKey);
  } catch {
    return null;
  }
  if (!raw) return null;

  const snapshot = parseCacheSnapshot<T>(resource, raw);
  if (!snapshot) {
    await discardLegacyOwnerCache(userId, resource);
    return null;
  }

  try {
    await writeSecureCacheRaw(userId, resource, raw);
  } finally {
    // Plaintext financial cache must not remain durable after the secure-cache upgrade.
    await discardLegacyOwnerCache(userId, resource);
  }
  return snapshot;
}

export async function getUserCacheSnapshot<T>(
  userId: string,
  resource: FinancialResource,
): Promise<UserCacheSnapshot<T> | null> {
  let secureResult: { state: 'missing' | 'corrupt' | 'ok'; raw?: string };
  try {
    secureResult = await readSecureCacheRaw(userId, resource);
  } catch {
    return null;
  }

  if (secureResult.state === 'ok' && secureResult.raw) {
    const snapshot = parseCacheSnapshot<T>(resource, secureResult.raw);
    if (snapshot) return snapshot;
    await clearSecureUserCache(userId, resource);
    return null;
  }
  if (secureResult.state === 'corrupt') return null;

  try {
    return await migrateLegacyOwnerCache<T>(userId, resource);
  } catch {
    // Migration failed to secure the value; the plaintext copy is still removed.
    return null;
  }
}

export async function getUserCache<T>(
  userId: string,
  resource: FinancialResource,
): Promise<T | null> {
  const snapshot = await getUserCacheSnapshot<T>(userId, resource);
  return snapshot?.data ?? null;
}

export async function setUserCache(
  userId: string,
  resource: FinancialResource,
  value: unknown,
): Promise<void> {
  if (!isValidResourcePayload(resource, value)) {
    throw new Error(`Invalid ${resource} cache payload`);
  }
  const envelope: CacheEnvelope<unknown> = {
    version: CACHE_VERSION,
    cachedAt: Date.now(),
    data: value,
  };
  await writeSecureCacheRaw(userId, resource, JSON.stringify(envelope));
  await discardLegacyOwnerCache(userId, resource);
}

export async function trySetUserCache(
  userId: string,
  resource: FinancialResource,
  value: unknown,
): Promise<boolean> {
  try {
    await setUserCache(userId, resource, value);
    return true;
  } catch {
    return false;
  }
}

async function clearSecureUserCache(userId: string, resource: FinancialResource): Promise<void> {
  const manifestKey = secureUserCacheManifestKey(userId, resource);
  let manifest: SecureCacheManifest | null = null;
  try {
    const raw = await SecureStore.getItemAsync(manifestKey);
    manifest = raw ? parseManifest(raw) : null;
  } catch {
    // Continue with manifest deletion; unreadable cache is not usable.
  }
  await cleanupGeneration(userId, resource, manifest);
  await SecureStore.deleteItemAsync(manifestKey).catch(() => undefined);
}

export async function clearUserFinancialCache(userId: string): Promise<void> {
  await clearSecureUserCache(userId, 'bills');
  await clearSecureUserCache(userId, 'settings');
  await AsyncStorage.multiRemove([
    userCacheKey(userId, 'bills'),
    userCacheKey(userId, 'settings'),
  ]);
}

export async function clearLegacyGlobalFinancialCache(): Promise<void> {
  await AsyncStorage.multiRemove([
    LEGACY_BILLS_KEY,
    LEGACY_SETTINGS_KEY,
    LEGACY_OWNER_KEY,
  ]);
}

/**
 * One-time compatibility import for the historical global plaintext cache.
 * Values are accepted only when the legacy owner marker matches the authenticated
 * user, moved into encrypted chunked storage, and then removed from AsyncStorage.
 */
export async function migrateLegacyFinancialCacheToUser(userId: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  const legacyOwner = await AsyncStorage.getItem(LEGACY_OWNER_KEY);

  if (legacyOwner !== normalizedUserId) {
    await clearLegacyGlobalFinancialCache();
    return;
  }

  const entries = await AsyncStorage.multiGet([LEGACY_BILLS_KEY, LEGACY_SETTINGS_KEY]);
  try {
    for (const [key, value] of entries) {
      if (!value) continue;
      const resource: FinancialResource | null = key === LEGACY_BILLS_KEY
        ? 'bills'
        : key === LEGACY_SETTINGS_KEY
          ? 'settings'
          : null;
      if (!resource) continue;
      if (!parseCacheSnapshot(resource, value)) continue;
      await writeSecureCacheRaw(normalizedUserId, resource, value);
    }
  } finally {
    await clearLegacyGlobalFinancialCache();
  }
}
