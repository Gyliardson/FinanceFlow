const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const networkPath = path.join(__dirname, '..', 'src', 'components', 'NetworkStatus.tsx');
const homePath = path.join(__dirname, '..', 'src', 'screens', 'HomeScreen.tsx');
const network = fs.readFileSync(networkPath, 'utf8');
const home = fs.readFileSync(homePath, 'utf8');

// Offline resume reconciliation must reuse the existing retry path rather than
// inventing a second financial state model or a polling loop.
assert.match(network, /import \{ AppState, View, Text, StyleSheet, TouchableOpacity \} from 'react-native';/);
assert.match(network, /useEffect\(\(\) => \{\s*if \(!isOffline \|\| !onRetry\) return undefined;/s);
assert.match(
  network,
  /AppState\.addEventListener\('change', \(state\) => \{\s*if \(state === 'active'\) \{\s*onRetry\(\);\s*\}\s*\}\);/s,
);
assert.match(network, /return \(\) => subscription\.remove\(\);\s*\}, \[isOffline, onRetry\]\);/s);

// Home supplies its existing generation-ordered authoritative refresh callback
// to the offline banner. Resume retries therefore inherit the same stale-result
// protection and owner-scoped cache/auth semantics.
assert.match(
  home,
  /<NetworkStatus[\s\S]*?isOffline=\{loadState === 'offline-cache'\}[\s\S]*?onRetry=\{loadAllData\}/s,
);
assert.match(home, /const generation = \+\+refreshGeneration\.current;/);
assert.match(home, /if \(generation !== refreshGeneration\.current\) return;/);

console.log('OFFLINE_RESUME_RECONCILIATION_CONTRACT=pass');
