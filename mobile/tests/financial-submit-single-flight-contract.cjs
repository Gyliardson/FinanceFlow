const fs = require('fs');
const assert = require('assert');

const hook = fs.readFileSync('mobile/src/services/useFinancialMutation.ts', 'utf8');
const income = fs.readFileSync('mobile/src/screens/IncomeScreen.tsx', 'utf8');

const mutateStart = hook.indexOf('const mutate = useCallback((');
const concurrentCheck = hook.indexOf(
  'if (mutationInFlightRef.current && mutationInFlightPromiseRef.current)',
  mutateStart,
);
const coalescedReturn = hook.indexOf('return mutationInFlightPromiseRef.current;', concurrentCheck);
const lockClaim = hook.indexOf('mutationInFlightRef.current = true;', coalescedReturn);
const runStart = hook.indexOf('const run = (async', lockClaim);
const firstAwait = hook.indexOf('await getValidAuthSessionSnapshot()', runStart);
const identityAllocation = hook.indexOf('createFinancialIntentId()', firstAwait);
const transport = hook.indexOf('await postFinancialMutation<T>', identityAllocation);
const preserveResponse = hook.indexOf('return response;', transport);
const promisePublish = hook.indexOf('mutationInFlightPromiseRef.current = run;', preserveResponse);
const cleanup = hook.indexOf('void run.finally(() => {', promisePublish);
const promiseRelease = hook.indexOf('mutationInFlightPromiseRef.current = null;', cleanup);
const lockRelease = hook.indexOf('mutationInFlightRef.current = false;', promiseRelease);

assert(mutateStart >= 0, 'financial mutate callback must exist');
assert(concurrentCheck > mutateStart, 'financial mutate must synchronously detect re-entrancy');
assert(coalescedReturn > concurrentCheck, 'concurrent activation must share the current Promise');
assert(lockClaim > coalescedReturn, 'fresh execution must claim the synchronous single-flight guard');
assert(runStart > lockClaim, 'the guard must be claimed before starting async preflight');
assert(firstAwait > runStart, 'auth/pending preflight remains inside the guarded operation');
assert(identityAllocation > firstAwait, 'fresh identity remains allocated after owner/pending preflight');
assert(transport > identityAllocation, 'transport must use the already-claimed logical identity');
assert(preserveResponse > transport, 'coalescing must preserve the existing Axios response contract');
assert(promisePublish > preserveResponse, 'the in-flight Promise must be published for concurrent callers');
assert(cleanup > promisePublish, 'single-flight lifecycle must install terminal cleanup');
assert(promiseRelease > cleanup && lockRelease > promiseRelease, 'both Promise and lock must release after completion');

assert(hook.includes('const mutationInFlightRef = useRef(false);'));
assert(hook.includes('const mutationInFlightPromiseRef = useRef<Promise<AxiosResponse<T>> | null>(null);'));
assert(
  !hook.includes("throw new Error('A financial mutation is already in progress for this form.')"),
  'rapid duplicate activation must not surface a false ambiguous/transport failure',
);

// Screen-level `saving` remains UX state. The correctness boundary is centralized
// in useFinancialMutation so a stale React event closure cannot create two intents.
assert(income.includes('const [saving, setSaving] = useState(false);'));
assert(income.includes('await incomeMutation.mutate({'));

console.log('FINANCIAL_SUBMIT_SINGLE_FLIGHT_CONTRACT=pass');
