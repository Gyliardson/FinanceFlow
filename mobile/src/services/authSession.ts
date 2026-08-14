import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearLegacyGlobalFinancialCache, clearUserFinancialCache } from './userCache';

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

let currentSession: AuthSession | null = null;

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
): Promise<T> {
  const { url, publishableKey } = getSupabaseConfig();
  const response = await fetch(`${url}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: publishableKey,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    if (response.status === 400 || response.status === 401) {
      throw new Error('Invalid or expired authentication credentials');
    }
    throw new Error('Authentication service is unavailable');
  }

  return response.json() as Promise<T>;
}

async function refreshSession(refreshToken: string): Promise<AuthSession> {
  const payload = await authRequest<SupabaseTokenResponse>(
    '/token?grant_type=refresh_token',
    {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  const session = normalizeTokenResponse(payload);
  await persistSession(session);
  return session;
}

export async function initializeAuthSession(): Promise<AuthSession | null> {
  await clearLegacyGlobalFinancialCache();

  const stored = await AsyncStorage.getItem(SESSION_STORAGE_KEY);
  if (!stored) {
    currentSession = null;
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(stored);
    if (!isAuthSession(parsed)) {
      await persistSession(null);
      return null;
    }

    currentSession = parsed;
    if (parsed.expiresAt <= Date.now() + REFRESH_SKEW_MS) {
      return await refreshSession(parsed.refreshToken);
    }

    return parsed;
  } catch {
    await persistSession(null);
    return null;
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

  const session = normalizeTokenResponse(payload);
  await persistSession(session);
  return session;
}

export async function getValidAccessToken(): Promise<string | null> {
  if (!currentSession) return null;

  if (currentSession.expiresAt <= Date.now() + REFRESH_SKEW_MS) {
    try {
      const refreshed = await refreshSession(currentSession.refreshToken);
      return refreshed.accessToken;
    } catch {
      const userId = currentSession.user.id;
      await persistSession(null);
      await clearUserFinancialCache(userId);
      return null;
    }
  }

  return currentSession.accessToken;
}

export function getCurrentAuthSession(): AuthSession | null {
  return currentSession;
}

export async function signOutAuthSession(): Promise<void> {
  const session = currentSession;
  if (session) {
    try {
      await authRequest<void>('/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.accessToken}` },
      });
    } catch {
      // Local logout must still complete if the remote session is already invalid/offline.
    }
    await clearUserFinancialCache(session.user.id);
  }

  await persistSession(null);
}
