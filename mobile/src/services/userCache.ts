import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@financeflow:user:';
const CACHE_VERSION = 1;
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

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('Authenticated user id is required for financial cache access');
  }
  return normalized;
}

function isVersionedEnvelope(value: unknown): value is CacheEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CacheEnvelope<unknown>>;
  return Boolean(
    candidate.version === CACHE_VERSION
      && typeof candidate.cachedAt === 'number'
      && Number.isFinite(candidate.cachedAt)
      && candidate.cachedAt > 0
      && Object.prototype.hasOwnProperty.call(candidate, 'data')
  );
}

async function discardUnreadableEntry(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // A local storage cleanup failure must not make corrupt financial data usable.
  }
}

export function userCacheKey(userId: string, resource: FinancialResource): string {
  return `${CACHE_PREFIX}${normalizeUserId(userId)}:${resource}`;
}

export async function getUserCacheSnapshot<T>(
  userId: string,
  resource: FinancialResource,
): Promise<UserCacheSnapshot<T> | null> {
  const key = userCacheKey(userId, resource);
  let raw: string | null;

  try {
    raw = await AsyncStorage.getItem(key);
  } catch {
    return null;
  }

  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await discardUnreadableEntry(key);
    return null;
  }

  if (isVersionedEnvelope(parsed)) {
    return {
      data: parsed.data as T,
      cachedAt: parsed.cachedAt,
      version: parsed.version,
    };
  }

  // Historical owner-scoped cache values were stored as raw JSON. They remain
  // readable for a one-way compatibility period, but have unknown freshness
  // until the next successful server response rewrites them as an envelope.
  if (parsed !== null) {
    return {
      data: parsed as T,
      cachedAt: null,
      version: 0,
    };
  }

  await discardUnreadableEntry(key);
  return null;
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
  const envelope: CacheEnvelope<unknown> = {
    version: CACHE_VERSION,
    cachedAt: Date.now(),
    data: value,
  };
  await AsyncStorage.setItem(userCacheKey(userId, resource), JSON.stringify(envelope));
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

export async function clearUserFinancialCache(userId: string): Promise<void> {
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
 * One-time compatibility import for users upgrading from the historical global
 * financial cache. Values are accepted only when the legacy owner marker
 * matches the authenticated user; untagged/mismatched data fails closed. The
 * imported values intentionally keep unknown freshness until a successful API
 * read rewrites them with the current versioned envelope.
 */
export async function migrateLegacyFinancialCacheToUser(userId: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  const legacyOwner = await AsyncStorage.getItem(LEGACY_OWNER_KEY);

  if (legacyOwner !== normalizedUserId) {
    await clearLegacyGlobalFinancialCache();
    return;
  }

  const entries = await AsyncStorage.multiGet([LEGACY_BILLS_KEY, LEGACY_SETTINGS_KEY]);
  const writes: [string, string][] = [];

  for (const [key, value] of entries) {
    if (!value) continue;
    if (key === LEGACY_BILLS_KEY) {
      writes.push([userCacheKey(normalizedUserId, 'bills'), value]);
    } else if (key === LEGACY_SETTINGS_KEY) {
      writes.push([userCacheKey(normalizedUserId, 'settings'), value]);
    }
  }

  if (writes.length) {
    await AsyncStorage.multiSet(writes);
  }
  await clearLegacyGlobalFinancialCache();
}
