const REQUIRED_PUBLIC_RUNTIME_VARS = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];

const missing = REQUIRED_PUBLIC_RUNTIME_VARS.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.trim().length === 0;
});

if (missing.length > 0) {
  console.error(`Missing required mobile runtime configuration: ${missing.join(', ')}`);
  process.exit(1);
}

console.log('Required mobile runtime configuration is present.');
