const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screenPath = path.join(__dirname, '..', 'src', 'screens', 'InsightsScreen.tsx');
const routesPath = path.join(__dirname, '..', '..', 'backend', 'insights_routes.py');
const screen = fs.readFileSync(screenPath, 'utf8');
const routes = fs.readFileSync(routesPath, 'utf8');

// Passive GET and explicit AI refresh share one monotonically increasing publication boundary.
assert.match(screen, /const snapshotGeneration = useRef\(0\);/);
assert.match(screen, /const fetchInsights = async \(\) => \{\s*const generation = \+\+snapshotGeneration\.current;/s);
assert.match(screen, /const handleRefreshAI = async \(\) => \{[\s\S]*?const generation = \+\+snapshotGeneration\.current;/);
assert.match(screen, /await api\.get\('\/insights'\);\s*if \(generation !== snapshotGeneration\.current\) return;/s);
assert.match(screen, /await api\.post\('\/insights\/refresh'\);\s*if \(generation !== snapshotGeneration\.current\) return;/s);
assert.match(screen, /catch \(e: any\) \{\s*if \(generation !== snapshotGeneration\.current\) return;/s);
assert.match(screen, /catch \{\s*if \(generation !== snapshotGeneration\.current\) return;\s*Alert\.alert\('Não foi possível atualizar'/s);

// Leaving the screen invalidates late publication.
assert.match(screen, /return \(\) => \{\s*snapshotGeneration\.current \+= 1;\s*\};/s);

// Financial reconciliation and explicit AI generation are serialized at the UI boundary,
// avoiding a later passive read being launched while AI persistence is still unresolved.
assert.match(screen, /const snapshotBusy = reconcilingSnapshot \|\| refreshingAI \|\| submittingReserve \|\| submittingGoal;/);
assert.match(screen, /if \(snapshotBusy\) return;\s*const generation = \+\+snapshotGeneration\.current;/s);
assert.match(screen, /if \(submittingReserve \|\| refreshingAI \|\| reconcilingSnapshot \|\| !reserveAmount\) return;/);
assert.match(screen, /if \(submittingGoal \|\| refreshingAI \|\| reconcilingSnapshot \|\| !newGoal\) return;/);
assert.match(screen, /await reserveMutation\.mutate[\s\S]*?await fetchInsights\(\);/);
assert.match(screen, /await api\.patch\('\/settings\/emergency-fund-goal'[\s\S]*?await fetchInsights\(\);/);

// Preserve the privacy boundary: passive reads remain local and only explicit refresh calls AI.
const passive = routes.match(/async def get_insights\(\):[\s\S]*?async def refresh_insights\(\):/);
assert.ok(passive, 'passive Insights route must remain identifiable');
assert.doesNotMatch(passive[0], /generate_financial_insights\(/);
assert.match(routes, /async def refresh_insights\(\):[\s\S]*?generate_financial_insights\([\s\S]*?explicit_user_action=True/s);

// Deterministic model: an older passive result/error cannot regress a newer explicit refresh.
function createPublisher() {
  let generation = 0;
  const state = { insight: null, error: false };
  return {
    begin() {
      const mine = ++generation;
      return {
        success(insight) {
          if (mine !== generation) return;
          state.insight = insight;
          state.error = false;
        },
        fail() {
          if (mine !== generation) return;
          state.error = true;
        },
      };
    },
    state,
  };
}

const staleSuccessRace = createPublisher();
const olderGet = staleSuccessRace.begin();
const newerAi = staleSuccessRace.begin();
newerAi.success('new AI insight');
olderGet.success('old persisted insight');
assert.deepEqual(staleSuccessRace.state, { insight: 'new AI insight', error: false });

const staleErrorRace = createPublisher();
const olderError = staleErrorRace.begin();
const newerAiOk = staleErrorRace.begin();
newerAiOk.success('fresh AI insight');
olderError.fail();
assert.deepEqual(staleErrorRace.state, { insight: 'fresh AI insight', error: false });

console.log('INSIGHTS_REFRESH_GENERATION_CONTRACT=pass');
