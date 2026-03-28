import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import HomeScreen from '../screens/HomeScreen';
import DetailScreen from '../screens/DetailScreen';
import RecurringBillScreen from '../screens/RecurringBillScreen';
import PaymentScreen from '../screens/PaymentScreen';
import BillHistoryScreen from '../screens/BillHistoryScreen';

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{
      headerStyle: { backgroundColor: '#4f46e5' },
      headerTintColor: '#fff',
      headerTitleStyle: { fontWeight: 'bold' }
    }}>
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Minhas Faturas' }} />
      <Stack.Screen name="Details" component={DetailScreen} options={{ title: 'Nova Fatura' }} />
      <Stack.Screen 
        name="RecurringBill" 
        component={RecurringBillScreen} 
        options={{ 
          title: 'Conta Recorrente',
          headerStyle: { backgroundColor: '#8b5cf6' },
        }} 
      />
      <Stack.Screen 
        name="Payment" 
        component={PaymentScreen} 
        options={{ 
          title: 'Registrar Pagamento',
          headerStyle: { backgroundColor: '#10b981' },
        }} 
      />
      <Stack.Screen 
        name="BillHistory" 
        component={BillHistoryScreen} 
        options={{ 
          title: 'Detalhes da Conta',
          headerStyle: { backgroundColor: '#4f46e5' },
        }} 
      />
    </Stack.Navigator>
  );
}

