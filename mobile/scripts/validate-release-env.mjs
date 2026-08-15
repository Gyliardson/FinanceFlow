const REQUIRED_PUBLIC_RUNTIME_VARS = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];

const ENDPOINT_VARS = [
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_SUPABASE_URL',
];

const missing = REQUIRED_PUBLIC_RUNTIME_VARS.filter((name) => {
  const value = process.env[name];
  return typeof value !== 'string' || value.trim().length === 0;
});

if (missing.length > 0) {
  console.error(`Missing required mobile runtime configuration: ${missing.join(', ')}`);
  process.exit(1);
}

const isUnsafeLocalHostname = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '0.0.0.0'
    || normalized === '::'
    || normalized === '::1'
  ) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  return octets[0] === 127;
};

const validateEndpoint = (name) => {
  const raw = process.env[name].trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return `${name} must be an absolute HTTPS URL`;
  }

  if (parsed.protocol !== 'https:') {
    return `${name} must use HTTPS`;
  }
  if (!parsed.hostname) {
    return `${name} must include a hostname`;
  }
  if (parsed.username || parsed.password) {
    return `${name} must not contain embedded URL credentials`;
  }
  if (parsed.search || parsed.hash) {
    return `${name} must not contain a query string or fragment`;
  }
  if (isUnsafeLocalHostname(parsed.hostname)) {
    return `${name} must not target a local or loopback host in a publishable release`;
  }
  return null;
};

const endpointErrors = ENDPOINT_VARS
  .map(validateEndpoint)
  .filter(Boolean);

if (endpointErrors.length > 0) {
  // Error messages identify only the variable and violated invariant. Never print
  // configured endpoint/key values into CI logs.
  endpointErrors.forEach((message) => console.error(message));
  process.exit(1);
}

console.log('Required mobile runtime configuration is present and release-safe.');
