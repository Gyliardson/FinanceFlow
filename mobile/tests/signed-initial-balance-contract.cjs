const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const home = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'HomeScreen.tsx'), 'utf8');

const requireMatch = (pattern, message) => assert.match(home, pattern, message);

// Production source coupling: the settings UI must carry sign separately from
// cent-entry magnitude so decimal keyboards without a minus key stay usable.
requireMatch(/const \[initialBalanceNegative, setInitialBalanceNegative\] = useState\(false\);/, 'Home must model the initial-balance sign explicitly');
requireMatch(/setInitialBalanceNegative\(Number\(settings\.initial_balance \?\? 0\) < 0\);/, 'Hydration must restore a persisted negative sign');
requireMatch(/Math\.abs\(Number\(settings\.initial_balance\)\)\.toFixed\(2\)/, 'Hydration must keep the editable magnitude unsigned');
requireMatch(/const balanceMagnitude = Number\(initialBalance\.replace\(',', '\.'\)\);/, 'Save must parse the cent-entry magnitude independently');
requireMatch(/const balance = initialBalanceNegative && balanceMagnitude !== 0 \? -balanceMagnitude : balanceMagnitude;/, 'Save must reapply the explicit sign without creating negative zero');
requireMatch(/text\.includes\('-'\)/, 'Pasted negative input must preserve negative intent instead of silently dropping the sign');
requireMatch(/accessibilityLabel="Saldo inicial negativo"/, 'Negative sign control must have an accessible name');
requireMatch(/accessibilityRole="switch"/, 'Negative sign control must expose switch semantics');
requireMatch(/accessibilityState=\{\{ checked: initialBalanceNegative \}\}/, 'Negative sign control must expose its current state');
requireMatch(/setEmergencyGoal\(formatCurrencyInput\(text\)\)/, 'Emergency-fund goal must remain on the unsigned currency boundary');
assert.doesNotMatch(home, /const balance = Number\(initialBalance\.replace/, 'Save must not regress to parsing the visible magnitude as an implicitly positive balance');

// Deterministic behavior model for edge cases required by #108. The source
// assertions above bind these semantics to the production implementation.
const formatMagnitude = (value) => {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return '';
  return (Number(digits) / 100).toFixed(2).replace('.', ',');
};
const serializeBalance = (display, negative) => {
  const magnitude = Number(display.replace(',', '.'));
  return negative && magnitude !== 0 ? -magnitude : magnitude;
};

assert.equal(formatMagnitude('12345'), '123,45');
assert.equal(serializeBalance('123,45', false), 123.45, 'positive balance must remain positive');
assert.equal(serializeBalance('123,45', true), -123.45, 'negative sign must survive serialization');
assert.equal(serializeBalance('0,00', true), 0, 'negative zero must normalize to zero');
assert.equal(formatMagnitude('-12345'), '123,45', 'magnitude formatter remains sign-agnostic by design');
assert.equal(formatMagnitude('999'), '9,99', 'unsigned emergency goal keeps Brazilian cent-entry behavior');

console.log('Signed initial balance contract passed.');
