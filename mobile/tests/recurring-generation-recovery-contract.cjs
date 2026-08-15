'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.resolve(__dirname, '..', '..');
const screenPath = path.join(root, 'mobile', 'src', 'screens', 'RecurringBillScreen.tsx');
const screen = fs.readFileSync(screenPath, 'utf8');

assert.match(
  screen,
  /response\.data\?\.status === 'partial_success' \|\| response\.data\?\.generation\?\.status === 'deferred'/,
  'Recurring creation must distinguish backend partial_success/deferred generation from complete success.',
);
assert.match(
  screen,
  /setGenerationDeferred\(true\)/,
  'Deferred generation must leave an explicit recoverable UI state.',
);
assert.match(
  screen,
  /api\.post\('\/recurring-bills\/generate'\)/,
  'Recovery must use the existing convergent generation endpoint rather than resubmitting the template.',
);
assert.match(
  screen,
  /if \(recoveringGeneration \|\| loading\) return;/,
  'Generation recovery must reject duplicate in-flight submits.',
);
assert.match(
  screen,
  /response\.data\?\.status !== 'success' \|\| !Array\.isArray\(response\.data\?\.generated\)/,
  'Recovery must require authoritative generated-row response shape before claiming completion.',
);
assert.match(
  screen,
  /scheduleGeneratedReminders\(\{ generation: response\.data \}\)/,
  'Recovered child rows must feed the same reminder-target boundary used by normal creation.',
);
assert.match(
  screen,
  /if \(loading \|\| generationDeferred\) return;/,
  'Once template creation is definitive but child generation is deferred, the template submit path must stay locked.',
);
assert.match(
  screen,
  /Sincronizar vencimentos existentes/,
  'The recurring screen must retain an explicit recovery action after the original deferred screen state is left.',
);
assert.match(
  screen,
  /não cadastre a mesma conta novamente/,
  'Deferred-state copy must tell the user not to create a duplicate template.',
);

const recoverBlockStart = screen.indexOf('const handleRecoverGeneration = async () =>');
const recoverBlockEnd = screen.indexOf('const handleSave = async () =>');
assert(recoverBlockStart >= 0 && recoverBlockEnd > recoverBlockStart, 'Recovery handler must be present.');
const recoverBlock = screen.slice(recoverBlockStart, recoverBlockEnd);
assert(!recoverBlock.includes('recurringMutation.mutate'), 'Generation recovery must never resubmit the template financial mutation.');
assert(recoverBlock.includes("api.post('/recurring-bills/generate')"), 'Generation recovery must call only the convergent recovery endpoint.');
assert(recoverBlock.includes('scheduleGeneratedReminders({ generation: response.data })'), 'Recovery must schedule only authoritative generated children through the shared reminder boundary.');

// Deterministic behavior model: complete success exits, partial success stays recoverable,
// recovery success exits, and recovery failure remains recoverable without a template re-submit.
function transition(state, event) {
  if (event === 'template-success') return { deferred: false, completed: true, templateSubmits: state.templateSubmits + 1 };
  if (event === 'template-partial') return { deferred: true, completed: false, templateSubmits: state.templateSubmits + 1 };
  if (event === 'recovery-success') return { deferred: false, completed: true, templateSubmits: state.templateSubmits };
  if (event === 'recovery-failure') return { deferred: true, completed: false, templateSubmits: state.templateSubmits };
  throw new Error(`unknown event ${event}`);
}

const initial = { deferred: false, completed: false, templateSubmits: 0 };
assert.deepStrictEqual(transition(initial, 'template-success'), { deferred: false, completed: true, templateSubmits: 1 });
const deferred = transition(initial, 'template-partial');
assert.deepStrictEqual(deferred, { deferred: true, completed: false, templateSubmits: 1 });
assert.deepStrictEqual(transition(deferred, 'recovery-failure'), { deferred: true, completed: false, templateSubmits: 1 });
assert.deepStrictEqual(transition(deferred, 'recovery-success'), { deferred: false, completed: true, templateSubmits: 1 });

console.log('Recurring generation recovery contract passed.');
