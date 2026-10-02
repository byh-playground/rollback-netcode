import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, profiles } from '../rollback-netcode.js';

test('three peers with distinct runtime delay bounds converge to one ordered input timeline', () => {
  const players = ['a', 'b', 'c'], delays = [0, 4, 8], target = 120;
  let now = 1000; const queue = [], listeners = new Map();
  const states = players.map(() => new Int32Array(4));
  const input = (index, tick) => new Uint8Array([(tick * 3 + index + 1) % 13]);
  const sessions = players.map((localPlayerId, index) => createSession({
    players: ['c', 'a', 'b'], localPlayerId, sessionId: 'mesh', simulationVersion: 'mesh-v1',
    inputSize: 1, clock: () => now,
    profile: { ...profiles.action, baseInputDelayTicks: delays[index], maxInputDelayTicks: [1, 4, 12][index],
      adaptiveInputDelay: false, pacingPolicy: 'none', stateHistorySize: 32 },
    adapter: {
      save: () => new Uint8Array(states[index].buffer.slice(0)),
      load: b => states[index].set(new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))),
      validateSnapshot: b => b.byteLength === 16,
      step({ tick, inputs, tickRate }) {
        assert.equal(tick, states[index][0]); assert.equal(tickRate, 60);
        assert.deepEqual(inputs.map(f => f.playerId), players);
        inputs.forEach((f, player) => { states[index][player + 1] += f.input[0]; }); states[index][0]++;
      },
    },
  }));
  for (const from of players) for (const to of players) if (from !== to) {
    const key = `${to}/${from}`;
    sessions[players.indexOf(from)].attachTransport(to, {
      send: b => { queue.push({ key, data: b.slice() }); return true; },
      subscribe: fn => { listeners.set(`${from}/${to}`, fn); return () => listeners.delete(`${from}/${to}`); },
    });
  }
  const deliver = () => {
    let count = 0;
    while (queue.length) { if (++count > 10000) throw new Error('unbounded protocol response'); const p = queue.shift(); listeners.get(p.key)?.(p.data); }
  };
  try {
    deliver();
    for (let round = 0; round < target * 20; round++) {
      for (let i = 0; i < sessions.length; i++) if (sessions[i].tick < target && !sessions[i].resimulating) sessions[i].advance(input(i, sessions[i].tick));
      now += 20; deliver(); sessions.forEach(s => s.poll(now)); deliver();
      if (sessions.every(s => s.tick === target && s.confirmedTick >= target - 1 && !s.resimulating)) break;
    }
    const expected = [target, 0, 0, 0];
    for (let tick = 0; tick < target; tick++) for (let i = 0; i < players.length; i++) if (tick >= delays[i]) expected[i + 1] += input(i, tick - delays[i])[0];
    states.forEach(state => assert.deepEqual([...state], expected));
    sessions.forEach(session => { assert.equal(session.tick, target); assert.equal(session.metrics.rejectedPackets, 0); });
    assert.equal(new Set(sessions.map(s => s.getStateHash())).size, 1);
  } finally { sessions.forEach(s => s.close()); }
});
