import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearLegacyGlobalFinancialCache,
  clearUserFinancialCache,
  hydrateLegacyFinancialCacheForUser,
  migrateLegacyFinancialCacheToUser,
} from './userCache';

const SESSION_STORAGE_KEY = '@financeflow:auth-session:v1';
const REFRESH_SKEW_MS = 60_000;

export interface AuthUser {
  id: string;
  email?: string;
}

export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

interface SupabaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: {
    id: string;
    email?: string;
  };
}

class InvalidCredentialsError extends Error {}
class AuthServiceUnavailableError extends Error {}

let currentSession: AuthSession | null = null;
let refreshInFlight: { refreshToken: string; promise: Promise<AuthSession> } | null = null;

function getSupabaseConfig() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim().replace(/\/$/, '');
  const publishableKey = (
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY
  )?.trim();

  if (!url || !publishableKey) {
    throw new Error('Supabase mobile auth is not configured');
  }

  return { url, publishableKey };
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Partial<AuthSession>;
  return Boolean(
    typeof session.accessToken === 'string' && session.accessToken &&
    typeof session.refreshToken === 'string' && session.refreshToken &&
    typeof session.expiresAt === 'number' && Number.isFinite(session.expiresAt) &&
    session.user && typeof session.user.id === 'string' && session.user.id.trim()
  );
}

function sameSessionIdentity(left: AuthSession | null, right: AuthSession): boolean {
  return Boolean(
    left &&
    left.user.id === right.user.id &&
    left.refreshToken === right.refreshToken
  );
}

function normalizeTokenResponse(payload: SupabaseTokenResponse): AuthSession {
  if (
    !payload?.access_token ||
    !payload?.refresh_token ||
    !Number.isFinite(payload?.expires_in) ||
    !payload?.user?.id
  ) {
    throw new Error('Supabase returned an invalid authentication session');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
    user: {
      id: payload.user.id,
      email: payload.user.email,
    },
  };
}

async function persistSession(session: AuthSession | null): Promise<void> {
  currentSession = session;
  if (session) {
    await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } else {
    await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
  }
}

async function authRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T | null> {
  const { url, publishableKey } = getSupabaseConfig();
  let response: Response;

  try {
    response = await fetch(`${url}/auth/v1${path}`, {
      ...init,
      headers: {
        apikey: publishableKey,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });
  } catch {
    throw new AuthServiceUnavailableError('Authentication service is unavailable');
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new InvalidCredentialsError('Invalid or expired authentication credentials');
    }
    throw new AuthServiceUnavailableError('Authentication service is unavailable');
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
}

async function clearLocalFinancialState(userId?: string): Promise<void> {
  if (userId) {
    await clearUserFinancialCache(userId);
  }
  await clearLegacyGlobalFinancialCache();
}

async function requestRefreshedSession(refreshToken: string): Promise<AuthSession> {
  const payload = await authRequest<SupabaseTokenResponse>(
    '/token?grant_type=refresh_token',
    {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  if (!payload) {
    throw new Error('Supabase returned an empty authentication session');
  }
  return normalizeTokenResponse(payload);
}

async function refreshSessionSingleFlight(refreshToken: string): Promise<AuthSession> {
  if (refreshInFlight?.refreshToken === refreshToken) {
    return refreshInFlight.promise;
  }

  const promise = requestRefreshedSession(refreshToken);
  refreshInFlight = { refreshToken, promise };
  try {
    return await promise;
  } finally {
    if (refreshInFlight?.promise === promise) {
      refreshInFlight = null;
    }
  }
}

async function commitRefreshedSession(
  sourceSession: AuthSession,
  refreshedSession: AuthSession,
): Promise<boolean> {
  if (sameSessionIdentity(currentSession, sourceSession)) {
    await persistSession(refreshedSession);
    return true;
  }

  // Another caller may already have committed this same single-flight result.
  return sameSessionIdentity(currentSession, refreshedSession);
}

export async function initializeAuthSession(): Promise<AuthSession | null> {
  const stored = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
  if (!stored) {
    currentSession = null;
    await clearLegacyGlobalFinancialCache();
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await persistSession(null);
    await clearLegacyGlobalFinancialCache();
    return null;
  }

  if (!isAuthSession(parsed)) {
    await persistSession(null);
    await clearLegacyGlobalFinancialCache();
    return null;
  }

  // Capture compatibility-cache values only if their owner marker matches this
  // persisted identity. Untagged or mismatched legacy state is discarded.
  await migrateLegacyFinancialCacheToUser(parsed.user.id);
  currentSession = parsed;

  if (parsed.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    await hydrateLegacyFinancialCacheForUser(parsed.user.id);
    return parsed;
  }

  try {
    const refreshed = await refreshSessionSingleFlight(parsed.refreshToken);
    if (await commitRefreshedSession(parsed, refreshed)) {
      await hydrateLegacyFinancialCacheForUser(refreshed.user.id);
      return refreshed;
    }
    return currentSession;
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      // Only the session that initiated this refresh may be invalidated. A
      // delayed failure from an older session must never clear a newer login.
      if (sameSessionIdentity(currentSession, parsed)) {
        await clearLocalFinancialState(parsed.user.id);
        await persistSession(null);
      }
      return currentSession;
    }
    // A transient Auth outage must not destroy the owner's offline cache. Only
    // hydrate if this persisted identity is still the active session.
    if (sameSessionIdentity(currentSession, parsed)) {
      await hydrateLegacyFinancialCacheForUser(parsed.user.id);
      return parsed;
    }
    return currentSession;
  }
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<AuthSession> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !password) {
    throw new Error('Email and password are required');
  }

  const payload = await authRequest<SupabaseTokenResponse>(
    '/token?grant_type=password',
    {
      method: 'POST',
      body: JSON.stringify({ email: normalizedEmail, password }),
    },
  );
  if (!payload) {
    throw new Error('Supabase returned an empty authentication session');
  }

  const session = normalizeTokenResponse(payload);
  await clearLegacyGlobalFinancialCache();
  await persistSession(session);
  // HomeScreen still writes compatibility keys. Tag that bridge immediately so
  // any values produced during this authenticated run can only be recovered by
  // the same owner on restart.
  await hydrateLegacyFinancialCacheForUser(session.user.id);
  return session;
}

export async function getValidAccessToken(): Promise<string | null> {
  const sourceSession = currentSession;
  if (!sourceSession) return null;

  if (sourceSession.expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    try {
      const refreshed = await refreshSessionSingleFlight(sourceSession.refreshToken);
      if (await commitRefreshedSession(sourceSession, refreshed)) {
        return refreshed.accessToken;
      }
      // The account changed while refresh was in flight. Never return a token
      // from the stale session; use only the session that is active now.
      return currentSession?.accessToken ?? null;
    } catch (error) {
      if (
        error instanceof InvalidCredentialsError &&
        sameSessionIdentity(currentSession, sourceSession)
      ) {
        await clearLocalFinancialState(sourceSession.user.id);
        await persistSession(null);
      }
      return null;
    }
  }

  return sourceSession.accessToken;
}

export function getCurrentAuthSession(): AuthSession | null {
  return currentSession;
}

export async function signOutAuthSession(): Promise<void> {
  const session = currentSession;
  if (session) {
    try {
      await authRequest<never>('/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
    } catch {
      // Local logout must still complete if the remote session is invalid/offline.
    }
    // Clear only if this is still the session being signed out. A newer login
    // must not be erased by a delayed remote logout response.
    if (sameSessionIdentity(currentSession, session)) {
      await clearLocalFinancialState(session.user.id);
      await persistSession(null);
    }
  } else {
    await clearLegacyGlobalFinancialCache();
    await persistSession(null);
  }
}
