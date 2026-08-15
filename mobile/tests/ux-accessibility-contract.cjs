const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const home = read('src/screens/HomeScreen.tsx');
const detail = read('src/screens/DetailScreen.tsx');
const income = read('src/screens/IncomeScreen.tsx');
const insights = read('src/screens/InsightsScreen.tsx');
const payment = read('src/screens/PaymentScreen.tsx');
const financialDate = read('src/services/financialDate.ts');
const notifications = read('src/services/NotificationService.ts');

const requireMatch = (source, pattern, message) => {
  assert.match(source, pattern, message);
};

// Dashboard financial data must fail closed when neither the API nor the
// owner-scoped bills cache can provide an authoritative bill list.
requireMatch(home, /type LoadState = 'ready' \| 'offline-cache' \| 'unavailable'/, 'Home must model ready/offline/unavailable states explicitly');
requireMatch(home, /const hasAuthoritativeFailure = billsResult\.authoritativeFailure \|\| settingsResult\.authoritativeFailure;/, 'Any authoritative read rejection must fail the dashboard as a whole closed');
requireMatch(home, /const usableOfflineData = billsResult\.hasData && !hasAuthoritativeFailure;/, 'Offline bills are usable only when no parallel read was authoritatively rejected');
assert.doesNotMatch(home, /billsResult\.hasData\s*\|\|\s*settingsResult\.hasData/, 'Settings cache must never substitute for the bill list');
requireMatch(home, /canUseOfflineCacheForApiFailure/, 'Dashboard must classify API failures before selecting financial cache');
requireMatch(home, /catch \(error\) \{\s*if \(!canUseOfflineCacheForApiFailure\(error\)\) \{\s*setAllBills\(\[\]\);[\s\S]*?authoritativeFailure: true/, 'Bills must fail closed before cache lookup on authoritative HTTP rejection');
requireMatch(home, /catch \(error\) \{\s*if \(!canUseOfflineCacheForApiFailure\(error\)\) \{\s*return \{ online: false, hasData: false, authoritativeFailure: true \};/, 'Settings must fail closed before cache lookup on authoritative HTTP rejection');
requireMatch(home, /accessibilityRole="tab"/, 'Dashboard tabs must expose tab semantics');
requireMatch(home, /accessibilityState=\{\{ selected \}\}/, 'Dashboard tabs must expose selected state');
requireMatch(home, /accessibilityLabel="Adicionar nova fatura"/, 'Dashboard FAB must have an accessible name');
requireMatch(home, /accessibilityLiveRegion="assertive"/, 'Dashboard unavailable state must be announced');
requireMatch(home, /new Intl\.NumberFormat\('pt-BR'/, 'Dashboard monetary display must use the locale-aware formatter');
requireMatch(home, /KeyboardAvoidingView/, 'Dashboard settings form must be keyboard-safe');
requireMatch(home, /Resultado não confirmado/, 'Settings save failures must communicate an ambiguous outcome');
requireMatch(home, /Recarregue os dados para reconciliar o estado antes de tentar novamente\./, 'Settings save failures must direct the user to reconcile authoritative state');
assert.doesNotMatch(home, /Nenhum valor foi alterado\./, 'Settings save failures must never claim rollback without server proof');

// Goal-only edits must not replay a stale full settings snapshot. A partial
// server mutation keeps initial balance/date independent under concurrency.
requireMatch(insights, /api\.patch\('\/settings\/emergency-fund-goal', \{ emergency_fund_goal: goalVal \}\)/, 'Reserve goal editor must use the narrow server-side settings mutation');
assert.doesNotMatch(insights, /api\.get\('\/settings'\)/, 'Reserve goal editor must not prefetch a full settings snapshot before saving');
assert.doesNotMatch(insights, /api\.post\('\/settings', \{ \.\.\./, 'Reserve goal editor must not spread stale settings into a full replacement');
requireMatch(insights, /Não foi possível confirmar se a meta foi salva\./, 'Goal update failures must communicate an unconfirmed outcome');

// Payment receipts must preserve a supported image representation instead of
// declaring every selected asset as JPEG and weakening the server MIME contract.
requireMatch(payment, /'image\/jpeg': 'jpg'/, 'Payment upload must support canonical JPEG metadata');
requireMatch(payment, /'image\/png': 'png'/, 'Payment upload must support canonical PNG metadata');
requireMatch(payment, /'image\/webp': 'webp'/, 'Payment upload must support canonical WebP metadata');
requireMatch(payment, /normalizeReceiptMime\(asset\.mimeType\)/, 'Picker MIME metadata must be preferred when available');
requireMatch(payment, /type: receipt\.mimeType/, 'Multipart receipt MIME must come from the selected asset contract');
requireMatch(payment, /name: `comprovante_\$\{selectedBill\.id\}\.\$\{extension\}`/, 'Receipt filename extension must match its multipart MIME');
assert.doesNotMatch(payment, /type:\s*'image\/jpeg'/, 'Arbitrary payment receipts must not be hardcoded as JPEG');

// Receipt-backed payment can commit before a timeout/response loss. The client
// must reconcile owner-scoped authoritative state before suggesting another upload.
requireMatch(payment, /const isAmbiguousReceiptPaymentFailure =/, 'Payment UX must classify ambiguous receipt outcomes explicitly');
requireMatch(payment, /status === 408 \|\| status === 409 \|\| status === 425 \|\| status === 429 \|\| status >= 500/, 'Timeout-like and server-side receipt outcomes must remain ambiguous until reconciled');
requireMatch(payment, /api\.get\(`\/bills\/\$\{billId\}\/detail`\)/, 'Ambiguous receipt payments must reconcile through the owner-scoped bill detail route');
requireMatch(payment, /if \(reconciliation === 'paid'\)/, 'Authoritative paid state must converge the ambiguous receipt flow to success');
requireMatch(payment, /cancelNotificationsForBill\(selectedBill\.id\)/, 'Reconciled paid state must cancel stale bill reminders');
requireMatch(payment, /Alert\.alert\('Resultado não confirmado', message\)/, 'Unresolved receipt outcomes must remain explicitly unconfirmed');
requireMatch(payment, /confirme o estado da fatura antes de enviar outro comprovante/, 'Ambiguous receipt UX must require reconciliation before another upload');
assert.doesNotMatch(payment, /O envio demorou demais\. Verifique sua conexão e tente novamente com uma imagem menor\./, 'Receipt timeout must never regress to blind retry guidance');

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

// Local notification previews can be visible on a locked device. Visible copy
// must stay generic while billId may remain internal data for cancellation.
requireMatch(notifications, /_billName: string/, 'Notification API must explicitly mark bill name as non-rendered input');
requireMatch(notifications, /data: \{ billId, type: 'reminder' \}/, 'Reminder identity must remain internal notification data');
requireMatch(notifications, /data: \{ billId, type: 'urgent' \}/, 'Due-day identity must remain internal notification data');
assert.doesNotMatch(notifications, /body:\s*\([^)]*name[^)]*\)\s*=>/, 'Visible notification body builders must not accept bill names');
assert.doesNotMatch(notifications, /\$\{(?:billName|_billName|name)\}/, 'Visible notification strings must not interpolate bill names');
assert.doesNotMatch(notifications, /AINDA NÃO PAGOU|Não vacile|ÚLTIMA CHANCE|💀|🔥/, 'Notification copy must remain professional and non-coercive');
requireMatch(notifications, /Abra o FinanceFlow para conferir os detalhes\./, 'Privacy-safe previews must still provide a useful action');

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