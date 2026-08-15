const fs = require('fs');
const assert = require('assert');

const hook = fs.readFileSync('mobile/src/services/useFinancialMutation.ts', 'utf8');
const income = fs.readFileSync('mobile/src/screens/IncomeScreen.tsx', 'utf8');

const mutateStart = hook.indexOf('const mutate = useCallback(async');
const lockCheck = hook.indexOf('if (mutationInFlightRef.current)', mutateStart);
const lockClaim = hook.indexOf('mutationInFlightRef.current = true;', mutateStart);
const firstAwait = hook.indexOf('await getValidAuthSessionSnapshot()', mutateStart);
const identityAllocation = hook.indexOf('createFinancialIntentId()', mutateStart);
const transport = hook.indexOf('await postFinancialMutation<T>', mutateStart);
const finallyBlock = hook.indexOf('} finally {', mutateStart);
const lockRelease = hook.indexOf('mutationInFlightRef.current = false;', finallyBlock);

assert(mutateStart >= 0, 'financial mutate callback must exist');
assert(lockCheck > mutateStart, 'financial mutate must synchronously reject re-entrancy');
assert(lockClaim > lockCheck, 'financial mutate must claim the single-flight guard');
assert(firstAwait > lockClaim, 'single-flight guard must be claimed before the first async preflight await');
assert(identityAllocation > firstAwait, 'fresh logical identity remains allocated after owner/pending preflight');
assert(transport > identityAllocation, 'transport must use the already-claimed logical identity');
assert(finallyBlock > transport, 'single-flight lifecycle must have a finally block covering transport/preflight');
assert(lockRelease > finallyBlock, 'single-flight guard must release in finally');

assert(
  hook.includes("const mutationInFlightRef = useRef(false);"),
  'single-flight state must be synchronous hook-local ref state, not React render state',
);
assert(
  hook.includes('Ambiguous\n      // failures intentionally retain intentIdRef')
    || hook.includes('Ambiguous\n      // failures intentionally retain intentIdRef'),
  'implementation must document ambiguous retry identity retention',
);

// Screen-level `saving` remains UX state. The correctness boundary is centralized
// in useFinancialMutation so a stale React event closure cannot create two intents.
assert(income.includes('const [saving, setSaving] = useState(false);'));
assert(income.includes('await incomeMutation.mutate({'));

console.log('FINANCIAL_SUBMIT_SINGLE_FLIGHT_CONTRACT=pass');
