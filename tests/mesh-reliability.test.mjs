import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, playReplay, profiles } from '../rollback-netcode.js';

const target = 120, commandTicks = [10, 40, 75];
const input = (player, tick) => new Uint8Array([(tick * 3 + player + 1) % 13]);

function simulation(players) {
  // Counts belong to rollback state: resimulation may legitimately repeat step.
  const state = new Uint32Array(2 + players.length * 2);
  return { state, adapter: {
    save() {
      const bytes = new Uint8Array(state.byteLength), view = new DataView(bytes.buffer);
      state.forEach((value, index) => view.setUint32(index * 4, value, true));
      return bytes;
    },
    load(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      state.forEach((_, index) => { state[index] = view.getUint32(index * 4, true); });
    },
    validateSnapshot: (bytes, { tick }) => bytes.byteLength === state.byteLength &&
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === tick,
    step({ tick, inputs, tickRate }) {
      assert.equal(tick, state[0]); assert.equal(tickRate, 60);
      assert.deepEqual(inputs.map(frame => frame.playerId), players);
      inputs.forEach((frame, player) => {
        state[2 + player * 2] += frame.input[0];
        state[1] = Math.imul(state[1], 31) + frame.input[0] + player;
        let previous = 0;
        for (const command of frame.commands) {
          assert.equal(command.executeTick, tick);
          assert.ok(command.sequence > previous, 'commands have stable sequence order');
          previous = command.sequence;
          state[3 + player * 2]++;
          state[1] = Math.imul(state[1], 31) + command.payload[0] + command.sequence;
        }
      });
      state[0]++;
    },
  } };
}

for (const count of [2, 3, 4, 8]) test(`${count}-player mesh converges and replays under delay, loss, duplication and reordering`, () => {
  const players = Array.from({ length: count }, (_, index) => String.fromCharCode(97 + index));
  const delays = players.map((_, index) => [0, 4, 8][index % 3]);
  const sims = players.map(() => simulation(players));
  const listeners = new Map(), queue = [], sentCommands = players.map(() => new Set());
  const stats = { dropped: 0, duplicated: 0, reordered: 0 }, lastDelivered = new Map();
  let now = 1000, number = 0;
  const sessions = players.map((localPlayerId, index) => createSession({
    players: [...players].reverse(), localPlayerId, sessionId: `mesh-${count}`, simulationVersion: 'mesh-v2',
    inputSize: 1, clock: () => now, adapter: sims[index].adapter,
    profile: { ...profiles.action, baseInputDelayTicks: delays[index], maxInputDelayTicks: [1, 4, 12][index % 3],
      adaptiveInputDelay: false, pacingPolicy: 'none', stateHistorySize: 32, checksumInterval: 8 },
  }));
  for (let from = 0; from < count; from++) for (let to = 0; to < count; to++) if (from !== to) {
    const key = `${to}/${from}`;
    let linkNumber = 0;
    sessions[from].attachTransport(players[to], {
      send(bytes) {
        const sequence = ++linkNumber;
        if (sequence % 11 === 0) { stats.dropped++; return true; }
        const packet = { key, sequence, number: ++number, data: bytes.slice(),
          at: now + 10 + ((sequence * 29 + from * 17 + to * 13) % 90) };
        queue.push(packet);
        if (sequence % 7 === 0) {
          stats.duplicated++;
          queue.push({ ...packet, data: bytes.slice(), at: packet.at + 25 });
        }
        return true;
      },
      subscribe(fn) { listeners.set(`${from}/${to}`, fn); return () => listeners.delete(`${from}/${to}`); },
    });
  }
  function pump() {
    now += 20;
    sessions.forEach(session => session.poll(now));
    const ready = queue.filter(packet => packet.at <= now).sort((a, b) => b.number - a.number);
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index].at <= now) queue.splice(index, 1);
    for (const packet of ready) {
      if (packet.sequence < (lastDelivered.get(packet.key) ?? 0)) stats.reordered++;
      lastDelivered.set(packet.key, Math.max(packet.sequence, lastDelivered.get(packet.key) ?? 0));
      listeners.get(packet.key)?.(packet.data);
    }
  }
  try {
    for (let round = 0; round < target * 30; round++) {
      sessions.forEach((session, player) => {
        if (session.tick >= target) return;
        const tick = session.tick;
        if (commandTicks.includes(tick) && !sentCommands[player].has(tick)) {
          sentCommands[player].add(tick);
          for (let item = 0; item < 2; item++) {
            const sequence = session.queueCommand(new Uint8Array([player * 10 + item + 1]));
            assert.equal(sequence, commandTicks.indexOf(tick) * 2 + item + 1);
          }
        }
        session.advance(input(player, tick));
      });
      pump();
      if (sessions.every(session => session.tick === target && session.confirmedTick >= target - 1 && !session.resimulating)) break;
    }
    // Independent oracle uses the sampled stream and delay policy, not replay data.
    const expected = new Uint32Array(2 + count * 2);
    expected[0] = target;
    for (let tick = 0; tick < target; tick++) for (let player = 0; player < count; player++) {
      const sourceTick = tick - delays[player];
      const value = sourceTick < 0 ? 0 : input(player, sourceTick)[0];
      expected[2 + player * 2] += value;
      expected[1] = Math.imul(expected[1], 31) + value + player;
      if (commandTicks.includes(sourceTick)) for (let item = 0; item < 2; item++) {
        expected[3 + player * 2]++;
        expected[1] = Math.imul(expected[1], 31) + player * 10 + item + 1 + commandTicks.indexOf(sourceTick) * 2 + item + 1;
      }
    }
    for (let player = 0; player < count; player++) {
      const session = sessions[player];
      assert.equal(session.tick, target);
      assert.ok(session.confirmedTick >= target - 1, 'hashes must represent fully confirmed states');
      assert.deepEqual(sims[player].state, expected);
      assert.equal(session.metrics.hashMismatches, 0);
      assert.equal(session.metrics.recoveries, 0, 'recovery must not mask a divergent input timeline');
      const replay = session.exportReplay(), replaySim = simulation(players);
      assert.equal(replay.truncated, false);
      const result = playReplay({ adapter: replaySim.adapter, replay });
      assert.equal(result.tick, target);
      assert.equal(result.hash, replay.hash);
      assert.equal(result.hash, session.getStateHash());
      assert.deepEqual(replaySim.state, expected);
      const commands = replay.frames.flatMap(frame => frame.inputs.flatMap(inputFrame =>
        inputFrame.commands.map(command => ({ player: inputFrame.playerId, ...command }))));
      assert.equal(commands.length, count * commandTicks.length * 2);
      assert.equal(new Set(commands.map(command => `${command.player}/${command.sequence}`)).size, commands.length);
      for (const command of commands) {
        const owner = players.indexOf(command.player);
        assert.equal(command.executeTick, commandTicks[Math.floor((command.sequence - 1) / 2)] + delays[owner]);
      }
    }
    assert.equal(new Set(sessions.map(session => session.getStateHash())).size, 1);
    assert.ok(sessions.some(session => session.metrics.rollbacks > 0), 'network must exercise rollback');
    for (const [kind, total] of Object.entries(stats)) assert.ok(total > 0, `${kind} must actually occur`);
  } finally { sessions.forEach(session => session.close()); }
});
