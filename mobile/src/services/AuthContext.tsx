import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { configureApiAuthSessionSnapshotProvider } from './api';
import {
  AuthSession,
  getCurrentAuthSession,
  getValidAuthSessionSnapshot,
  initializeAuthSession,
  isAuthSessionSnapshotCurrent,
  signInWithPassword,
  signOutAuthSession,
} from './authSession';

type AuthContextValue = {
  session: AuthSession | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    configureApiAuthSessionSnapshotProvider(
      async () => {
        const snapshot = await getValidAuthSessionSnapshot();
        setSession(getCurrentAuthSession());
        return snapshot;
      },
      isAuthSessionSnapshotCurrent,
    );

    initializeAuthSession()
      .then(setSession)
      .finally(() => setLoading(false));

    return () => {
      configureApiAuthSessionSnapshotProvider(null, null);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const next = await signInWithPassword(email, password);
    setSession(next);
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
