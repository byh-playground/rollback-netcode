import test from 'node:test';
import assert from 'node:assert/strict';
import { createStarTransports } from '../src/star-transport.js';
import { CHUNK_SIZE } from '../src/protocol.js';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(options = {}) {
  const players = ['host', 'a', 'b'], queues = [], raw = new Map(), errors = [];
  function endpoint(from, to) { const listeners = new Set(); let blocked = false;
    const e = { state: 'open', get blocked() { return blocked; }, set blocked(v) { blocked = v; },
      send(bytes) { assert.ok(bytes.length <= CHUNK_SIZE); if (blocked) return false; queues.push({ from, to, bytes: bytes.slice() }); return true; },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, deliver(bytes) { for (const fn of listeners) fn(bytes); } };
    raw.set(from + '/' + to, e); return e;
  }
  const physical = new Map(players.map(id => [id, new Map()]));
  for (const guest of ['a', 'b']) { physical.get('host').set(guest, endpoint('host', guest)); physical.get(guest).set('host', endpoint(guest, 'host')); }
  const routers = new Map(players.map(localPlayerId => [localPlayerId, createStarTransports({ players, localPlayerId, hostPlayerId: 'host', sessionId: 'room-1', physicalTransports: physical.get(localPlayerId), onError: e => errors.push(e), ...options })]));
  function drain() { let work = 0; while (queues.length) { assert.ok(work++ < 10000); const q = queues.shift(); raw.get(q.to + '/' + q.from).deliver(q.bytes); } }
  return { players, queues, raw, errors, routers, drain, close() { routers.forEach(r => r.close()); } };
}

test('star fragments full packets, accepts reversed fragments, and suppresses duplicates', () => {
  const f = fixture(); try {
    const got = []; f.routers.get('b').transports.get('a').subscribe(b => got.push(b));
    const payload = new Uint8Array(CHUNK_SIZE).fill(9); payload[5] = 2;
    assert.equal(f.routers.get('a').transports.get('b').send(payload), true); assert.equal(f.queues.length, 2); assert.ok(f.queues.every(q => q.bytes[5] === 2));
    const copies = f.queues.map(q => ({ ...q, bytes: q.bytes.slice() })); f.queues.reverse(); f.queues.push(...copies); f.drain();
    assert.equal(got.length, 1); assert.deepEqual(got[0], payload); assert.equal(f.routers.get('b').metrics.assemblyBytes, 0);
  } finally { f.close(); }
});

test('physical guests cannot forge another sender or a different session', () => {
  const f = fixture(); try {
    let count = 0; f.routers.get('b').transports.get('a').subscribe(() => count++);
    f.routers.get('a').transports.get('b').send(new Uint8Array([1, 2, 3])); f.queues[0].bytes[6] = 2; f.drain();
    f.routers.get('a').transports.get('b').send(new Uint8Array([1, 2, 3])); f.queues[0].bytes[8] ^= 1; f.drain();
    assert.equal(count, 0); assert.equal(f.routers.get('host').metrics.rejectedFrames, 2); assert.equal(f.errors.length, 0);
  } finally { f.close(); }
});

test('host retains accepted control traffic under backpressure and flushes after recovery', async () => {
  const f = fixture(); try {
    const got = []; f.routers.get('b').transports.get('a').subscribe(b => got.push(b)); f.raw.get('host/b').blocked = true;
    f.routers.get('a').transports.get('b').send(new Uint8Array(CHUNK_SIZE).fill(7)); f.drain();
    assert.equal(got.length, 0); assert.ok(f.routers.get('host').metrics.queuedBytes > 0);
    f.raw.get('host/b').blocked = false; await wait(25); f.drain();
    assert.equal(got.length, 1); assert.equal(got[0].length, CHUNK_SIZE); assert.equal(f.routers.get('host').metrics.queuedBytes, 0);
  } finally { f.close(); }
});

test('bounded forwarding overflow fails explicitly and releases retained memory', () => {
  const f = fixture({ maxQueuedBytes: CHUNK_SIZE * 2 }); try {
    f.raw.get('host/b').blocked = true;
    for (let i = 0; i < 3; i++) { f.routers.get('a').transports.get('b').send(new Uint8Array(CHUNK_SIZE).fill(9)); f.drain(); }
    assert.equal(f.errors.length, 1); assert.match(f.errors[0].message, /capacity/); assert.equal(f.routers.get('host').metrics.queuedBytes, 0);
  } finally { f.close(); }
});

test('incomplete assembly expires and close removes subscriptions', async t => {
  let clock = 0; t.mock.method(globalThis.performance, 'now', () => clock);
  const f = fixture(); let received = 0;
  f.routers.get('b').transports.get('a').subscribe(() => received++);
  f.routers.get('a').transports.get('b').send(new Uint8Array(CHUNK_SIZE).fill(7)); f.queues.pop(); f.drain();
  assert.equal(f.routers.get('b').metrics.assemblyBytes, CHUNK_SIZE);
  clock = 3000; await wait(25); assert.equal(f.routers.get('b').metrics.assemblyBytes, 0);
  f.close(); assert.equal(f.routers.get('a').transports.get('b').send(new Uint8Array([1])), false); assert.equal(received, 0);
});
