import test from 'node:test';
import assert from 'node:assert/strict';
import { createNostrGroupRoom, createSession, profiles, CHUNK_SIZE, playReplay } from '../rollback-netcode.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fixture({ drop = () => false, pendingPeers = false } = {}) {
  const signals = new Map(), pairs = new Map(), messages = [], connections = []; let serial = 0;
  function endpoint() {
    const listeners = new Set(), statuses = new Set(); let other, closed = false;
    return { bind(value) { other = value; },
      transport: { get state() { return closed ? 'closed' : 'open'; },
        send(b) { if (closed) return false; queueMicrotask(() => other?.receive(b.slice())); return true; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        subscribeStatus(fn) { statuses.add(fn); return () => statuses.delete(fn); } },
      receive(b) { if (!closed) for (const fn of listeners) fn(b); },
      close() { if (closed) return; closed = true; for (const fn of statuses) fn('closed'); other?.close(); listeners.clear(); statuses.clear(); },
      peerConnection: { connectionState: 'connected' }
    };
  }
  const signalerFactory = async () => {
    const id = 'p' + serial++, listeners = new Set(); let closed = false;
    const value = { id, listeners, closed: () => closed,
      send: async (to, message) => { if (closed) throw Error('signaler closed'); const envelope = { from: id, to, message: structuredClone(message) }; messages.push(envelope);
        if (drop(envelope)) return;
        queueMicrotask(() => { for (const [remote, target] of signals) if (remote !== id && (to === '*' || remote === to) && !target.closed()) for (const fn of [...target.listeners]) fn(structuredClone(envelope)); }); },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { closed = true; listeners.clear(); }
    }; signals.set(id, value); return value;
  };
  const peerFactory = options => new Promise((resolve, reject) => {
    const { signaler, remoteId, signal } = options, key = [signaler.id, remoteId].sort().join('/');
    const peer = endpoint(); connections.push(peer); const abort = () => { peer.close(); reject(Error('peer aborted')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (pendingPeers) return;
    const waiting = pairs.get(key);
    if (!waiting) pairs.set(key, { peer, resolve });
    else { pairs.delete(key); peer.bind(waiting.peer); waiting.peer.bind(peer); resolve(peer); waiting.resolve(waiting.peer); }
  });
  return { signalerFactory, peerFactory, signals, messages, connections,
    options: { room: '3210', timeoutMs: 8000, signalerFactory, peerFactory },
    get liveSignallers() { return [...signals.values()].filter(s => !s.closed()).length; }
  };
}

for (const topology of ['mesh', 'star']) for (const playerCount of [2, 3, 4, 5, 6, 7, 8]) {
  test(`${playerCount}-player ${topology}: agreed roster, every logical route, full-size payload and cleanup`, async () => {
    const f = fixture(), rooms = await Promise.all(Array.from({ length: playerCount }, (_, i) =>
      createNostrGroupRoom({ ...f.options, role: i ? 'join' : 'host', playerCount, topology })));
    try {
      const ids = rooms[0].players, received = [];
      assert.equal(f.connections.length, topology === 'mesh' ? playerCount * (playerCount - 1) : 2 * (playerCount - 1));
      for (const r of rooms) {
        assert.deepEqual(r.players, ids); assert.ok(Object.isFrozen(r.players)); assert.equal(r.transports.size, playerCount - 1);
        assert.equal(r.authorityPlayerId, ids[0]); assert.equal(r.sessionId, rooms[0].sessionId);
        assert.equal(r.peerConnections.size, topology === 'star' && r.localPlayerId !== r.hostPlayerId ? 1 : playerCount - 1);
        for (const [from, transport] of r.transports) transport.subscribe(b => received.push([from, r.localPlayerId, b]));
      }
      for (let i = 0; i < rooms.length; i++) for (const t of rooms[i].transports.values()) assert.equal(t.send(new Uint8Array(CHUNK_SIZE).fill(i + 10)), true);
      for (let i = 0; i < 20 && received.length < playerCount * (playerCount - 1); i++) await sleep(10);
      assert.equal(received.length, playerCount * (playerCount - 1));
      for (const [from, to, data] of received) { assert.notEqual(from, to); assert.deepEqual(data, new Uint8Array(CHUNK_SIZE).fill(ids.indexOf(from) + 10)); }
    } finally { rooms.forEach(r => r.close()); }
    await settle(); assert.equal(f.liveSignallers, 0); assert.ok(rooms.every(r => r.closed));
  });
}

test('lost roster acknowledgement and lost start are recovered by idempotent phase retransmission', async () => {
  const lost = new Set(); const f = fixture({ drop: e => {
    if (['ack', 'start'].includes(e.message.op) && !lost.has(e.message.op)) { lost.add(e.message.op); return true; } return false;
  } });
  const rooms = await Promise.all([0, 1, 2].map(i => createNostrGroupRoom({ ...f.options, role: i ? 'join' : 'host', playerCount: 3 })));
  assert.equal(lost.size, 2); assert.equal(f.connections.length, 6); rooms.forEach(r => r.close()); await settle(); assert.equal(f.liveSignallers, 0);
});

test('count/topology mismatch fails explicitly without allocating peer connections', async () => {
  const f = fixture(), c = new AbortController();
  const host = createNostrGroupRoom({ ...f.options, role: 'host', playerCount: 4, topology: 'star', signal: c.signal });
  const hostRejected = assert.rejects(host, /aborted/);
  await assert.rejects(createNostrGroupRoom({ ...f.options, role: 'join', playerCount: 3, topology: 'mesh' }), /mismatch/);
  c.abort(); await hostRejected; await settle(); assert.equal(f.connections.length, 0); assert.equal(f.liveSignallers, 0);
});

test('abort inside status callback cancels formation and pending peers', async () => {
  for (const abortPhase of ['room', 'group-connecting']) {
    const f = fixture({ pendingPeers: true }), c = new AbortController();
    const promises = [0, 1].map(i => createNostrGroupRoom({ ...f.options, role: i ? 'join' : 'host', signal: c.signal,
      onStatus: e => { if (e.type === abortPhase) c.abort(); } }));
    const results = await Promise.allSettled(promises); assert.ok(results.every(r => r.status === 'rejected'));
    await settle(); assert.equal(f.liveSignallers, 0);
  }
});

test('late join cannot change a running roster, and host closure closes a star room', async () => {
  const f = fixture(), rooms = await Promise.all([0, 1, 2].map(i => createNostrGroupRoom({ ...f.options, role: i ? 'join' : 'host', playerCount: 3, topology: 'star' })));
  await assert.rejects(createNostrGroupRoom({ ...f.options, role: 'join', playerCount: 3, topology: 'star' }), /full|started|roster/);
  rooms[0].close(); await settle(); assert.ok(rooms.every(r => r.closed)); assert.equal(f.liveSignallers, 0);
});

test('malformed agreed-host roster is rejected rather than starting a partial session', async () => {
  const f = fixture({ drop: e => {
    if (e.message.op === 'roster') e.message.players = ['p0', 'p0']; return false;
  } }), c = new AbortController();
  const host = createNostrGroupRoom({ ...f.options, role: 'host', signal: c.signal }); const end = assert.rejects(host, /left|aborted/);
  await assert.rejects(createNostrGroupRoom({ ...f.options, role: 'join' }), /roster/); c.abort(); await end; await settle();
  assert.equal(f.liveSignallers, 0); assert.equal(f.connections.length, 0);
});

test('invalid player counts are rejected before signaling', async () => {
  for (const playerCount of [0, 1, 9, 2.5, NaN]) await assert.rejects(createNostrGroupRoom({ role: 'host', playerCount }), /playerCount/);
});

test('another host cannot tear down an already running room with a collision advertisement', async () => {
  const f = fixture(), rooms = await Promise.all([0, 1].map(i => createNostrGroupRoom({ ...f.options, role: i ? 'join' : 'host' })));
  try {
    await assert.rejects(createNostrGroupRoom({ ...f.options, role: 'host' }), /already in use/);
    assert.ok(rooms.every(r => !r.closed)); assert.equal(f.connections.length, 2);
  } finally { rooms.forEach(r => r.close()); await settle(); }
  assert.equal(f.liveSignallers, 0);
});

test('formation timeout closes signaling without allocating partial connections', async () => {
  const f = fixture(); await assert.rejects(createNostrGroupRoom({ ...f.options, role: 'host', timeoutMs: 30, playerCount: 8 }), /timeout/);
  await settle(); assert.equal(f.liveSignallers, 0); assert.equal(f.connections.length, 0);
});

test('unchanged Core converges through the N-player star routes, including one-shot commands and replay', async () => {
  const n = 4, f = fixture(), rooms = await Promise.all(Array.from({ length: n }, (_, i) => createNostrGroupRoom({ ...f.options, role: i ? 'join' : 'host', topology: 'star', playerCount: n })));
  let now = 0;
  const adapters = rooms.map(() => { let values = new Int32Array(n + 2); return {
    save: () => new Uint8Array(values.buffer.slice(0)), load: b => { values = new Int32Array(b.slice().buffer); }, validateSnapshot: b => b.length === (n + 2) * 4,
    step({ tick, inputs }) { assert.equal(values[0], tick); values[0]++; inputs.forEach((p, i) => { values[i + 1] += p.input[0]; values[n + 1] += p.commands.length; }); }
  }; });
  const sessions = rooms.map((r, i) => createSession({ players: r.players, localPlayerId: r.localPlayerId, authorityPlayerId: r.authorityPlayerId,
    sessionId: r.sessionId, simulationVersion: 'star-core-test', inputSize: 1, adapter: adapters[i], clock: () => now,
    profile: { ...profiles.action, pacingPolicy: 'none', adaptiveInputDelay: false } }));
  try {
    sessions.forEach((s, i) => { for (const [id, t] of rooms[i].transports) s.attachTransport(id, t); s.queueCommand(new Uint8Array([i])); });
    for (let round = 0; round < 1000; round++) {
      now += 16; sessions.forEach((s, i) => { s.poll(); if (s.tick < 120) s.advance(new Uint8Array([i + 1])); }); await settle();
      if (sessions.every(s => s.tick === 120 && s.confirmedTick >= 119)) break;
    }
    assert.ok(sessions.every(s => s.tick === 120 && s.confirmedTick >= 119)); assert.equal(new Set(sessions.map(s => s.getStateHash())).size, 1);
    const state = new Int32Array(adapters[0].save().buffer); assert.equal(state[n + 1], n);
    const replay = sessions[0].exportReplay(); assert.equal(playReplay({ adapter: adapters[0], replay }).hash, replay.hash);
  } finally { sessions.forEach(s => s.close()); rooms.forEach(r => r.close()); }
});
