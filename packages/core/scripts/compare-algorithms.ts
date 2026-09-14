// Empirical comparison of the five rate-limit algorithms in
// ../src/ratelimit/algorithms, run with simulated (not wall-clock) time so
// the whole thing finishes instantly instead of taking minutes of real
// sleeps. Calls each algorithm function directly with an injected `now`,
// bypassing the memory/Redis stores entirely.
//
// Run: npx tsx scripts/compare-algorithms.ts
// See README.md § Algorithm comparison for the write-up this produces.
import { fixedWindow } from '../src/ratelimit/algorithms/fixedWindow.js';
import { tokenBucket } from '../src/ratelimit/algorithms/tokenBucket.js';
import { leakyBucket } from '../src/ratelimit/algorithms/leakyBucket.js';
import { slidingWindowLog } from '../src/ratelimit/algorithms/slidingWindowLog.js';
import { slidingWindowCounter } from '../src/ratelimit/algorithms/slidingWindowCounter.js';
import type { Algorithm } from '../src/ratelimit/algorithms/types.js';
import type { Policy } from '../src/ratelimit/stores/Store.js';

const algorithms: Record<string, Algorithm<unknown>> = {
  fixedWindow: fixedWindow as Algorithm<unknown>,
  tokenBucket: tokenBucket as Algorithm<unknown>,
  leakyBucket: leakyBucket as Algorithm<unknown>,
  slidingWindowLog: slidingWindowLog as Algorithm<unknown>,
  slidingWindowCounter: slidingWindowCounter as Algorithm<unknown>,
};

const POLICY: Policy = { limit: 10, windowMs: 1000, burst: 10 };

function run(algorithm: Algorithm<unknown>, timestamps: number[]): { allowed: number; denied: number } {
  let state: unknown;
  let allowed = 0;
  let denied = 0;
  for (const now of timestamps) {
    const out = algorithm(state, POLICY, now, 1);
    state = out.state;
    if (out.result.allowed) allowed++;
    else denied++;
  }
  return { allowed, denied };
}

// Scenario 1: 30 requests fired at the exact same instant — how much of an
// instantaneous burst does each algorithm absorb?
const instantBurst = Array.from({ length: 30 }, () => 0);

// Scenario 2: the classic fixed-window boundary flaw — limit-many requests
// just before a window boundary, then limit-many more just after it. A
// window-unaware algorithm lets through ~2x the limit within a few ms.
const boundaryBurst = [
  ...Array.from({ length: 10 }, (_, i) => 990 + i), // 990..999, still window [0,1000)
  ...Array.from({ length: 10 }, (_, i) => 1000 + i), // 1000..1009, window [1000,2000)
];

// Scenario 3: exactly at the allowed rate (10 req/s) for 5 simulated
// seconds, evenly spaced — every correct algorithm should allow all of it.
const exactRate = Array.from({ length: 50 }, (_, i) => i * 100);

// Scenario 4: 25% over the allowed rate (12.5 req/s, one request every 80ms)
// for 5 simulated seconds — measures how tightly each algorithm converges
// to the configured limit under sustained overload.
const overRate = Array.from({ length: 63 }, (_, i) => i * 80);

function printScenario(title: string, timestamps: number[]): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  for (const [name, algorithm] of Object.entries(algorithms)) {
    const { allowed, denied } = run(algorithm, timestamps);
    console.log(`  ${name.padEnd(22)} allowed=${allowed}  denied=${denied}`);
  }
}

printScenario(`Scenario 1: instant burst of ${instantBurst.length} requests at t=0`, instantBurst);
printScenario('Scenario 2: 10 reqs at t=990-999 + 10 reqs at t=1000-1009 (window boundary)', boundaryBurst);
printScenario('Scenario 3: exactly 10 req/s for 5s (50 requests, evenly spaced)', exactRate);
printScenario('Scenario 4: 12.5 req/s for ~5s (63 requests, 25% over the 10 req/s limit)', overRate);
