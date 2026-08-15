const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const home = read('src/screens/HomeScreen.tsx');
const detail = read('src/screens/DetailScreen.tsx');
const income = read('src/screens/IncomeScreen.tsx');
const financialDate = read('src/services/financialDate.ts');

const requireMatch = (source, pattern, message) => {
  assert.match(source, pattern, message);
};

// Dashboard financial data must fail closed when neither the API nor the
// owner-scoped bills cache can provide an authoritative bill list.
requireMatch(home, /type LoadState = 'ready' \| 'offline-cache' \| 'unavailable'/, 'Home must model ready/offline/unavailable states explicitly');
requireMatch(home, /const usableOfflineData = billsResult\.hasData;/, 'Bills availability must be required for offline dashboard data');
assert.doesNotMatch(home, /billsResult\.hasData\s*\|\|\s*settingsResult\.hasData/, 'Settings cache must never substitute for the bill list');
requireMatch(home, /accessibilityRole="tab"/, 'Dashboard tabs must expose tab semantics');
requireMatch(home, /accessibilityState=\{\{ selected \}\}/, 'Dashboard tabs must expose selected state');
requireMatch(home, /accessibilityLabel="Adicionar nova fatura"/, 'Dashboard FAB must have an accessible name');
requireMatch(home, /accessibilityLiveRegion="assertive"/, 'Dashboard unavailable state must be announced');
requireMatch(home, /new Intl\.NumberFormat\('pt-BR'/, 'Dashboard monetary display must use the locale-aware formatter');
requireMatch(home, /KeyboardAvoidingView/, 'Dashboard settings form must be keyboard-safe');
requireMatch(home, /Resultado não confirmado/, 'Settings save failures must communicate an ambiguous outcome');
requireMatch(home, /Recarregue os dados para reconciliar o estado antes de tentar novamente\./, 'Settings save failures must direct the user to reconcile authoritative state');
assert.doesNotMatch(home, /Nenhum valor foi alterado\./, 'Settings save failures must never claim rollback without server proof');

// Creation/OCR is a high-risk input path. Keep provider details out of UX/logs,
// retain upload guardrails, and require explicit review/accessibility cues.
requireMatch(detail, /MAX_CLIENT_UPLOAD_BYTES = 10 \* 1024 \* 1024/, 'Client upload path must retain its 10 MiB early guard');
requireMatch(detail, /type: 'application\/pdf'/, 'Document picker must be restricted to PDF in the PDF action');
requireMatch(detail, /accessibilityLabel="Usar preenchimento manual"/, 'Creation mode switch must have an accessible name');
requireMatch(detail, /accessibilityLabel="Salvar nova fatura"/, 'Save action must have an accessible name');
requireMatch(detail, /Revise valor, vencimento e linha digitável antes de confirmar\./, 'OCR flow must tell users to review critical extracted fields');
requireMatch(detail, /KeyboardAvoidingView/, 'Creation form must be keyboard-safe');
assert.doesNotMatch(detail, /console\.(?:log|error)\s*\(/, 'Creation/OCR screen must not log raw provider/request errors');
assert.doesNotMatch(detail, /Gemini/, 'User-facing creation flow must not be coupled to a specific AI provider');

// Financial date-only values use the product IANA calendar, never UTC slicing or
// the device-local calendar. Keep this UX-level contract aligned with the deeper
// deterministic financial-date contract.
requireMatch(financialDate, /FINANCIAL_TIME_ZONE = 'America\/Sao_Paulo'/, 'Financial date helper must use the product IANA timezone');
requireMatch(financialDate, /timeZone: FINANCIAL_TIME_ZONE/, 'Financial date derivation must explicitly bind Intl to the product timezone');
requireMatch(income, /from '\.\.\/services\/financialDate'/, 'Income creation must use the canonical financial date boundary');
requireMatch(income, /date:\s*financialDateOnly\(\)/, 'Income creation must derive its business date from the canonical financial calendar');
requireMatch(income, /const formatDateOnly =/, 'Income display must format date-only strings without UTC parsing');
assert.doesNotMatch(income, /const localIsoDate =/, 'Device-local date helpers must not replace the fixed product financial timezone');
assert.doesNotMatch(income, /toISOString\(\)\.split\(/, 'Income creation must not derive the business date from UTC ISO time');
assert.doesNotMatch(income, /new Date\(item\.date\)/, 'Stored date-only income values must not be parsed as UTC Date objects');

console.log('Mobile UX/accessibility contract passed.');
