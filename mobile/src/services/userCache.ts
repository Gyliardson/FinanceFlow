import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@financeflow:user:';
const LEGACY_BILLS_KEY = '@bills_cache';
const LEGACY_SETTINGS_KEY = '@settings_cache';

type FinancialResource = 'bills' | 'settings';

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('Authenticated user id is required for financial cache access');
  }
  return normalized;
}

export function userCacheKey(userId: string, resource: FinancialResource): string {
  return `${CACHE_PREFIX}${normalizeUserId(userId)}:${resource}`;
}

export async function getUserCache<T>(
  userId: string,
  resource: FinancialResource,
): Promise<T | null> {
  const value = await AsyncStorage.getItem(userCacheKey(userId, resource));
  return value ? (JSON.parse(value) as T) : null;
}

export async function setUserCache(
  userId: string,
  resource: FinancialResource,
  value: unknown,
): Promise<void> {
  await AsyncStorage.setItem(userCacheKey(userId, resource), JSON.stringify(value));
}

export async function clearUserFinancialCache(userId: string): Promise<void> {
  await AsyncStorage.multiRemove([
    userCacheKey(userId, 'bills'),
    userCacheKey(userId, 'settings'),
  ]);
}

export async function clearLegacyGlobalFinancialCache(): Promise<void> {
  await AsyncStorage.multiRemove([LEGACY_BILLS_KEY, LEGACY_SETTINGS_KEY]);
}

/**
 * Transitional bridge while screens are moved away from the historical global
 * AsyncStorage keys. It may only be called after a structurally valid persisted
 * session identifies the owner. This snapshots the legacy values into the
 * owner namespace before the globals are cleared.
 */
export async function migrateLegacyFinancialCacheToUser(userId: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
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

/**
 * Hydrates the old screen-facing keys only for the currently authenticated
 * owner. App startup remains gated by AuthProvider, so another account cannot
 * render these values. This function can be removed once HomeScreen consumes
 * getUserCache/setUserCache directly.
 */
export async function hydrateLegacyFinancialCacheForUser(userId: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  await clearLegacyGlobalFinancialCache();

  const entries = await AsyncStorage.multiGet([
    userCacheKey(normalizedUserId, 'bills'),
    userCacheKey(normalizedUserId, 'settings'),
  ]);
  const writes: [string, string][] = [];

  for (const [key, value] of entries) {
    if (!value) continue;
    if (key.endsWith(':bills')) {
      writes.push([LEGACY_BILLS_KEY, value]);
    } else if (key.endsWith(':settings')) {
      writes.push([LEGACY_SETTINGS_KEY, value]);
    }
  }

  if (writes.length) {
    await AsyncStorage.multiSet(writes);
  }
}
