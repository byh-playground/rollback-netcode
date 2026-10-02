// Contributor-only repeatable measurement; not a production game budget claim.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSession, profiles } from '../rollback-netcode.js';
const size = Number(process.env.SNAPSHOT_BYTES ?? 131072), steps = 1000;
const state = new Uint8Array(size);
const session = createSession({ players: ['a'], localPlayerId: 'a', sessionId: 'benchmark',
  simulationVersion: 'byte-fixture-v1', inputSize: 1, recordReplay: false,
  profile: { ...profiles.rts, baseInputDelayTicks: 0, adaptiveInputDelay: false, pacingPolicy: 'none' },
  adapter: { save: () => state, load: data => state.set(data), validateSnapshot: data => data.length === size,
    step: () => { state[0] = (state[0] + 1) & 255; } } });
const costs = [];
for (let tick = 0; tick < steps; tick++) {
  const start = performance.now(); session.advance(new Uint8Array([0])); costs.push(performance.now() - start);
}
assert.equal(state[0], steps & 255);
costs.sort((a, b) => a - b);
console.log(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch },
  snapshotBytes: size, retainedSnapshotBytes: size * Math.min(steps + 1, session.profile.stateHistorySize),
  steps, p50Ms: costs[500], p95Ms: costs[950], p99Ms: costs[990], hash: session.getStateHash() }, null, 2));
session.close();
