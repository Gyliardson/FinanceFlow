const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const incomePath = path.join(__dirname, '..', 'src', 'screens', 'IncomeScreen.tsx');
const income = fs.readFileSync(incomePath, 'utf8');

// The production screen must assign every refresh a monotonically increasing generation.
assert.match(income, /const refreshGeneration = useRef\(0\);/);
assert.match(income, /const generation = \+\+refreshGeneration\.current;/);

// Stale successes and stale failures must return before publishing UI state.
assert.match(income, /const response = await api\.get\('\/incomes'\);\s*if \(generation !== refreshGeneration\.current\) return;\s*setIncomes\(/s);
assert.match(income, /catch \{\s*if \(generation !== refreshGeneration\.current\) return;\s*setLoadError\(true\);/s);
assert.match(income, /finally \{\s*if \(generation === refreshGeneration\.current\) \{\s*setLoading\(false\);/s);

// Leaving the screen invalidates any request that is still in flight.
assert.match(income, /navigation\.addListener\('blur', \(\) => \{\s*refreshGeneration\.current \+= 1;/s);
assert.match(income, /return \(\) => \{\s*refreshGeneration\.current \+= 1;\s*unsubscribeFocus\(\);\s*unsubscribeBlur\(\);/s);

// Focus, retry, and post-save refresh entry points remain active.
assert.match(income, /navigation\.addListener\('focus', fetchIncomes\)/);
assert.match(income, /onPress=\{fetchIncomes\}/);
assert.match(income, /await fetchIncomes\(\);\s*Alert\.alert\('Renda adicionada'/s);

// Deterministic model of the same generation rule: a newer success wins even if an
// older success/error settles afterwards.
function createPublisher() {
  let generation = 0;
  const state = { data: [], error: false, loading: false };
  return {
    begin() {
      const mine = ++generation;
      state.loading = true;
      state.error = false;
      return {
        success(data) {
          if (mine !== generation) return;
          state.data = data;
        },
        fail() {
          if (mine !== generation) return;
          state.error = true;
        },
        finish() {
          if (mine === generation) state.loading = false;
        },
      };
    },
    state,
  };
}

const successRace = createPublisher();
const olderSuccess = successRace.begin();
const newerSuccess = successRace.begin();
newerSuccess.success(['new']);
newerSuccess.finish();
olderSuccess.success(['old']);
olderSuccess.finish();
assert.deepEqual(successRace.state, { data: ['new'], error: false, loading: false });

const errorRace = createPublisher();
const olderError = errorRace.begin();
const newerOk = errorRace.begin();
newerOk.success(['authoritative']);
newerOk.finish();
olderError.fail();
olderError.finish();
assert.deepEqual(errorRace.state, { data: ['authoritative'], error: false, loading: false });

console.log('INCOME_REFRESH_GENERATION_CONTRACT=pass');
