const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', name), 'utf8');
const withoutLineComments = (source) => source.replace(/\/\/.*$/gm, '');
const income = read('IncomeScreen.tsx');
const insights = read('InsightsScreen.tsx');

const requires = (source, snippet, message) => {
  assert.ok(source.includes(snippet), message || `missing invariant: ${snippet}`);
};

// Income: foreground resume reuses the existing authoritative publisher only while
// the screen is actually relevant and no local/ambiguous financial interaction is active.
requires(income, "AppState.addEventListener('change'");
requires(income, "state === 'active'");
requires(income, 'navigation.isFocused()');
requires(income, '!modalVisible');
requires(income, '!saving');
requires(income, '!intentLocked');
requires(income, 'void fetchIncomes();');
requires(income, 'appStateSubscription.remove();');
requires(income, 'const generation = ++refreshGeneration.current;');
requires(income, 'if (generation !== refreshGeneration.current) return;');

const incomeListenerStart = income.indexOf("const appStateSubscription = AppState.addEventListener('change'");
const incomeListenerEnd = income.indexOf('return () => appStateSubscription.remove();', incomeListenerStart);
assert.ok(incomeListenerStart >= 0 && incomeListenerEnd > incomeListenerStart, 'Income AppState listener must be bounded');
const incomeListener = income.slice(incomeListenerStart, incomeListenerEnd);
assert.ok(incomeListener.includes('void fetchIncomes();'), 'Income resume must use the canonical authoritative fetch');
assert.ok(!incomeListener.includes('incomeMutation.mutate'), 'Income resume must never trigger a financial mutation');

// Insights: foreground resume is passive/local only. It may reconcile persisted
// insight + local aggregates through GET /insights, but must never contact external AI.
requires(insights, "AppState.addEventListener('change'");
requires(insights, "state === 'active'");
requires(insights, 'navigation.isFocused()');
requires(insights, '!snapshotBusy');
requires(insights, '!modalVisible');
requires(insights, '!goalModalVisible');
requires(insights, '!intentLocked');
requires(insights, 'void fetchInsights();');
requires(insights, 'appStateSubscription.remove();');
requires(insights, "const resp = await api.get('/insights');");
requires(insights, "const resp = await api.post('/insights/refresh');");
requires(insights, 'const generation = ++snapshotGeneration.current;');
requires(insights, 'if (generation !== snapshotGeneration.current) return;');

const insightsListenerStart = insights.indexOf("const appStateSubscription = AppState.addEventListener('change'");
const insightsListenerEnd = insights.indexOf('return () => appStateSubscription.remove();', insightsListenerStart);
assert.ok(insightsListenerStart >= 0 && insightsListenerEnd > insightsListenerStart, 'Insights AppState listener must be bounded');
const insightsListener = insights.slice(insightsListenerStart, insightsListenerEnd);
const executableInsightsListener = withoutLineComments(insightsListener);
assert.ok(insightsListener.includes('void fetchInsights();'), 'Insights resume must use passive snapshot reconciliation');
assert.ok(!/\bhandleRefreshAI\s*\(/.test(executableInsightsListener), 'Insights resume must never invoke explicit AI refresh');
assert.ok(!executableInsightsListener.includes("api.post('/insights/refresh')"), 'Insights resume must never contact external AI directly');

// Explicit AI remains a user-action handler and is kept separate from lifecycle work.
assert.ok(
  insights.indexOf('const handleRefreshAI = async () =>') < insights.indexOf("api.post('/insights/refresh')"),
  'external AI call must remain inside the explicit refresh handler',
);

console.log('PASSIVE_RESUME_RECONCILIATION_CONTRACT=pass');
