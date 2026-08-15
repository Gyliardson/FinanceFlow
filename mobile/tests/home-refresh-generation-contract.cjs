const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const homePath = path.join(__dirname, '..', 'src', 'screens', 'HomeScreen.tsx');
const cachePath = path.join(__dirname, '..', 'src', 'services', 'userCache.ts');
const home = fs.readFileSync(homePath, 'utf8');
const cache = fs.readFileSync(cachePath, 'utf8');

// Focus, pull-to-refresh and post-settings reconciliation may overlap. Every refresh
// receives a monotonically increasing generation and stale results must return before
// publishing financial state.
assert.match(home, /const refreshGeneration = useRef\(0\);/);
assert.match(home, /const generation = \+\+refreshGeneration\.current;/);
assert.match(home, /await Promise\.all\(\[fetchBills\(\), fetchSettings\(\)\]\);\s*if \(generation !== refreshGeneration\.current\) return;/s);

// The resource fetchers must be side-effect free: authoritative/offline data is returned
// first and only the current generation may publish it to React state or durable cache.
const fetchSection = home.match(/const fetchBills[\s\S]*?const loadAllData/);
assert.ok(fetchSection, 'Home resource fetch section must remain identifiable');
assert.doesNotMatch(fetchSection[0], /setAllBills\(|hydrateSettings\(|trySetUserCache\(/);

const publishGuard = /if \(generation !== refreshGeneration\.current\) return;([\s\S]*?)const fullyOnline/;
const publishSection = home.match(publishGuard);
assert.ok(publishSection, 'Home must publish only after the generation guard');
assert.match(publishSection[1], /setAllBills\(billsResult\.data \?\? \[\]\)/);
assert.match(publishSection[1], /hydrateSettings\(settingsResult\.data\)/);
assert.match(publishSection[1], /trySetUserCache\(userId, 'bills', billsResult\.data\)/);
assert.match(publishSection[1], /trySetUserCache\(userId, 'settings', settingsResult\.data\)/);

// Older refreshes must not clear loading/refreshing after a newer generation starts.
assert.match(home, /finally \{\s*if \(generation === refreshGeneration\.current\) \{\s*setLoading\(false\);\s*setRefreshing\(false\);/s);

// Session/owner identity cleanup invalidates outstanding Home work. Durable cache itself
// serializes per owner/resource, ensuring a later accepted write finishes after an earlier one.
assert.match(home, /useEffect\(\(\) => \(\) => \{\s*refreshGeneration\.current \+= 1;\s*\}, \[userId\]\);/s);
assert.match(cache, /const cacheResourceTails = new Map<string, Promise<void>>\(\);/);
assert.match(cache, /async function withCacheResourceLock/);

// Both independent refresh entry points remain active; the fix is ordering-safe rather
// than silently disabling focus reconciliation or user-initiated refresh.
assert.match(home, /navigation\.addListener\('focus', loadAllData\)/);
assert.match(home, /const onRefresh = \(\) => \{\s*setRefreshing\(true\);\s*void loadAllData\(\);/s);

console.log('HOME_REFRESH_GENERATION_CONTRACT=pass');
