import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
  clearLegacyGlobalFinancialCache,
  clearUserFinancialCache,
  migrateLegacyFinancialCacheToUser,
} from './userCache';

const LEGACY_SECURE_SESSION_STORAGE_KEY = 'financeflow.auth-session.v2';
const SESSION_MANIFEST_KEY = 'financeflow.auth-session.v3.manifest';
const SESSION_CHUNK_PREFIX = 'financeflow.auth-session.v3';
const SESSION_PROTOCOL_VERSION = 3;
const SESSION_CHUNK_SIZE = 1800;
const MAX_SESSION_CHUNKS = 64;
const LEGACY_SESSION_STORAGE_KEY = '@financeflow:auth-session:v1';
const REFRESH_SKEW_MS = 60_000;
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

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

interface SecureSessionManifest {
  version: typeof SESSION_PROTOCOL_VERSION;
  generation: string;
  chunks: number;
  totalLength: number;
}

type PersistedSessionRead =
  | { state: 'missing' }
  | { state: 'corrupt' }
  | { state: 'ok'; raw: string; legacy: boolean };

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

function sessionChunkKey(generation: string, index: number): string {
  return `${SESSION_CHUNK_PREFIX}.${generation}.${index}`;
}

function newSessionGeneration(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function parseSessionManifest(raw: string): SecureSessionManifest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SecureSessionManifest>;
    if (
      parsed.version !== SESSION_PROTOCOL_VERSION
      || typeof parsed.generation !== 'string'
      || !/^[A-Za-z0-9._-]+$/.test(parsed.generation)
      || typeof parsed.chunks !== 'number'
      || !Number.isInteger(parsed.chunks)
      || parsed.chunks < 1
      || parsed.chunks > MAX_SESSION_CHUNKS
      || typeof parsed.totalLength !== 'number'
      || !Number.isInteger(parsed.totalLength)
      || parsed.totalLength < 1
      || parsed.totalLength > SESSION_CHUNK_SIZE * MAX_SESSION_CHUNKS
    ) {
      return null;
    }
    return {
      version: SESSION_PROTOCOL_VERSION,
      generation: parsed.generation,
      chunks: parsed.chunks,
      totalLength: parsed.totalLength,
    };
  } catch {
    return null;
  }
}

async function cleanupSessionGeneration(manifest: SecureSessionManifest | null): Promise<void> {
  if (!manifest) return;
  for (let index = 0; index < manifest.chunks; index += 1) {
    await SecureStore.deleteItemAsync(
      sessionChunkKey(manifest.generation, index),
    ).catch(() => undefined);
  }
}

async function readChunkedSessionRawUnlocked(): Promise<PersistedSessionRead> {
  let manifestRaw: string | null;
  try {
    manifestRaw = await SecureStore.getItemAsync(SESSION_MANIFEST_KEY);
  } catch {
    return { state: 'corrupt' };
  }
  if (manifestRaw === null) return { state: 'missing' };

  const manifest = parseSessionManifest(manifestRaw);
  if (!manifest) {
    await SecureStore.deleteItemAsync(SESSION_MANIFEST_KEY).catch(() => undefined);
    return { state: 'corrupt' };
  }

  const chunks: string[] = [];
  try {
    for (let index = 0; index < manifest.chunks; index += 1) {
      const chunk = await SecureStore.getItemAsync(sessionChunkKey(manifest.generation, index));
      if (chunk === null) {
        await cleanupSessionGeneration(manifest);
        await SecureStore.deleteItemAsync(SESSION_MANIFEST_KEY).catch(() => undefined);
        return { state: 'corrupt' };
      }
      chunks.push(chunk);
    }
  } catch {
    return { state: 'corrupt' };
  }

  const raw = chunks.join('');
  if (raw.length !== manifest.totalLength) {
    await cleanupSessionGeneration(manifest);
    await SecureStore.deleteItemAsync(SESSION_MANIFEST_KEY).catch(() => undefined);
    return { state: 'corrupt' };
  }
  return { state: 'ok', raw, legacy: false };
}

async function writeChunkedSessionRawUnlocked(raw: string): Promise<void> {
  if (!raw) throw new Error('Authentication session payload cannot be empty');
  if (raw.length > SESSION_CHUNK_SIZE * MAX_SESSION_CHUNKS) {
    throw new Error('Authentication session payload exceeds the supported secure storage budget');
  }

  const oldManifestRaw = await SecureStore.getItemAsync(SESSION_MANIFEST_KEY).catch(() => null);
  const oldManifest = oldManifestRaw ? parseSessionManifest(oldManifestRaw) : null;
  const generation = newSessionGeneration();
  const chunks = raw.match(new RegExp(`.{1,${SESSION_CHUNK_SIZE}}`, 'gs')) ?? [];
  if (!chunks.length || chunks.length > MAX_SESSION_CHUNKS) {
    throw new Error('Authentication session payload cannot be represented securely');
  }

  const manifest: SecureSessionManifest = {
    version: SESSION_PROTOCOL_VERSION,
    generation,
    chunks: chunks.length,
    totalLength: raw.length,
  };

  let written = 0;
  try {
    for (let index = 0; index < chunks.length; index += 1) {
      await SecureStore.setItemAsync(sessionChunkKey(generation, index), chunks[index]);
      written += 1;
    }
    // The manifest is the commit point: readers cannot observe the new generation before this write.
    await SecureStore.setItemAsync(SESSION_MANIFEST_KEY, JSON.stringify(manifest));
  } catch (error) {
    for (let index = 0; index < written; index += 1) {
      await SecureStore.deleteItemAsync(sessionChunkKey(generation, index)).catch(() => undefined);
    }
    throw error;
  }

  if (oldManifest && oldManifest.generation !== generation) {
    await cleanupSessionGeneration(oldManifest);
  }
}

async function clearPersistedSessionUnlocked(): Promise<void> {
  const manifestRaw = await SecureStore.getItemAsync(SESSION_MANIFEST_KEY).catch(() => null);
  const manifest = manifestRaw ? parseSessionManifest(manifestRaw) : null;

  // Legacy stores are removed before the v3 commit marker so logout cannot fall back to old plaintext/v2 state.
  await SecureStore.deleteItemAsync(LEGACY_SECURE_SESSION_STORAGE_KEY);
  await clearLegacySessionStorage();
  await SecureStore.deleteItemAsync(SESSION_MANIFEST_KEY);
  await cleanupSessionGeneration(manifest);
}

async function persistSessionUnlocked(session: AuthSession | null): Promise<void> {
  if (session) {
    await writeChunkedSessionRawUnlocked(JSON.stringify(session));
    await SecureStore.deleteItemAsync(LEGACY_SECURE_SESSION_STORAGE_KEY);
    await clearLegacySessionStorage();
    // Memory is published only after the durable session commit and legacy cleanup succeed.
    setCurrentSession(session);
  } else {
    await clearPersistedSessionUnlocked();
    setCurrentSession(null);
    await cleanupLocalSessionArtifactsUnlocked();
  }
}

async function persistSession(session: AuthSession | null): Promise<void> {
  await withSessionPersistenceLock(() => persistSessionUnlocked(session));
}

async function readPersistedSession(): Promise<PersistedSessionRead> {
  const chunked = await readChunkedSessionRawUnlocked();
  if (chunked.state !== 'missing') return chunked;

  const legacySecure = await SecureStore.getItemAsync(LEGACY_SECURE_SESSION_STORAGE_KEY);
  if (legacySecure !== null) {
    return { state: 'ok', raw: legacySecure, legacy: true };
  }

  const legacy = await AsyncStorage.getItem(LEGACY_SESSION_STORAGE_KEY);
  return legacy === null
    ? { state: 'missing' }
    : { state: 'ok', raw: legacy, legacy: true };
}

async function authRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T | null> {
  const { url, publishableKey } = getSupabaseConfig();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${url}/auth/v1${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        apikey: publishableKey,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        throw new InvalidCredentialsError('Invalid or expired authentication credentials');
      }
      throw new AuthServiceUnavailableError('Authentication service is unavailable');
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  } catch (error) {
    if (error instanceof InvalidCredentialsError || error instanceof AuthServiceUnavailableError) {
      throw error;
    }
    throw new AuthServiceUnavailableError('Authentication service is unavailable');
  } finally {
    clearTimeout(timeoutId);
  }
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
  if (stored.state === 'missing') {
    await persistSession(null);
    await clearLegacyGlobalFinancialCache();
    return null;
  }
  if (stored.state === 'corrupt') {
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
    await SecureStore.deleteItemAsync(LEGACY_SECURE_SESSION_STORAGE_KEY).catch(() => undefined);
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
      // Local logout must still complete if the remote session is invalid/offline/timed out.
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
