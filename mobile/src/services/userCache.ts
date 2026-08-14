import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@financeflow:user:';
const LEGACY_BILLS_KEY = '@bills_cache';
const LEGACY_SETTINGS_KEY = '@settings_cache';
const LEGACY_OWNER_KEY = '@financeflow:legacy-cache-owner:v1';

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
  await AsyncStorage.multiRemove([
    LEGACY_BILLS_KEY,
    LEGACY_SETTINGS_KEY,
    LEGACY_OWNER_KEY,
  ]);
}

/**
 * Transitional bridge while screens are moved away from the historical global
 * AsyncStorage keys. Global financial values are only trusted when the bridge
 * marker proves they were produced while the same authenticated owner was
 * active. Untagged legacy values and owner mismatches fail closed and are
 * deleted rather than attributed to the current account.
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

/**
 * Hydrates the old screen-facing keys only for the currently authenticated
 * owner and tags those globals with the same owner. App startup remains gated
 * by AuthProvider, so another account cannot render these values. The marker
 * makes the bridge fail closed if storage state and authenticated identity ever
 * diverge. This compatibility layer can be removed once HomeScreen consumes
 * getUserCache/setUserCache directly.
 */
export async function hydrateLegacyFinancialCacheForUser(userId: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  await clearLegacyGlobalFinancialCache();

  const entries = await AsyncStorage.multiGet([
    userCacheKey(normalizedUserId, 'bills'),
    userCacheKey(normalizedUserId, 'settings'),
  ]);
  const writes: [string, string][] = [[LEGACY_OWNER_KEY, normalizedUserId]];

  for (const [key, value] of entries) {
    if (!value) continue;
    if (key.endsWith(':bills')) {
      writes.push([LEGACY_BILLS_KEY, value]);
    } else if (key.endsWith(':settings')) {
      writes.push([LEGACY_SETTINGS_KEY, value]);
    }
  }

  await AsyncStorage.multiSet(writes);
}
