import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import {
  configureApiAuthSessionSnapshotProvider,
  reconcilePendingFinancialMutations,
} from './api';
import {
  AuthSession,
  configureAuthLocalSessionCleanup,
  getCurrentAuthSession,
  getValidAuthSessionSnapshot,
  initializeAuthSession,
  invalidateRejectedAuthSessionSnapshot,
  isAuthSessionSnapshotCurrent,
  signInWithPassword,
  signOutAuthSession,
} from './authSession';
import { cancelAllNotifications } from './NotificationService';

type AuthContextValue = {
  session: AuthSession | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const cleanupSessionNotifications = async () => {
  await cancelAllNotifications();
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    configureAuthLocalSessionCleanup(cleanupSessionNotifications);
    configureApiAuthSessionSnapshotProvider(
      async () => {
        const snapshot = await getValidAuthSessionSnapshot();
        if (active) setSession(getCurrentAuthSession());
        return snapshot;
      },
      isAuthSessionSnapshotCurrent,
      async (snapshot) => {
        const invalidated = await invalidateRejectedAuthSessionSnapshot(snapshot);
        if (invalidated && active) {
          setSession(getCurrentAuthSession());
        }
      },
    );

    initializeAuthSession()
      .then((next) => {
        if (!active) return;
        setSession(next);
        if (next) void reconcilePendingFinancialMutations();
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void reconcilePendingFinancialMutations();
      }
    });

    return () => {
      active = false;
      appStateSubscription.remove();
      configureApiAuthSessionSnapshotProvider(null, null, null);
      configureAuthLocalSessionCleanup(null);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await signInWithPassword(email, password);
    setSession(next);
    void reconcilePendingFinancialMutations();
  }, []);

  const signOut = useCallback(async () => {
    await signOutAuthSession();
    setSession(null);
  }, []);

  const value = useMemo(
    () => ({ session, loading, signIn, signOut }),
    [session, loading, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return value;
}
