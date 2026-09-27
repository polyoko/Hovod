// Self-check for the ingest watch-time clamp (no test framework in Hovod yet).
// Run: npm run build -w @hovod/api && node apps/api/scripts/check-watch-time.mjs
import assert from 'node:assert/strict';
import { computeWatchIncrements, watchKey } from '../dist/services/watch-time.js';

const ev = (playedMs, sessionId = 's1') => ({ sessionId, assetId: 'a1', playedMs });
const prior = (maxPlayedMs, idleMs) => new Map([[watchKey('s1', 'a1'), { maxPlayedMs, idleMs }]]);

// New session: increments are the deltas of the cumulative clock.
assert.deepEqual(computeWatchIncrements([ev(0), ev(10_000), ev(20_000)], new Map()), [0, 10_000, 10_000]);
// Events without playedMs (older players) store nothing.
assert.deepEqual(computeWatchIncrements([ev(undefined)], new Map()), [null]);
// Continues from the stored max; a lost batch is recovered by the next value.
assert.deepEqual(computeWatchIncrements([ev(50_000)], prior(20_000, 40_000)), [30_000]);
// Duplicates and out-of-order values add nothing.
assert.deepEqual(computeWatchIncrements([ev(20_000), ev(15_000)], prior(20_000, 5_000)), [0, 0]);
// Forged value: capped at elapsed time since the last stored event plus 60s slack.
assert.deepEqual(computeWatchIncrements([ev(2_000_000_000)], prior(0, 30_000)), [90_000]);
// First request of a session gets only the slack, shared across the batch.
assert.deepEqual(computeWatchIncrements([ev(40_000), ev(100_000)], new Map()), [40_000, 20_000]);
// Sessions are budgeted independently.
assert.deepEqual(computeWatchIncrements([ev(30_000, 's1'), ev(30_000, 's2')], new Map()), [30_000, 30_000]);

console.log('watch-time checks passed');
