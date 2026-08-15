import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  clearLegacyGlobalFinancialCache,
  clearUserFinancialCache,
  migrateLegacyFinancialCacheToUser,
} from './userCache';

const SESSION_STORAGE_KEY = 'financeflow.auth-session.v2';
const LEGACY_SESSION_STORAGE_KEY = '@financeflow:auth-session:v1';
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

export interface AuthSessionSnapshot {
  accessToken: string;
  userId: string;
  generation: number;
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
let sessionGeneration = 0;
let refreshInFlight: { refreshToken: string; promise: Promise<AuthSession> } | null = null;
let sessionPersistenceQueue: Promise<void> = Promise.resolve();
let localSessionCleanup: (() => Promise<void>) | null = null;

/**
 * Configure device-local artifacts that must not survive an authenticated
 * session boundary (for example OS-scheduled bill reminders).
 *
 * Cleanup is invoked while the session persistence lock is held, before a new
 * session can be persisted. Failures are intentionally swallowed so logout
 * cannot be blocked by a device API failure.
 */
export function configureAuthLocalSessionCleanup(cleanup: (() => Promise<void>) | null): void {
  localSessionCleanup = cleanup;
}

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

function setCurrentSession(session: AuthSession | null): void {
  currentSession = session;
  sessionGeneration += 1;
}

function snapshotFromCurrentSession(): AuthSessionSnapshot | null {
  if (!currentSession) return null;
  return {
    accessToken: currentSession.accessToken,
    userId: currentSession.user.id,
    generation: sessionGeneration,
  };
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

async function clearLegacySessionStorage(): Promise<void> {
  await AsyncStorage.removeItem(LEGACY_SESSION_STORAGE_KEY);
}

async function withSessionPersistenceLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = sessionPersistenceQueue;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  sessionPersistenceQueue = previous.catch(() => undefined).then(() => gate);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
}

async function cleanupLocalSessionArtifactsUnlocked(): Promise<void> {
  const cleanup = localSessionCleanup;
  if (!cleanup) return;
  try {
    await cleanup();
  } catch {
    // Authentication teardown must complete even if a device-local API fails.
  }
}

async function persistSessionUnlocked(session: AuthSession | null): Promise<void> {
  setCurrentSession(session);
  if (session) {
    await SecureStore.setItemAsync(SESSION_STORAGE_KEY, JSON.stringify(session));
    await clearLegacySessionStorage();
  } else {
    await SecureStore.deleteItemAsync(SESSION_STORAGE_KEY);
    await clearLegacySessionStorage();
    await cleanupLocalSessionArtifactsUnlocked();
  }
}

async function persistSession(session: AuthSession | null): Promise<void> {
  await withSessionPersistenceLock(() => persistSessionUnlocked(session));
}

async function readPersistedSession(): Promise<{ raw: string; legacy: boolean } | null> {
  const secured = await SecureStore.getItemAsync(SESSION_STORAGE_KEY);
  if (secured !== null) {
    return { raw: secured, legacy: false };
  }

  const legacy = await AsyncStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
  return legacy === null ? null : { raw: legacy, legacy: true };
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
  return withSessionPersistenceLock(async () => {
    if (sameSessionIdentity(currentSession, sourceSession)) {
      await persistSessionUnlocked(refreshedSession);
      return true;
    }
    return sameSessionIdentity(currentSession, refreshedSession);
  });
}

export async function initializeAuthSession(): Promise<AuthSession | null> {
  const stored = await readPersistedSession();
  if (!stored) {
    await persistSession(null);
    await clearLegacyGlobalFinancialCache();
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored.raw);
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

  if (stored.legacy) {
    await persistSession(parsed);
  } else {
    setCurrentSession(parsed);
    await clearLegacySessionStorage();
  }

  await migrateLegacyFinancialCacheToUser(parsed.user.id);
  await clearLegacyGlobalFinancialCache();

  if (parsed.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return parsed;
  }

  try {
    const refreshed = await refreshSessionSingleFlight(parsed.refreshToken);
    if (await commitRefreshedSession(parsed, refreshed)) {
      return refreshed;
    }
    return currentSession;
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      if (sameSessionIdentity(currentSession, parsed)) {
        await clearLocalFinancialState(parsed.user.id);
        if (sameSessionIdentity(currentSession, parsed)) {
          await persistSession(null);
        }
      }
      return currentSession;
    }
    if (sameSessionIdentity(currentSession, parsed)) {
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
  return session;
}

export async function getValidAuthSessionSnapshot(): Promise<AuthSessionSnapshot | null> {
  const sourceSession = currentSession;
  const sourceGeneration = sessionGeneration;
  if (!sourceSession) return null;

  if (sourceSession.expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    try {
      const refreshed = await refreshSessionSingleFlight(sourceSession.refreshToken);
      if (await commitRefreshedSession(sourceSession, refreshed)) {
        return snapshotFromCurrentSession();
      }
      return null;
    } catch (error) {
      if (
        error instanceof InvalidCredentialsError &&
        sameSessionIdentity(currentSession, sourceSession)
      ) {
        await clearLocalFinancialState(sourceSession.user.id);
        if (sameSessionIdentity(currentSession, sourceSession)) {
          await persistSession(null);
        }
      }
      return null;
    }
  }

  if (
    sessionGeneration !== sourceGeneration
    || currentSession !== sourceSession
  ) {
    return null;
  }

  return {
    accessToken: sourceSession.accessToken,
    userId: sourceSession.user.id,
    generation: sourceGeneration,
  };
}

export function isAuthSessionSnapshotCurrent(snapshot: AuthSessionSnapshot): boolean {
  return Boolean(
    currentSession
    && sessionGeneration === snapshot.generation
    && currentSession.user.id === snapshot.userId
    && currentSession.accessToken === snapshot.accessToken
  );
}

/**
 * Fail closed when the protected FinanceFlow API authoritatively rejects the
 * exact bearer snapshot used by a request. The session persistence lock makes
 * the snapshot check, owner-cache purge, device-local cleanup and local-session
 * removal atomic with respect to sign-in/token persistence, so a stale 401
 * cannot clear a newer account/session or its newly scheduled reminders.
 */
export async function invalidateRejectedAuthSessionSnapshot(
  snapshot: AuthSessionSnapshot,
): Promise<boolean> {
  return withSessionPersistenceLock(async () => {
    if (!isAuthSessionSnapshotCurrent(snapshot)) return false;
    await clearLocalFinancialState(snapshot.userId);
    if (!isAuthSessionSnapshotCurrent(snapshot)) return false;
    await persistSessionUnlocked(null);
    return true;
  });
}

export async function getValidAccessToken(): Promise<string | null> {
  return (await getValidAuthSessionSnapshot())?.accessToken ?? null;
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
    if (sameSessionIdentity(currentSession, session)) {
      await clearLocalFinancialState(session.user.id);
      if (sameSessionIdentity(currentSession, session)) {
        await persistSession(null);
      }
    }
  } else {
    await clearLegacyGlobalFinancialCache();
    await persistSession(null);
  }
}
