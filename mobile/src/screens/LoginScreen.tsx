import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAuth } from '../services/AuthContext';

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Dados incompletos', 'Informe email e senha.');
      return;
    }

    setSubmitting(true);
    try {
      await signIn(email, password);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Não foi possível autenticar agora.';
      Alert.alert('Falha no login', message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.eyebrow}>FinanceFlow</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Acesse seus dados financeiros
        </Text>
        <Text style={styles.subtitle}>
          Sua sessão é validada pelo Supabase e o aplicativo só carrega dados do usuário autenticado.
        </Text>

        <Text nativeID="login-email-label" style={styles.label}>Email</Text>
        <TextInput
          accessibilityLabel="Email"
          accessibilityHint="Informe o email da sua conta FinanceFlow"
          accessibilityLabelledBy="login-email-label"
          autoCapitalize="none"
          autoComplete="email"
          editable={!submitting}
          keyboardType="email-address"
          returnKeyType="next"
          textContentType="emailAddress"
          value={email}
          onChangeText={setEmail}
          placeholder="voce@exemplo.com"
          style={styles.input}
        />

        <Text nativeID="login-password-label" style={styles.label}>Senha</Text>
        <TextInput
          accessibilityLabel="Senha"
          accessibilityHint="Informe a senha da sua conta FinanceFlow"
          accessibilityLabelledBy="login-password-label"
          autoCapitalize="none"
          autoComplete="password"
          editable={!submitting}
          returnKeyType="done"
          secureTextEntry
          textContentType="password"
          value={password}
          onChangeText={setPassword}
          placeholder="Sua senha"
          style={styles.input}
          onSubmitEditing={handleSignIn}
        />

        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={submitting ? 'Entrando na conta' : 'Entrar'}
          accessibilityHint="Autentica sua conta e abre o painel financeiro"
          accessibilityState={{ disabled: submitting, busy: submitting }}
          disabled={submitting}
          onPress={handleSignIn}
          style={[styles.button, submitting && styles.buttonDisabled]}
        >
          {submitting ? (
            <ActivityIndicator accessibilityLabel="Autenticando" color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Entrar</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#f8fafc',
  },
  card: {
    gap: 12,
    borderRadius: 20,
    padding: 24,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  eyebrow: {
    color: '#4f46e5',
    fontWeight: '800',
    fontSize: 14,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  title: {
    color: '#0f172a',
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
  },
  subtitle: {
    color: '#475569',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 8,
  },
  label: {
    color: '#334155',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 12,
    paddingHorizontal: 14,
    color: '#0f172a',
    backgroundColor: '#fff',
  },
  button: {
    minHeight: 50,
    marginTop: 8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#4f46e5',
  },
  buttonDisabled: {
    opacity: 0.65,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
});
