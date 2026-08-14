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
 * One-time compatibility import for users upgrading from the historical global
 * financial cache. Values are accepted only when the legacy owner marker
 * matches the authenticated user; untagged/mismatched data fails closed. The
 * global keys are always deleted after the migration attempt and are never
 * re-created by current application code.
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
