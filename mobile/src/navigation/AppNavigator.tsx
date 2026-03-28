import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import HomeScreen from '../screens/HomeScreen';
import DetailScreen from '../screens/DetailScreen';
import RecurringBillScreen from '../screens/RecurringBillScreen';
import PaymentScreen from '../screens/PaymentScreen';

const Stack = createStackNavigator();

export default function AppNavigator() {
  return (
    <Stack.Navigator initialRouteName="Home" screenOptions={{
      headerStyle: { backgroundColor: '#3498db' },
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
          headerStyle: { backgroundColor: '#8e44ad' },
        }} 
      />
      <Stack.Screen 
        name="Payment" 
        component={PaymentScreen} 
        options={{ 
          title: 'Registrar Pagamento',
          headerStyle: { backgroundColor: '#27ae60' },
        }} 
      />
    </Stack.Navigator>
  );
}
