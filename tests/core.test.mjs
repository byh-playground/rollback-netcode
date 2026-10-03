import assert from 'node:assert/strict';
import test from 'node:test';
import { createSession, playReplay, profiles, VERSION } from '../rollback-netcode.js';

const IDS = ['a', 'b'];
const TICK_RATE = 60;

// This integer simulation deliberately knows nothing about rollback internals.
// Its offline oracle uses the same public input contract, without a Session.
function makeSimulation({ acceptSnapshot = () => true, snapshotPaddingBytes = 0 } = {}) {
  const state = new Int32Array(8);
  const snapshotBytes = state.byteLength + snapshotPaddingBytes;
  const steps = [];
  const adapter = {
    save() {
      const bytes = new Uint8Array(snapshotBytes);
      bytes.set(new Uint8Array(state.buffer));
      bytes.fill(0xa5, state.byteLength);
      return bytes;
    },
    load(bytes) {
      assert.equal(bytes.byteLength, snapshotBytes, 'snapshot shape');
      state.set(new Int32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + state.byteLength)));
    },
    validateSnapshot: (bytes, context) => bytes.byteLength === snapshotBytes && acceptSnapshot(bytes, context),
    step({ tick, tickRate, inputs, resimulating }) {
      assert.equal(tickRate, TICK_RATE, 'network pacing must not alter the simulation rate');
      assert.equal(tick, state[4], 'S[t] must be loaded before stepping inputs[t]');
      assert.deepEqual(inputs.map(frame => frame.playerId), IDS, 'player order must be stable');
      for (let index = 0; index < inputs.length; index++) {
        const frame = inputs[index];
        const value = frame.input[0];
        state[index] += (value & 1 ? 2 : 0) - (value & 2 ? 1 : 0);
        state[index + 2] += (value & 4 ? 3 : 0) - (value & 8 ? 2 : 0);
        for (const command of frame.commands) {
          assert.equal(command.executeTick, tick, 'commands execute at their committed tick');
          state[5]++;
          state[6] += command.payload[0] + index * 100;
          state[7] = (Math.imul(state[7], 31) + command.sequence + command.payload[0]) | 0;
        }
      }
      state[4]++;
      steps.push({ tick, resimulating, inputs: inputs.map(frame => ({
        playerId: frame.playerId,
        predicted: frame.predicted,
        input: [...frame.input],
        commands: frame.commands.map(command => ({ ...command, payload: [...command.payload] })),
      })) });
    },
  };
  return { adapter, state, steps };
}

function stream(player, tick) {
  // Includes long repeated holds, release edges, and mutually exclusive axes.
  return new Uint8Array([((tick * (player === 'a' ? 7 : 11) + (tick >> 2)) % 15) + 1]);
}

function oracle(ticks, inputForTick = stream, commands = []) {
  const simulation = makeSimulation();
  for (let tick = 0; tick < ticks; tick++) {
    simulation.adapter.step({ tick, tickRate: TICK_RATE, resimulating: false, inputs: IDS.map(playerId => ({
      playerId, input: inputForTick(playerId, tick), predicted: false,
      commands: commands.filter(command => command.playerId === playerId && command.executeTick === tick),
    })) });
  }
  return [...simulation.state];
}

function makePair({ profile = {}, inputForTick = stream, acceptSnapshot, snapshotPaddingBytes = 0, network = {} } = {}) {
  const sims = IDS.map(() => makeSimulation({ acceptSnapshot, snapshotPaddingBytes }));
  const events = [[], []];
  const selectedProfile = {
    ...profiles.action,
    tickRate: TICK_RATE,
    baseInputDelayTicks: 0,
    minInputDelayTicks: 0,
    maxInputDelayTicks: 8,
    adaptiveInputDelay: false,
    pacingPolicy: 'none',
    rollbackWindowTicks: 12,
    stateHistorySize: 32,
    checksumInterval: 8,
    resimulationBudget: 64,
    maxCatchupSteps: 64,
    ...profile,
  };
  let now = 1000;
  const sessions = IDS.map((localPlayerId, index) => createSession({
    players: IDS, localPlayerId, sessionId: 'core-contract', simulationVersion: 'integer-v1',
    seed: 17, inputSize: 1, profile: selectedProfile, adapter: sims[index].adapter,
    onEvent: event => events[index].push(event), clock: () => now,
  }));
  let packetNumber = 0;
  let sendEnabled = true;
  let deliveryEnabled = true;
  const pending = [];
  const subscribers = [new Set(), new Set()];
  const packets = [];
  const link = {
    get now() { return now; },
    get pending() { return pending.length; },
    setSendEnabled(value) { sendEnabled = value; },
    setDeliveryEnabled(value) { deliveryEnabled = value; },
    transport(index) {
      return {
        send(bytes) {
          assert.ok(bytes instanceof Uint8Array, 'transport sends binary packets');
          assert.ok(bytes.byteLength <= 16384, 'wire packets fit a conservative DataChannel message limit');
          if (!sendEnabled || network.block?.({ from: index, bytes })) return false;
          const packet = { from: index, to: 1 - index, bytes: bytes.slice(), number: ++packetNumber, at: now };
          packets.push(packet);
          if (network.drop?.(packet)) return true;
          packet.at += network.delay?.(packet) ?? 0;
          pending.push(packet);
          if (network.duplicate?.(packet)) pending.push({ ...packet, bytes: packet.bytes.slice(), at: packet.at + 1 });
          return true;
        },
        subscribe(callback) {
          subscribers[index].add(callback);
          return () => subscribers[index].delete(callback);
        },
      };
    },
    pump(milliseconds = 20) {
      now += milliseconds;
      sessions.forEach(session => session.poll(now));
      if (!deliveryEnabled) return;
      const ready = pending.filter(packet => packet.at <= now);
      for (let index = pending.length - 1; index >= 0; index--) {
        if (pending[index].at <= now) pending.splice(index, 1);
      }
      if (network.reorder) ready.reverse();
      for (const packet of ready) {
        for (const subscriber of subscribers[packet.to]) subscriber(packet.bytes.slice());
      }
    },
    drain(rounds = 24) { for (let round = 0; round < rounds; round++) this.pump(50); },
    packets,
  };
  const cleanups = sessions.map((session, index) => session.attachTransport(IDS[1 - index], link.transport(index)));
  link.drain(8);
  return {
    sessions, sims, link, events, inputForTick,
    close() { cleanups.forEach(cleanup => cleanup()); sessions.forEach(session => session.close()); },
  };
}

function drive(pair, target, maximumRounds = target * 60 + 200) {
  const { sessions, inputForTick, link } = pair;
  for (let round = 0; round < maximumRounds; round++) {
    for (let index = 0; index < sessions.length; index++) {
      const session = sessions[index];
      if (session.tick < target && !session.resimulating) session.advance(inputForTick(IDS[index], session.tick));
    }
    link.pump();
    if (sessions.every(session => session.tick === target && session.confirmedTick >= target - 1 && !session.resimulating)) {
      link.drain();
      return;
    }
  }
  assert.fail(`did not settle at ${target}: ${JSON.stringify(sessions.map(session => ({ tick: session.tick, confirmedTick: session.confirmedTick, metrics: session.metrics })))}`);
}

function assertConverged(pair, target, expected = oracle(target, pair.inputForTick)) {
  assert.deepEqual([...pair.sims[0].state], expected, 'authority matches the offline oracle');
  assert.deepEqual([...pair.sims[1].state], expected, 'peer matches the offline oracle');
  assert.equal(pair.sessions[0].getStateHash(), pair.sessions[1].getStateHash(), 'peers agree on state hash');
}

test('the dependency-free core has a version and reproduces a deterministic offline simulation', () => {
  assert.equal(typeof VERSION, 'string');
  const pair = makePair();
  try {
    drive(pair, 96);
    assertConverged(pair, 96);
  } finally { pair.close(); }
});

test('action, RTS and lockstep presets share the same public session and adapter contract', () => {
  for (const preset of ['action', 'rts', 'lockstep']) {
    assert.ok(profiles[preset], `${preset} strategy preset is exported`);
    const pair = makePair({ profile: {
      ...profiles[preset], tickRate: TICK_RATE, baseInputDelayTicks: 0, minInputDelayTicks: 0,
      adaptiveInputDelay: false, pacingPolicy: 'none', stateHistorySize: profiles[preset].stateHistorySize,
    } });
    try {
      drive(pair, 32);
      assertConverged(pair, 32);
    } finally { pair.close(); }
  }
});

test('loss, duplication and reordering converge after multiple history-ring wraps', () => {
  const pair = makePair({ network: {
    drop: packet => packet.number % 7 === 0,
    delay: packet => packet.number % 5 * 13,
    duplicate: packet => packet.number % 9 === 0,
    reorder: true,
  } });
  try {
    drive(pair, 180);
    assertConverged(pair, 180);
    assert.ok(pair.sessions.some(session => session.metrics.rollbacks > 0), 'changed predictions require rollback');
    assert.ok(pair.sessions.some(session => session.metrics.resimulatedTicks > 0));
  } finally { pair.close(); }
});

test('matching predictions cause no rollback even when actual input arrives late', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), network: { delay: () => 70 } });
  try {
    drive(pair, 80);
    assertConverged(pair, 80);
    assert.ok(pair.sessions.some(session => session.metrics.predictedTicks > 0));
    assert.equal(pair.sessions[0].metrics.rollbacks + pair.sessions[1].metrics.rollbacks, 0);
  } finally { pair.close(); }
});

test('a deep changed prediction restores S[t] and resimulates across a wrapped history ring', () => {
  const pair = makePair();
  try {
    drive(pair, 40);
    pair.link.setDeliveryEnabled(false);
    for (let round = 0; round < 7; round++) {
      pair.sessions.forEach((session, index) => session.advance(stream(IDS[index], session.tick)));
      pair.link.pump();
    }
    assert.equal(pair.sessions[0].tick, 47);
    pair.link.setDeliveryEnabled(true);
    pair.link.drain();
    drive(pair, 90);
    assertConverged(pair, 90);
    assert.ok(pair.sessions.some(session => session.metrics.maxRollbackDepth >= 5));
  } finally { pair.close(); }
});

test('partial resimulation consumes a bounded budget and does not add a logical tick', () => {
  const pair = makePair({ profile: { resimulationBudget: 2 } });
  try {
    drive(pair, 40);
    pair.link.setDeliveryEnabled(false);
    for (let round = 0; round < 7; round++) {
      pair.sessions.forEach((session, index) => session.advance(stream(IDS[index], session.tick)));
      pair.link.pump();
    }
    pair.link.setDeliveryEnabled(true);
    pair.link.pump();
    assert.ok(pair.sessions[0].resimulating);
    const beforeAdvance = pair.sims[0].steps.length;
    const result = pair.sessions[0].advance(stream('a', 47));
    assert.equal(result.status, 'resimulating');
    assert.ok(pair.sims[0].steps.length - beforeAdvance <= 2, 'one advance cannot exceed the two-tick resimulation budget');
    let sawPartial = false;
    for (let round = 0; round < 8 && pair.sessions[0].resimulating; round++) {
      const before = pair.sims[0].steps.length;
      pair.sessions[0].poll(pair.link.now);
      assert.ok(pair.sims[0].steps.length - before <= 2, 'one poll cannot exceed the two-tick resimulation budget');
      sawPartial ||= pair.sessions[0].resimulating;
      assert.ok(pair.sessions[0].tick <= 47, 'reconciliation cannot advance beyond its original target');
    }
    assert.ok(sawPartial, 'deep rollback needs more than one bounded update');
    assert.equal(pair.sessions[0].tick, 47);
    drive(pair, 90);
    assertConverged(pair, 90);
  } finally { pair.close(); }
});

test('the rollback window bounds speculation and strict lockstep advances only with real input', () => {
  for (const window of [0, 5]) {
    const pair = makePair({ profile: { rollbackWindowTicks: window, stateHistorySize: 16 } });
    try {
      pair.link.setDeliveryEnabled(false);
      const results = Array.from({ length: 30 }, () => pair.sessions[0].advance(new Uint8Array([1])));
      assert.ok(results.some(result => result.status === 'stalled'), 'missing peer input eventually stalls');
      assert.ok(pair.sessions[0].tick <= window, `must not speculate past ${window} ticks`);
      if (window === 0) assert.equal(pair.sessions[0].tick, 0);
      const stoppedTick = pair.sessions[0].tick;
      for (let attempt = 0; attempt < 10; attempt++) pair.sessions[0].advance(new Uint8Array([2]));
      assert.equal(pair.sessions[0].tick, stoppedTick);
    } finally { pair.close(); }
  }
});

test('decreasing delay preserves a queued one-shot command exactly once on both peers', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]) });
  try {
    pair.sessions[0].setInputDelay(4);
    const sequence = pair.sessions[0].queueCommand(new Uint8Array([17]));
    pair.sessions[0].advance(new Uint8Array([0]));
    pair.sessions[0].setInputDelay(0);
    drive(pair, 32);
    const actualCommands = pair.sims[0].steps.filter(step => !step.resimulating).flatMap(step =>
      step.inputs.flatMap(frame => frame.commands.map(command => ({ ...command, playerId: frame.playerId }))));
    const command = actualCommands.find(item => item.sequence === sequence && item.playerId === 'a');
    assert.ok(command, 'one-shot command executes after delay changes');
    assertConverged(pair, 32, oracle(32, pair.inputForTick, [{ ...command, payload: new Uint8Array(command.payload) }]));
    assert.equal(pair.sims[0].state[5], 1);
    assert.equal(pair.sims[1].state[5], 1);
  } finally { pair.close(); }
});

test('input delay respects explicit bounds', () => {
  const pair = makePair({ profile: { minInputDelayTicks: 1, maxInputDelayTicks: 4, baseInputDelayTicks: 2 } });
  try {
    for (const requested of [-100, 0, 1, 3, 100]) {
      try { pair.sessions[0].setInputDelay(requested); } catch (error) { assert.ok(error instanceof Error); }
      assert.ok(pair.sessions[0].inputDelay >= 1 && pair.sessions[0].inputDelay <= 4);
    }
  } finally { pair.close(); }
});

test('adaptive delay reacts to measured network latency while staying within configured bounds', () => {
  const pair = makePair({
    inputForTick: () => new Uint8Array([0]),
    profile: { adaptiveInputDelay: true, adaptationIntervalMs: 100, maxInputDelayTicks: 4 },
    network: { delay: () => 140 },
  });
  try {
    let raised = false;
    for (let round = 0; round < 2400; round++) {
      pair.sessions.forEach(session => {
        if (session.tick < 80) session.advance(new Uint8Array([0]));
        assert.ok(session.inputDelay >= 0 && session.inputDelay <= 4);
        raised ||= session.inputDelay > 0;
      });
      pair.link.pump();
      if (pair.sessions.every(session => session.tick === 80 && session.confirmedTick >= 79 && !session.resimulating)) break;
    }
    pair.link.drain();
    assert.equal(pair.sessions[0].tick, 80);
    assert.equal(pair.sessions[1].tick, 80);
    assert.ok(raised, `network measurements increase delay from the zero-delay baseline: ${JSON.stringify(pair.sessions.map(session => session.metrics))}`);
    assertConverged(pair, 80);
  } finally { pair.close(); }
});

test('an ahead peer holds its tick while keeping every simulation step at the configured rate', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), profile: { pacingPolicy: 'hold', tickDriftThreshold: 1 } });
  try {
    let held = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const before = pair.sessions[0].tick;
      const result = pair.sessions[0].advance(new Uint8Array([0]));
      if (result.status === 'held') {
        held = true;
        assert.equal(pair.sessions[0].tick, before, 'a pacing hold cannot change simulation tick');
      }
    }
    assert.ok(held, 'an ahead peer eventually yields while its peer is stationary');
    assert.ok(pair.sessions[0].metrics.holds > 0);
    assert.ok(pair.sessions[0].tick <= 3);
    assert.equal(pair.sims[0].state[4], pair.sessions[0].tick);
  } finally { pair.close(); }
});

for (const pacingPolicy of ['hold', 'dilation']) {
  test(`${pacingPolicy} pacing bounds long-running drift when the faster and slower peers exchange roles`, () => {
    const pair = makePair({
      inputForTick: () => new Uint8Array([0]),
      profile: { pacingPolicy, tickDriftThreshold: 2, adaptationIntervalMs: 100 },
      network: { delay: () => 20 },
    });
    try {
      let maxLead = 0;
      let shortened = false;
      let lengthened = false;
      for (let round = 0; round < 4000; round++) {
        for (let index = 0; index < pair.sessions.length; index++) {
          const session = pair.sessions[index];
          const fast = round < 250 ? index === 0 : index === 1;
          for (let work = 0; work < (fast ? 2 : 1) && session.tick < 400; work++) session.advance(new Uint8Array([0]));
          assert.ok(session.metrics.pace >= .98 && session.metrics.pace <= 1.05, 'micro-dilation stays in its bounded range');
          shortened ||= session.metrics.pace < .999;
          lengthened ||= session.metrics.pace > 1.001;
        }
        pair.link.pump(1000 / TICK_RATE);
        maxLead = Math.max(maxLead, Math.abs(pair.sessions[0].tick - pair.sessions[1].tick));
        if (pair.sessions.every(session => session.tick === 400 && session.confirmedTick >= 399 && !session.resimulating)) break;
      }
      pair.link.drain();
      assert.equal(pair.sessions[0].tick, 400);
      assert.equal(pair.sessions[1].tick, 400);
      assert.ok(maxLead <= (pacingPolicy === 'hold' ? 8 : 12), `tick drift remained bounded: ${maxLead}`);
      assert.ok(pair.sessions.some(session => session.metrics.holds > 0));
      if (pacingPolicy === 'dilation') {
        assert.ok(shortened, 'a behind peer shortens wall-clock intervals');
        assert.ok(lengthened, 'an ahead peer lengthens wall-clock intervals');
      }
      assertConverged(pair, 400);
    } finally { pair.close(); }
  });
}

test('releaseInput commits neutral input after a held input without requiring a new buffer', () => {
  const inputForTick = (player, tick) => new Uint8Array([player === 'a' && tick < 2 ? 1 : 0]);
  const pair = makePair({ inputForTick });
  try {
    pair.sessions[0].advance(new Uint8Array([1]));
    pair.sessions[0].advance();
    pair.sessions[0].releaseInput();
    pair.sessions[0].advance();
    drive(pair, 16);
    assertConverged(pair, 16);
  } finally { pair.close(); }
});

test('ten thousand releaseInput calls at a frozen tick do not extend the committed future', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([1]) });
  try {
    drive(pair, 1);
    const original = pair.sims.map(sim => [...sim.state]);
    for (let attempt = 0; attempt < 10000; attempt++) pair.sessions.forEach(session => session.releaseInput());
    pair.link.drain();
    pair.sessions.forEach((session, index) => {
      assert.equal(session.tick, 1);
      assert.equal(session.confirmedTick, 1, 'only the next neutral frame may be committed at a frozen tick');
      assert.deepEqual([...pair.sims[index].state], original[index]);
    });
  } finally { pair.close(); }
});

test('queued command payloads are captured before caller-owned buffers can change', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]) });
  try {
    const payload = new Uint8Array([17]);
    const sequence = pair.sessions[0].queueCommand(payload);
    payload[0] = 99;
    drive(pair, 16);
    const commands = pair.sims[0].steps.flatMap(step => step.inputs.flatMap(frame => frame.commands));
    const command = commands.find(item => item.sequence === sequence);
    assert.ok(command);
    assert.deepEqual(command.payload, [17], 'queued payload must not alias caller memory');
    assertConverged(pair, 16, oracle(16, pair.inputForTick, [{ ...command, playerId: 'a', payload: new Uint8Array([17]) }]));
  } finally { pair.close(); }
});

test('malformed and oversized incoming packets leave simulation state unchanged', () => {
  const pair = makePair();
  try {
    drive(pair, 16);
    const original = [...pair.sims[1].state];
    const originalTick = pair.sessions[1].tick;
    const rejectedBefore = pair.sessions[1].metrics.rejectedPackets;
    for (const packet of [new Uint8Array(), new Uint8Array([255, 0, 17]), new Uint8Array(16385), new Uint8Array(16384).fill(42)]) {
      assert.doesNotThrow(() => pair.sessions[1].receive('a', packet, pair.link.now));
    }
    assert.deepEqual([...pair.sims[1].state], original);
    assert.equal(pair.sessions[1].tick, originalTick);
    assert.ok(pair.sessions[1].metrics.rejectedPackets > rejectedBefore);
  } finally { pair.close(); }
});

test('transport backpressure resumes with retransmission and preserves committed input', () => {
  const pair = makePair();
  try {
    drive(pair, 16);
    pair.link.setSendEnabled(false);
    for (let round = 0; round < 8; round++) {
      pair.sessions.forEach((session, index) => session.advance(stream(IDS[index], session.tick)));
      pair.link.pump();
    }
    pair.link.setSendEnabled(true);
    drive(pair, 100);
    assertConverged(pair, 100);
  } finally { pair.close(); }
});

test('a full one-checksum control queue cannot make advance or poll fail', () => {
  let blockHash = true;
  const pair = makePair({ profile: { maxQueuedBytes: 24, checksumInterval: 1 },
    network: { block: ({ bytes }) => blockHash && bytes[5] === 4 } });
  try {
    assert.doesNotThrow(() => drive(pair, 96));
    assert.doesNotThrow(() => pair.link.drain(40));
    assertConverged(pair, 96);
    assert.ok(pair.events.every(events => events.every(event => event.type !== 'fatal')));
    blockHash = false;
    assert.doesNotThrow(() => pair.link.drain(20));
    assertConverged(pair, 96);
  } finally { pair.close(); }
});

test('recovery queue admission failures do not consume the only allowed recovery attempt', () => {
  let blockHash = true;
  const pair = makePair({ profile: { maxQueuedBytes: 24, checksumInterval: 1, maxRecoveryAttempts: 1 },
    network: { block: ({ bytes }) => blockHash && bytes[5] === 4 } });
  try {
    drive(pair, 8);
    for (let attempt = 0; attempt < 50; attempt++) {
      assert.equal(pair.sessions[1].requestResync(8), false, 'the queued checksum fills the control byte budget');
    }
    blockHash = false;
    pair.link.drain(20);
    assert.equal(pair.sessions[1].requestResync(8), true, 'an attempt is available once queue admission succeeds');
    assertConverged(pair, 8);
  } finally { pair.close(); }
});

test('four successive successful repairs reset the recovery attempt limit each time', () => {
  const pair = makePair({ profile: { maxRecoveryAttempts: 1 } });
  try {
    drive(pair, 20);
    for (let recovery = 0; recovery < 4; recovery++) {
      pair.sims[1].state[0] += 99 + recovery;
      assert.equal(pair.sessions[1].requestResync(20), true, `recovery ${recovery + 1} can be admitted`);
      pair.link.drain(20);
      assert.equal(pair.sessions[1].metrics.recoveries, recovery + 1);
      assertConverged(pair, 20);
    }
  } finally { pair.close(); }
});

test('snapshot validation is a required simulation adapter capability', () => {
  const simulation = makeSimulation();
  const { validateSnapshot, ...adapter } = simulation.adapter;
  assert.equal(typeof validateSnapshot, 'function');
  assert.throws(() => createSession({ players: IDS, localPlayerId: 'a', sessionId: 'required-validator',
    simulationVersion: 'integer-v1', inputSize: 1, adapter }), /validateSnapshot/);
  assert.deepEqual([...simulation.state], Array(8).fill(0));
});

test('logical tick and input delay are read-only public values', () => {
  const pair = makePair();
  try {
    assert.throws(() => { pair.sessions[0].tick = 123; }, TypeError);
    assert.throws(() => { pair.sessions[0].inputDelay = 123; }, TypeError);
    assert.equal(pair.sessions[0].tick, 0);
    assert.equal(pair.sessions[0].inputDelay, 0);
    pair.sessions[0].setInputDelay(2);
    assert.equal(pair.sessions[0].inputDelay, 2, 'delay changes use the validated public method');
  } finally { pair.close(); }
});

test('confirmed checksum divergence repairs a peer from the deterministic authority', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), profile: { checksumInterval: 4 } });
  try {
    drive(pair, 20);
    pair.sims[1].state[0] += 1000;
    drive(pair, 64);
    assertConverged(pair, 64);
    assert.ok(pair.sessions[1].metrics.recoveries > 0, 'the corrupted nonauthority peer is repaired');
  } finally { pair.close(); }
});

test('a rejected recovery candidate preserves the receiver state and tick', () => {
  let accept = true;
  const pair = makePair({ acceptSnapshot: () => accept });
  try {
    drive(pair, 20);
    pair.sims[1].state[0] += 99;
    const original = [...pair.sims[1].state];
    const tick = pair.sessions[1].tick;
    accept = false;
    pair.sessions[1].requestResync(tick);
    pair.link.drain(60);
    assert.ok(pair.sessions[1].metrics.rejectedSnapshots > 0, 'adapter validation rejected a real authority candidate');
    assert.deepEqual([...pair.sims[1].state], original);
    assert.equal(pair.sessions[1].tick, tick);
  } finally { pair.close(); }
});

test('a large authority snapshot is chunked below the wire limit and committed atomically', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), snapshotPaddingBytes: 65504,
    profile: { maxSnapshotBytes: 65536 } });
  try {
    drive(pair, 20);
    pair.sims[1].state[0] += 99;
    const packetsBefore = pair.link.packets.length;
    assert.equal(pair.sessions[1].requestResync(20), true);
    pair.link.drain(40);
    assertConverged(pair, 20);
    assert.equal(pair.sessions[1].metrics.recoveries, 1);
    const recoveryPackets = pair.link.packets.slice(packetsBefore);
    assert.ok(recoveryPackets.filter(packet => packet.bytes.length > 16000).length >= 3, 'large state uses multiple binary chunks');
    assert.ok(recoveryPackets.every(packet => packet.bytes.length <= 16384));
  } finally { pair.close(); }
});

test('a budget-one staged snapshot retains the present state until its complete replay commits', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), profile: { resimulationBudget: 1 } });
  try {
    drive(pair, 10);
    pair.sims[1].state[0] += 99;
    const original = [...pair.sims[1].state];
    const hashes = Array.from({ length: 11 }, (_, tick) => pair.sessions[1].getStateHash(tick));
    assert.equal(pair.sessions[1].requestResync(0), true);
    let stagedUpdates = 0;
    for (let round = 0; round < 40 && pair.sessions[1].metrics.recoveries === 0; round++) {
      const before = pair.sims[1].steps.length;
      pair.link.pump();
      assert.ok(pair.sims[1].steps.length - before <= 1, 'staged recovery honors its per-poll budget');
      assert.equal(pair.sessions[1].tick, 10);
      if (pair.sessions[1].metrics.recoveries === 0) {
        assert.deepEqual([...pair.sims[1].state], original, 'an incomplete candidate remains invisible to gameplay');
        assert.deepEqual(Array.from({ length: 11 }, (_, tick) => pair.sessions[1].getStateHash(tick)), hashes);
        if (pair.sessions[1].resimulating) stagedUpdates++;
      }
    }
    assert.ok(stagedUpdates >= 5, 'the ten-tick recovery is staged over multiple updates');
    assert.equal(pair.sessions[1].metrics.recoveries, 1);
    assertConverged(pair, 10);
  } finally { pair.close(); }
});

test('an adapter throw during candidate replay restores present state and preserves the old hash ring', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), profile: { resimulationBudget: 1 } });
  try {
    drive(pair, 10);
    pair.sims[1].state[0] += 99;
    const original = [...pair.sims[1].state];
    const hashes = Array.from({ length: 11 }, (_, tick) => pair.sessions[1].getStateHash(tick));
    const originalStep = pair.sims[1].adapter.step;
    pair.sims[1].adapter.step = frame => {
      originalStep(frame);
      if (frame.recovering && frame.tick === 4) throw new Error('deliberate candidate-only step failure');
    };
    assert.equal(pair.sessions[1].requestResync(0), true);
    pair.link.drain(30);
    assert.equal(pair.sessions[1].metrics.rejectedSnapshots, 1);
    assert.equal(pair.sessions[1].metrics.recoveries, 0);
    assert.equal(pair.sessions[1].tick, 10);
    assert.equal(pair.sessions[1].resimulating, false);
    assert.deepEqual([...pair.sims[1].state], original);
    assert.deepEqual(Array.from({ length: 11 }, (_, tick) => pair.sessions[1].getStateHash(tick)), hashes);
  } finally { pair.close(); }
});

test('duplicate transport packets do not abort a large staged snapshot recovery', () => {
  const pair = makePair({ inputForTick: () => new Uint8Array([0]), snapshotPaddingBytes: 65504,
    profile: { resimulationBudget: 1 }, network: { duplicate: () => true } });
  try {
    drive(pair, 10);
    pair.sims[1].state[0] += 99;
    assert.equal(pair.sessions[1].requestResync(0), true);
    pair.link.drain(50);
    assert.equal(pair.sessions[1].metrics.recoveries, 1, JSON.stringify({ metrics: pair.sessions[1].metrics, events: pair.events[1] }));
    assert.equal(pair.sessions[1].metrics.rejectedSnapshots, 0);
    assertConverged(pair, 10);
  } finally { pair.close(); }
});

test('state history byte-budget exhaustion leaves the game state and logical tick unchanged', () => {
  assert.throws(()=>makePair({profile:{maxHistoryBytes:64}}),error=>error.code==='history-capacity'&&error.requiredBytes===1024);
  let tick=0,size=4;
  const adapter={save(){const b=new Uint8Array(size);new DataView(b.buffer).setUint32(0,tick,true);return b},
    load(b){size=b.length;tick=new DataView(b.buffer,b.byteOffset,b.byteLength).getUint32(0,true)},validateSnapshot:b=>b.length>=4,
    step(){tick++;size=40}};
  const session=createSession({players:['a'],localPlayerId:'a',sessionId:'growing',simulationVersion:'1',inputSize:1,adapter,
    profile:{...profiles.lockstep,baseInputDelayTicks:0,stateHistorySize:4,maxHistoryBytes:64,adaptiveInputDelay:false}});
  session.advance(new Uint8Array(1));const originalHash=session.getStateHash();
  assert.throws(()=>session.advance(new Uint8Array(1)),error=>error.code==='history-capacity');
  assert.equal(tick,1);assert.equal(session.tick,1);assert.equal(session.status,'failed');
  assert.equal(session.getStateHash(),originalHash);assert.equal(session.getStateHash(2),undefined);session.close();
});

test('a capped replay retains its final hash after its last recorded state leaves the ring', () => {
  const pair = makePair({ profile: { maxReplayBytes: 120 } });
  try {
    drive(pair, 180);
    assertConverged(pair, 180);
    const replay = pair.sessions[0].exportReplay();
    assert.ok(replay.tick > 0 && replay.tick < 180 - 32, 'recording stopped well before the retained state history');
    assert.equal(pair.sessions[0].getStateHash(replay.tick), undefined);
    assert.equal(typeof replay.hash, 'number');
    const replaySimulation = makeSimulation();
    const result = playReplay({ adapter: replaySimulation.adapter, replay });
    assert.equal(result.hash, replay.hash);
    assert.deepEqual([...replaySimulation.state], oracle(replay.tick));
  } finally { pair.close(); }
});

test('adapter mutations of delivered inputs and commands cannot change immutable committed frames', () => {
  const pair = makePair();
  try {
    for (const simulation of pair.sims) {
      const originalStep = simulation.adapter.step;
      simulation.adapter.step = frame => {
        originalStep(frame);
        for (const inputFrame of frame.inputs) {
          inputFrame.input.fill(255);
          for (const command of inputFrame.commands) command.payload.fill(99);
          inputFrame.commands.length = 0;
        }
      };
    }
    const sequence = pair.sessions[0].queueCommand(new Uint8Array([17]));
    drive(pair, 80);
    assertConverged(pair, 80, oracle(80, stream, [{ playerId: 'a', sequence, executeTick: 0, payload: new Uint8Array([17]) }]));
    const replaySimulation = makeSimulation();
    const result = playReplay({ adapter: replaySimulation.adapter, replay: pair.sessions[0].exportReplay() });
    assert.equal(result.hash, pair.sessions[0].getStateHash());
    assert.deepEqual([...replaySimulation.state], [...pair.sims[0].state]);
  } finally { pair.close(); }
});

test('exported replay uses the same core and matches the online result and oracle', () => {
  const pair = makePair();
  try {
    drive(pair, 72);
    assertConverged(pair, 72);
    const replaySimulation = makeSimulation();
    const result = playReplay({ adapter: replaySimulation.adapter, replay: structuredClone(pair.sessions[0].exportReplay()) });
    assert.equal(result.tick, 72);
    assert.equal(result.hash, pair.sessions[0].getStateHash());
    assert.deepEqual([...replaySimulation.state], oracle(72));
  } finally { pair.close(); }
});


test('synctest frame export clones only a bounded confirmed prefix and excludes predicted inputs',()=>{
  const pair=makePair();try{
    const sequence=pair.sessions[0].queueCommand(new Uint8Array([17]));drive(pair,180);assertConverged(pair,180,oracle(180,stream,[{playerId:'a',sequence,executeTick:0,payload:new Uint8Array([17])}]));
    const session=pair.sessions[0],sample=session.exportSyncTestFrames({maxFrames:2});
    assert.equal(sample.initialTick,0);assert.deepEqual(sample.players,IDS);assert.equal(sample.frames.length,2);
    assert.ok(sample.frames.every(frame=>frame.inputs.every(input=>!input.predicted)));
    const snapshot=sample.initialState.slice(),first=sample.frames[0].inputs[0].input.slice();
    sample.initialState.fill(99);sample.players.reverse();sample.frames[0].inputs[0].input.fill(99);
    const commands=sample.frames[0].inputs[0].commands;if(commands.length)commands[0].payload.fill(99);
    const fresh=session.exportSyncTestFrames({maxFrames:2});assert.deepEqual(fresh.initialState,snapshot);assert.deepEqual(fresh.players,IDS);
    assert.deepEqual(fresh.frames[0].inputs[0].input,first);assert.equal(fresh.frames[0].inputs[0].commands[0].payload[0],17);
    const untouched=session._replayFrames[2];Object.defineProperty(untouched,'inputs',{get(){throw Error('copied unselected frame')}});
    assert.equal(session.exportSyncTestFrames({maxFrames:2}).frames.length,2);
    for(const maxFrames of [0,257,1.5])assert.throws(()=>session.exportSyncTestFrames({maxFrames}),/maxFrames/);
    session._rollbackFrom=0;assert.throws(()=>session.exportSyncTestFrames(),/finish rollback/);session._rollbackFrom=Infinity;
  }finally{pair.close()}
});
test('synctest frame export never fabricates missing frames after replay recording stops',()=>{
  const pair=makePair({profile:{maxReplayBytes:120}});try{
    drive(pair,180);assertConverged(pair,180);const session=pair.sessions[0],replay=session.exportReplay(),sample=session.exportSyncTestFrames({maxFrames:256});
    assert.equal(replay.truncated,true);assert.ok(sample.frames.length<180);assert.equal(sample.frames.length,replay.frames.length);
    assert.deepEqual(sample.frames,replay.frames);
  }finally{pair.close()}
});
