import AsyncStorage from '@react-native-async-storage/async-storage';

const CACHE_PREFIX = '@financeflow:user:';

function normalizeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) {
    throw new Error('Authenticated user id is required for financial cache access');
  }
  return normalized;
}

export function userCacheKey(userId: string, resource: 'bills' | 'settings'): string {
  return `${CACHE_PREFIX}${normalizeUserId(userId)}:${resource}`;
}

export async function getUserCache<T>(
  userId: string,
  resource: 'bills' | 'settings',
): Promise<T | null> {
  const value = await AsyncStorage.getItem(userCacheKey(userId, resource));
  return value ? (JSON.parse(value) as T) : null;
}

export async function setUserCache(
  userId: string,
  resource: 'bills' | 'settings',
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
  await AsyncStorage.multiRemove(['@bills_cache', '@settings_cache']);
}
