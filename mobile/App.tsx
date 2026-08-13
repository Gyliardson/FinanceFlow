import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import AppNavigator from './src/navigation/AppNavigator';
import * as NavigationBar from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { requestNotificationPermissions } from './src/services/NotificationService';

export default function App() {
  useEffect(() => {
    if (Platform.OS === 'android') {
      NavigationBar.setBehaviorAsync('inset-swipe');
      NavigationBar.setVisibilityAsync('hidden');
    }

    // Solicitar permissão de notificações
    requestNotificationPermissions();
  }, []);

  return (
    <NavigationContainer>
      <StatusBar style="auto" />
      <AppNavigator />
    </NavigationContainer>
  );
}
