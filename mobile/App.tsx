import React, { useCallback, useEffect } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import AppNavigator from './src/navigation/AppNavigator';
import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import {
  reconcileScheduledBillNotifications,
  requestNotificationPermissions,
} from './src/services/NotificationService';
import { AuthProvider, useAuth } from './src/services/AuthContext';
import LoginScreen from './src/screens/LoginScreen';
import api from './src/services/api';

function AppContent() {
  const { session, loading } = useAuth();

  const reconcileAuthoritativeBillReminders = useCallback(async () => {
    if (!session || Platform.OS === 'web') return;
    try {
      const response = await api.get('/bills/pending');
      const bills = Array.isArray(response.data?.data) ? response.data.data : [];
      const payableIds = bills
        .filter((bill: any) => bill && typeof bill.id === 'string')
        .map((bill: any) => bill.id as string);
      await reconcileScheduledBillNotifications(payableIds);
    } catch {
      // Only an authoritative online snapshot may delete reminders. Offline/auth/
      // provider failures intentionally leave the device scheduler unchanged.
    }
  }, [session?.user.id]);

  useEffect(() => {
    if (Platform.OS === 'android') {
      NavigationBar.setHidden(true);
    }
  }, []);

  useEffect(() => {
    if (!session) return;

    void requestNotificationPermissions();
    void reconcileAuthoritativeBillReminders();

    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void reconcileAuthoritativeBillReminders();
      }
    });

    return () => appStateSubscription.remove();
  }, [session, reconcileAuthoritativeBillReminders]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color="#4f46e5" />
      </View>
    );
  }

  if (!session) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginScreen />
      </>
    );
  }

  return (
    <NavigationContainer>
      <StatusBar style="auto" />
      <AppNavigator />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f8fafc',
  },
});
