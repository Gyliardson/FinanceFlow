import React, { useEffect } from 'react';
import { Platform } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import AppNavigator from './src/navigation/AppNavigator';
import * as NavigationBar from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';

export default function App() {
  useEffect(() => {
    if (Platform.OS === 'android') {
      // Configura o modo imersivo "sticky": as barras somem e aparecem ao deslizar
      NavigationBar.setBehaviorAsync('sticky-immersive');
      NavigationBar.setVisibilityAsync('hidden');
    }
  }, []);

  return (
    <NavigationContainer>
      <StatusBar style="auto" />
      <AppNavigator />
    </NavigationContainer>
  );
}
