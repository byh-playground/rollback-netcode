import test from 'node:test';
import assert from 'node:assert/strict';
import { createNostrRoom, createNostrSignaler } from '../rollback-netcode.js';

function timers(t) {
  const active = new Map(); let id = 0;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { active.set(++id, { callback, delay, interval: false }); return id; });
  t.mock.method(globalThis, 'setInterval', (callback, delay) => { active.set(++id, { callback, delay, interval: true }); return id; });
  t.mock.method(globalThis, 'clearTimeout', handle => active.delete(handle));
  t.mock.method(globalThis, 'clearInterval', handle => active.delete(handle));
  return { active, fire(delay) {
    for (const [handle, timer] of [...active]) if (timer.delay === delay) { if (!timer.interval) active.delete(handle); timer.callback(); }
  } };
}
const microtasks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('a buffered competing room advertisement leaves no timers or subscriptions', async t => {
  const clock = timers(t); let closed = 0, unsubscribed = 0;
  const signalerFactory = async () => ({ id: 'self', send: async () => {}, close: () => closed++,
    subscribe(handler) {
      handler({ from: 'other-host', to: '*', message: { type: 'presence', host: 'other-host', protocol: 1 } });
      return () => unsubscribed++;
    } });
  await assert.rejects(createNostrRoom({ role: 'host', room: '1234', signalerFactory }), /already in use/);
  assert.equal(closed, 1); assert.equal(unsubscribed, 1); assert.equal(clock.active.size, 0);
});

test('room failure cancels a pending peer through its owned abort signal', async t => {
  const clock = timers(t); let handler, peers = 0, aborted = 0, closed = 0;
  const signalerFactory = async () => ({ id: 'self', close: () => closed++,
    subscribe(fn) { handler = fn; return () => {}; },
    send: async to => { if (to !== '*') throw new Error('publication denied'); } });
  const peerFactory = ({ signal }) => new Promise((resolve, reject) => {
    peers++; signal.addEventListener('abort', () => { aborted++; reject(new Error('peer aborted')); }, { once: true });
  });
  const pending = createNostrRoom({ role: 'host', room: '1234', signalerFactory, peerFactory });
  const rejected = assert.rejects(pending, /publication denied/);
  await microtasks(); clock.fire(1200);
  handler({ from: 'joiner', to: 'self', message: { type: 'discover' } });
  await rejected; await microtasks();
  assert.equal(peers, 1); assert.equal(aborted, 1); assert.equal(closed, 1); assert.equal(clock.active.size, 0);
});

test('aborting from a room status observer cannot schedule a late collision timer', async t => {
  const clock = timers(t), controller = new AbortController(); let closed = 0;
  const signalerFactory = async () => ({ id: 'self', send: async () => {}, subscribe: () => () => {}, close: () => closed++ });
  await assert.rejects(createNostrRoom({ role: 'host', room: '1234', signalerFactory, signal: controller.signal,
    onStatus(event) { if (event.type === 'room') controller.abort(); } }), /aborted/);
  assert.equal(closed, 1); assert.equal(clock.active.size, 0);
});

test('aborting from a relay connecting observer does not allocate a socket', async () => {
  const controller = new AbortController(); let created = 0;
  class Socket { constructor() { created++; } }
  await assert.rejects(createNostrSignaler({ room: '1234', relays: ['wss://test.invalid'],
    WebSocketImpl: Socket, signal: controller.signal,
    onStatus(event) { if (event.status === 'connecting') controller.abort(); } }), /closed/);
  assert.equal(created, 0);
});
