const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const historyPath = path.join(__dirname, '..', 'src', 'screens', 'BillHistoryScreen.tsx');
const history = fs.readFileSync(historyPath, 'utf8');

// Returning from Payment reuses the mounted BillHistory screen, so authoritative
// financial detail must be refreshed on navigation focus rather than mount only.
assert.match(history, /import \{ useFocusEffect \} from '@react-navigation\/native';/);
assert.match(history, /useFocusEffect\(\s*useCallback\(\(\) => \{\s*void fetchDetail\(\);/s);
assert.doesNotMatch(
  history,
  /useEffect\(\(\) => \{\s*fetchDetail\(\);\s*\}, \[billId\]\);/s,
  'BillHistory must not regress to mount/billId-only reconciliation',
);

// Stale financial UI is cleared before each authoritative reconciliation. A failed
// focus refresh therefore cannot keep a prior pending/paid state or payment CTA on screen.
assert.match(history, /setLoading\(true\);\s*setBill\(null\);\s*setHistory\(\[\]\);\s*setFailure\(null\);/s);
assert.match(history, /error\?\.response\?\.status === 404 \? 'not-found' : 'unavailable'/);

// Focus changes, bill identity changes and overlapping retries can all leave an old
// request in flight. Only the newest request may publish authoritative detail/state.
assert.match(history, /const detailRequestSequence = useRef\(0\);/);
assert.match(history, /const requestId = \+\+detailRequestSequence\.current;/);
assert.match(history, /if \(requestId !== detailRequestSequence\.current\) return;/);
assert.match(history, /detailRequestSequence\.current \+= 1;/);
assert.match(history, /if \(requestId === detailRequestSequence\.current\) \{\s*setLoading\(false\);\s*\}/s);

// Payment remains available only from freshly reconciled unpaid detail and preserves
// the explicit bill identity contract established by #114.
assert.match(history, /\{!isPaid && \(/);
assert.match(history, /navigation\.navigate\('Payment', \{ billId: bill\.id \}\)/);

console.log('BILL_DETAIL_FOCUS_REFRESH_CONTRACT=pass');
