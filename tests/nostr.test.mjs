import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {nostrCrypto, createNostrSignaler} from '../rollback-netcode.js';

const fromHex = text => new Uint8Array(Buffer.from(text, 'hex'));
const hex = bytes => Buffer.from(bytes).toString('hex');
const digest = text => new Uint8Array(createHash('sha256').update(text, 'utf8').digest());
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description = 'condition', timeoutMs = 1500) {
  const expires = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= expires) throw new Error(`Timed out waiting for ${description}`);
    await pause(5);
  }
}

async function rejectsPromptly(promise, expected) {
  let watchdog;
  try {
    await assert.rejects(Promise.race([promise, new Promise((resolve, reject) => {
      watchdog = setTimeout(() => reject(new Error('Nostr abort did not reject promptly')), 200);
    })]), expected);
  } finally { clearTimeout(watchdog); }
}

function mockRelays(configs = {}) {
  const sockets = [];
  const publications = [];
  class MockWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.config = configs[url] || {};
      if (this.config.constructorError) throw new Error('mock constructor failure');
      this.readyState = 0;
      this.frames = [];
      this.closeCount = 0;
      sockets.push(this);
      if (!this.config.neverOpen) queueMicrotask(() => {
        if (this.readyState !== 0) return;
        if (this.config.openError) this.dispatchEvent(new Event('error'));
        else { this.readyState = 1; this.dispatchEvent(new Event('open')); }
      });
    }
    message(frame) {
      this.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(frame)}));
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('Socket is not open');
      const frame = JSON.parse(text);
      this.frames.push(frame);
      if (frame[0] === 'REQ') {
        this.subscription = frame[1];
        if (this.config.closedSubscription) queueMicrotask(() => this.message(['CLOSED', frame[1], 'restricted: mock denied subscription']));
        else if (!this.config.noEose) queueMicrotask(() => this.message(['EOSE', frame[1]]));
      } else if (frame[0] === 'EVENT') {
        if (this.config.sendError) throw new Error('mock send failure');
        publications.push({socket: this, event: frame[1], at: performance.now()});
        if (this.config.ack !== 'none') queueMicrotask(() => {
          if (this.readyState === 1) this.message(['OK', frame[1].id, this.config.ack !== false,
            this.config.ack === false ? 'restricted: mock denied publication' : '']);
        });
        if (this.config.deliver) queueMicrotask(() => {
          for (const socket of sockets) {
            if (socket.url === this.url && socket.readyState === 1 && socket.subscription) socket.message(['EVENT', socket.subscription, frame[1]]);
          }
        });
      }
    }
    close() {
      this.closeCount++;
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  return {WebSocketImpl: MockWebSocket, sockets, publications};
}

async function createMock(t, harness, overrides = {}) {
  const signaler = await createNostrSignaler({room: '1234', relays: ['wss://mock.test'],
    timeoutMs: 200, WebSocketImpl: harness.WebSocketImpl, ...overrides});
  t.after(() => signaler.close());
  return signaler;
}

async function signedEvent({
  secret = fromHex('0000000000000000000000000000000000000000000000000000000000000003'),
  namespace = 'rollback-netcode', room = '1234', to = '*', message = {type: 'discover'},
  createdAt = Math.floor(Date.now() / 1000), tags, contentOverrides = {}
} = {}) {
  const pubkey = hex(nostrCrypto.publicKey(secret));
  const event = {pubkey, created_at: createdAt, kind: 20078,
    tags: tags || [['d', `${namespace}:${room}`], ...(to === '*' ? [] : [['p', to]])],
    content: JSON.stringify({v: 1, namespace, room, from: pubkey, to,
      nonce: randomBytes(16).toString('hex'), message, ...contentOverrides})};
  const hash = digest(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
  event.id = hex(hash);
  event.sig = hex(await nostrCrypto.sign(hash, secret, new Uint8Array(32)));
  return event;
}

test('BIP340 official 32-byte-message vectors: public keys, signatures, valid and invalid verification', async () => {
  // Verbatim conformance data from the official bitcoin/bips repository:
  // https://github.com/bitcoin/bips/blob/master/bip-0340/test-vectors.csv
  const fixture = await readFile(new URL('./fixtures/bip340-test-vectors.csv', import.meta.url), 'utf8');
  let checked = 0;
  let signed = 0;
  for (const line of fixture.trim().split(/\r?\n/).slice(1)) {
    const [index, secret, publicKey, auxiliary, message, signature, expected] = line.split(',');
    // Our exported test helper deliberately takes a Nostr event hash (32 bytes).
    // Official vectors 15-18 cover arbitrary-length BIP340 messages, outside it.
    if (message.length !== 64) continue;
    assert.equal(await nostrCrypto.verify(fromHex(signature), fromHex(message), fromHex(publicKey)), expected === 'TRUE', `verify vector ${index}`);
    if (secret) {
      assert.equal(hex(nostrCrypto.publicKey(fromHex(secret))), publicKey.toLowerCase(), `pubkey vector ${index}`);
      assert.equal(hex(await nostrCrypto.sign(fromHex(message), fromHex(secret), fromHex(auxiliary))), signature.toLowerCase(), `sign vector ${index}`);
      signed++;
    }
    checked++;
  }
  assert.equal(checked, 15);
  assert.equal(signed, 4);
});

test('BIP340 rejects tampering and out-of-range keys; caller buffers survive signing', async () => {
  const secret = new Uint8Array(32).fill(7);
  const message = new Uint8Array(32).fill(9);
  const auxiliary = new Uint8Array(32).fill(11);
  const publicKey = nostrCrypto.publicKey(secret);
  const signature = await nostrCrypto.sign(message, secret, auxiliary);
  assert.equal(await nostrCrypto.verify(signature, message, publicKey), true);
  const changedMessage = new Uint8Array(message); changedMessage[1] ^= 1;
  const changedSignature = new Uint8Array(signature); changedSignature[50] ^= 1;
  assert.equal(await nostrCrypto.verify(signature, changedMessage, publicKey), false);
  assert.equal(await nostrCrypto.verify(changedSignature, message, publicKey), false);
  assert.equal(await nostrCrypto.verify(signature.subarray(1), message, publicKey), false);
  assert.equal(await nostrCrypto.verify(signature, new Uint8Array(31), publicKey), false);
  assert.throws(() => nostrCrypto.publicKey(new Uint8Array(32)), /Invalid/);
  assert.throws(() => nostrCrypto.publicKey(new Uint8Array(32).fill(255)), /Invalid/);
  await assert.rejects(nostrCrypto.sign(message, new Uint8Array(32), auxiliary), /Invalid/);
  await assert.rejects(nostrCrypto.sign(new Uint8Array(31), secret, auxiliary), /32-byte/);
  assert.deepEqual(secret, new Uint8Array(32).fill(7));
  assert.deepEqual(message, new Uint8Array(32).fill(9));
  assert.deepEqual(auxiliary, new Uint8Array(32).fill(11));
});

test('NIP-01 sends valid signed ephemeral events, four-digit room filter and recipient tags', async t => {
  const harness = mockRelays();
  const statuses = [];
  const signaler = await createMock(t, harness, {room: '0012', onStatus: status => statuses.push(status)});
  assert.match(signaler.id, /^[a-f0-9]{64}$/);
  assert.equal(signaler.room, '0012');
  const request = harness.sockets[0].frames.find(frame => frame[0] === 'REQ');
  assert.equal(request.length, 3);
  assert.ok(request[1].length > 0 && request[1].length <= 64);
  assert.deepEqual(request[2].kinds, [20078]);
  assert.deepEqual(request[2]['#d'], ['rollback-netcode:0012']);
  assert.equal(request[2].limit, 0);
  assert.ok(Math.abs(request[2].since - (Math.floor(Date.now() / 1000) - 120)) <= 1);
  const recipient = 'ab'.repeat(32);
  await signaler.send(recipient, {type: 'offer', description: {type: 'offer', sdp: 'v=0\r\na=ice-options:trickle\r\n'}});
  await signaler.send('*', {type: 'discover'});
  await signaler.send('*', {type: 'discover'});
  assert.equal(harness.publications.length, 3);
  for (const {event} of harness.publications) {
    assert.equal(event.kind, 20078);
    const hash = digest(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]));
    assert.equal(event.id, hex(hash));
    assert.equal(await nostrCrypto.verify(fromHex(event.sig), hash, fromHex(event.pubkey)), true);
    const content = JSON.parse(event.content);
    assert.equal(content.room, '0012');
    assert.equal(content.namespace, 'rollback-netcode');
    assert.equal(content.from, signaler.id);
  }
  assert.deepEqual(harness.publications[0].event.tags, [['d', 'rollback-netcode:0012'], ['p', recipient]]);
  assert.deepEqual(harness.publications[1].event.tags, [['d', 'rollback-netcode:0012']]);
  assert.notEqual(harness.publications[1].event.id, harness.publications[2].event.id, 'same-second discovery has a unique nonce');
  assert.ok(statuses.some(status => status.status === 'published'));
});

test('NIP-01 validates incoming IDs/signatures, room/namespace/recipient/freshness, and deduplicates across relays', async t => {
  const harness = mockRelays();
  const signaler = await createMock(t, harness, {relays: ['wss://first.test', 'wss://second.test']});
  const received = [];
  signaler.subscribe(envelope => received.push(envelope));
  const [first, second] = harness.sockets;
  const deliver = (event, socket = first) => socket.message(['EVENT', socket.subscription, event]);
  const valid = await signedEvent({to: signaler.id, message: {type: 'ice', candidate: {candidate: 'candidate:1'}}});
  const invalidSignature = {...valid, sig: `${valid.sig[0] === '0' ? '1' : '0'}${valid.sig.slice(1)}`};
  const invalidId = {...valid, id: '00'.repeat(32)};
  deliver(invalidSignature);
  deliver(invalidId);
  first.message(['EVENT', 'wrong-subscription', valid]);
  deliver(await signedEvent({room: '4321'}));
  deliver(await signedEvent({namespace: 'other-app'}));
  deliver(await signedEvent({to: 'ab'.repeat(32)}));
  deliver(await signedEvent({to: signaler.id, tags: [['d', 'rollback-netcode:1234'], ['p', 'cd'.repeat(32)]]}));
  deliver(await signedEvent({tags: [['d', 'rollback-netcode:1234'], ['d', 'other']]}));
  deliver(await signedEvent({tags: [['d', 'rollback-netcode:1234'], ['p', signaler.id]]}));
  deliver(await signedEvent({contentOverrides: {from: 'ab'.repeat(32)}}));
  deliver(await signedEvent({createdAt: Math.floor(Date.now() / 1000) - 121}));
  deliver(await signedEvent({createdAt: Math.floor(Date.now() / 1000) + 31}));
  deliver(await signedEvent({message: {type: 'input', tick: 1, value: {left: true}}}));
  deliver(await signedEvent({message: {type: 'state', state: {position: 10}}}));
  await pause(20);
  assert.equal(received.length, 0);
  deliver(valid);
  deliver(valid, second);
  await until(() => received.length === 1, 'verified event delivery');
  deliver(valid);
  const broadcast = await signedEvent({message: {type: 'presence', protocol: 1}});
  deliver(broadcast);
  await until(() => received.length === 2, 'broadcast discovery');
  await pause(20);
  assert.deepEqual(received[0], {from: valid.pubkey, to: signaler.id, message: {type: 'ice', candidate: {candidate: 'candidate:1'}}});
  assert.equal(received[1].to, '*');
});

test('two peers exchange broadcast discovery and directed SDP over a mocked public relay', async t => {
  const harness = mockRelays({'wss://mock.test/': {deliver: true}});
  const first = await createMock(t, harness);
  const second = await createMock(t, harness);
  assert.notEqual(first.id, second.id);
  const firstReceived = [];
  const secondReceived = [];
  first.subscribe(message => firstReceived.push(message));
  second.subscribe(message => secondReceived.push(message));
  await first.send('*', {type: 'discover'});
  await until(() => secondReceived.length === 1);
  assert.equal(firstReceived.length, 0, 'own broadcast is ignored');
  await second.send(first.id, {type: 'answer', description: {type: 'answer', sdp: 'v=0'}});
  await until(() => firstReceived.length === 1);
  assert.equal(secondReceived.length, 1, 'directed event is delivered only to recipient');
  assert.equal(firstReceived[0].from, second.id);
});

test('publication resolves only after positive OK; negative, malformed, missing ACK and disconnect reject', async t => {
  const deniedHarness = mockRelays({'wss://mock.test/': {ack: false}});
  const denied = await createMock(t, deniedHarness);
  await assert.rejects(denied.send('*', {type: 'discover'}), /No Nostr relay accepted.*restricted/);

  const silentHarness = mockRelays({'wss://mock.test/': {ack: 'none'}});
  const silent = await createMock(t, silentHarness, {timeoutMs: 60});
  const waiting = silent.send('*', {type: 'discover'});
  const rejection = assert.rejects(waiting, /timed out without a positive relay OK/);
  await until(() => silentHarness.publications.length === 1);
  const eventId = silentHarness.publications[0].event.id;
  silentHarness.sockets[0].message(['OK', eventId, 'true', '']);
  silentHarness.sockets[0].message(['OK', eventId, true]);
  silentHarness.sockets[0].message(['OK', 'ab'.repeat(32), true, '']);
  await rejection;

  const disconnectedHarness = mockRelays({'wss://mock.test/': {ack: 'none'}});
  const disconnected = await createMock(t, disconnectedHarness);
  const sending = disconnected.send('*', {type: 'discover'});
  const disconnectedRejection = assert.rejects(sending, /No Nostr relay accepted.*disconnected/);
  await until(() => disconnectedHarness.publications.length === 1);
  disconnectedHarness.sockets[0].close();
  await disconnectedRejection;
  await assert.rejects(disconnected.send('*', {type: 'discover'}), /No live Nostr relays/);
});

test('one positive ACK is enough among multiple relays; failed and hanging relays do not prevent readiness', async t => {
  const harness = mockRelays({
    'wss://denied.test/': {ack: false},
    'wss://constructor.test/': {constructorError: true},
    'wss://hanging.test/': {neverOpen: true}
  });
  const statuses = [];
  const signaler = await createMock(t, harness, {relays: ['wss://denied.test', 'wss://accepted.test', 'wss://constructor.test', 'wss://hanging.test'],
    timeoutMs: 100, onStatus: status => statuses.push(status)});
  await until(() => statuses.filter(status => status.status === 'connected').length === 2);
  await signaler.send('*', {type: 'discover'});
  assert.equal(harness.publications.length, 2);
  assert.ok(statuses.some(status => status.relay === 'wss://accepted.test/' && status.status === 'published'));
  await until(() => harness.sockets.find(socket => socket.url === 'wss://hanging.test/').readyState === 3);
  assert.ok(statuses.some(status => status.message?.includes('timed out')));
});

test('all connection failures and server-ended subscriptions dispose and reject', async () => {
  for (const config of [{neverOpen: true}, {noEose: true}, {closedSubscription: true}, {openError: true}, {constructorError: true}]) {
    const harness = mockRelays({'wss://mock.test/': config});
    await assert.rejects(createNostrSignaler({room: '1234', relays: ['wss://mock.test'], timeoutMs: 25,
      WebSocketImpl: harness.WebSocketImpl}), /No Nostr relay became ready/);
    assert.ok(harness.sockets.every(socket => socket.readyState === 3));
  }
});

test('abort before Nostr initialization rejects without constructing any relay sockets', async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = mockRelays();
  const statuses = [];
  await rejectsPromptly(createNostrSignaler({room: '1234', relays: ['wss://mock.test'],
    signal: controller.signal, WebSocketImpl: harness.WebSocketImpl, onStatus: status => statuses.push(status)}), /Nostr signaler aborted/);
  assert.equal(harness.sockets.length, 0);
  assert.equal(harness.publications.length, 0);
  assert.equal(statuses.length, 0);
});

test('abort while Nostr relay opening is pending closes every socket once and rejects promptly', async t => {
  const controller = new AbortController();
  const harness = mockRelays({'wss://first.test/': {neverOpen: true}, 'wss://second.test/': {neverOpen: true}});
  const statuses = [];
  t.after(() => { for (const socket of harness.sockets) if (socket.readyState !== 3) socket.close(); });
  const creating = createNostrSignaler({room: '1234', relays: ['wss://first.test', 'wss://second.test'],
    timeoutMs: 1000, signal: controller.signal, WebSocketImpl: harness.WebSocketImpl, onStatus: status => statuses.push(status)});
  assert.equal(harness.sockets.length, 2);
  assert.ok(harness.sockets.every(socket => socket.readyState === 0));
  const rejected = rejectsPromptly(creating, /Nostr signaler closed/);
  controller.abort();
  await rejected;
  controller.abort();
  for (const socket of harness.sockets) {
    assert.equal(socket.readyState, 3);
    assert.equal(socket.closeCount, 1);
    assert.equal(socket.frames.length, 0, 'no subscription was created before open');
    socket.dispatchEvent(new Event('open'));
    assert.equal(socket.frames.length, 0, 'late open cannot recreate an aborted subscription');
  }
  assert.equal(statuses.filter(status => status.status === 'closed').length, 1);
  assert.equal(statuses.filter(status => status.status === 'connected').length, 0);
});

test('abort while Nostr subscription EOSE is pending unsubscribes, closes once and rejects promptly', async t => {
  const controller = new AbortController();
  const harness = mockRelays({'wss://first.test/': {noEose: true}, 'wss://second.test/': {noEose: true}});
  const statuses = [];
  t.after(() => { for (const socket of harness.sockets) if (socket.readyState !== 3) socket.close(); });
  const creating = createNostrSignaler({room: '1234', relays: ['wss://first.test', 'wss://second.test'],
    timeoutMs: 1000, signal: controller.signal, WebSocketImpl: harness.WebSocketImpl, onStatus: status => statuses.push(status)});
  await until(() => harness.sockets.length === 2 && harness.sockets.every(socket => socket.subscription), 'pending EOSE subscriptions');
  assert.ok(harness.sockets.every(socket => socket.readyState === 1));
  const rejected = rejectsPromptly(creating, /Nostr signaler closed/);
  controller.abort();
  await rejected;
  controller.abort();
  for (const socket of harness.sockets) {
    assert.equal(socket.readyState, 3);
    assert.equal(socket.closeCount, 1);
    assert.deepEqual(socket.frames.filter(frame => frame[0] === 'CLOSE'), [['CLOSE', socket.subscription]]);
    socket.message(['EOSE', socket.subscription]);
    assert.equal(socket.closeCount, 1, 'late EOSE cannot reopen or reclose an aborted relay');
  }
  assert.equal(statuses.filter(status => status.status === 'closed').length, 1);
  assert.equal(statuses.filter(status => status.status === 'connected').length, 0);
});

test('close unsubscribes all relays, cancels pending ACKs, stops delivery, and is idempotent', async t => {
  const harness = mockRelays({'wss://first.test/': {ack: 'none'}, 'wss://second.test/': {ack: 'none'}});
  const signaler = await createMock(t, harness, {relays: ['wss://first.test', 'wss://second.test']});
  const received = [];
  signaler.subscribe(message => received.push(message));
  const sending = signaler.send('*', {type: 'discover'});
  const rejected = assert.rejects(sending, /signaler closed/);
  await until(() => harness.publications.length === 2);
  signaler.close();
  await rejected;
  const event = await signedEvent({to: signaler.id});
  for (const socket of harness.sockets) {
    assert.ok(socket.frames.some(frame => frame[0] === 'CLOSE' && frame[1] === socket.subscription));
    assert.equal(socket.readyState, 3);
    assert.equal(socket.closeCount, 1);
    socket.message(['EVENT', socket.subscription, event]);
  }
  signaler.close();
  assert.ok(harness.sockets.every(socket => socket.closeCount === 1));
  await pause(20);
  assert.equal(received.length, 0);
  await assert.rejects(signaler.send('*', {type: 'discover'}), /closed/);
  assert.throws(() => signaler.subscribe(() => {}), /closed/);
});

test('Nostr rejects game traffic, invalid settings, and oversized UTF-8 content before publication', async t => {
  const harness = mockRelays();
  const signaler = await createMock(t, harness);
  await assert.rejects(signaler.send('*', {type: 'input', input: {left: true}}), /signaling only/);
  await assert.rejects(signaler.send('*', {type: 'state', state: {x: 1}}), /signaling only/);
  await assert.rejects(signaler.send('invalid-peer', {type: 'discover'}), /recipient/);
  await assert.rejects(signaler.send('*', {type: 'offer', description: {sdp: '가'.repeat(44000)}}), /128 KiB/);
  const circular = {type: 'offer'}; circular.circular = circular;
  await assert.rejects(signaler.send('*', circular), /JSON serializable/);
  await assert.rejects(signaler.send('*', {type: 'discover', toJSON: () => ({type: 'input'})}), /changed its type/);
  assert.equal(harness.publications.length, 0);
  for (const options of [{room: '123'}, {room: 1234}, {room: '１２３４'}, {namespace: ''}, {namespace: '가'.repeat(43)},
    {relays: []}, {relays: ['https://mock.test']}, {timeoutMs: 0}, {cryptoImpl: {}}, {WebSocketImpl: null}]) {
    await assert.rejects(createNostrSignaler({room: '1234', relays: ['wss://mock.test'], WebSocketImpl: harness.WebSocketImpl, ...options}));
  }
  const stuckRandom = {subtle: globalThis.crypto.subtle, getRandomValues: bytes => bytes};
  await assert.rejects(createNostrSignaler({room: '1234', relays: ['wss://mock.test'], WebSocketImpl: harness.WebSocketImpl,
    cryptoImpl: stuckRandom}), /random secret generation failed/);
});

test('subscriber exceptions are isolated, unsubscribe works and verification uses injected WebCrypto', async t => {
  const harness = mockRelays();
  let digests = 0;
  const cryptoImpl = {getRandomValues: bytes => globalThis.crypto.getRandomValues(bytes),
    subtle: {digest: (...args) => { digests++; return globalThis.crypto.subtle.digest(...args); }}};
  const statuses = [];
  const signaler = await createMock(t, harness, {cryptoImpl, onStatus: status => { statuses.push(status); if (status.status === 'published') throw new Error('observer failure'); }});
  const received = [];
  signaler.subscribe(() => { throw new Error('subscriber failure'); });
  const unsubscribe = signaler.subscribe(message => received.push(message));
  const event = await signedEvent();
  harness.sockets[0].message(['EVENT', harness.sockets[0].subscription, event]);
  await until(() => received.length === 1);
  assert.ok(statuses.some(status => status.message === 'subscriber failure'));
  assert.ok(digests >= 3);
  unsubscribe();
  const second = await signedEvent();
  harness.sockets[0].message(['EVENT', harness.sockets[0].subscription, second]);
  await until(() => statuses.filter(status => status.message === 'subscriber failure').length === 2);
  assert.equal(received.length, 1);
  await signaler.send('*', {type: 'discover'});
});

test('Nostr publication throttle preserves concurrent send order and configured spacing', async t => {
  const harness = mockRelays();
  const signaler = await createMock(t, harness, {publishIntervalMs: 60});
  const completed = [];
  await Promise.all([1, 2, 3].map(sequence => signaler.send('*', {type: 'ice', candidate: null, sequence})
    .then(() => completed.push(sequence))));
  assert.deepEqual(completed, [1, 2, 3]);
  assert.deepEqual(harness.publications.map(({event}) => JSON.parse(event.content).message.sequence), [1, 2, 3]);
  for (let index = 1; index < harness.publications.length; index++) {
    const spacing = harness.publications[index].at - harness.publications[index - 1].at;
    assert.ok(spacing >= 50, `Observed EVENT spacing ${spacing}ms must respect the 60ms publication interval`);
  }
});

test('Nostr publication throttle waits are cancelled promptly by close and abort without extra events', async t => {
  for (const cancellation of ['close', 'abort']) {
    const controller = new AbortController();
    const harness = mockRelays();
    const signaler = await createMock(t, harness, {publishIntervalMs: 500, signal: controller.signal});
    await signaler.send('*', {type: 'discover'});
    const waiting = signaler.send('*', {type: 'ice', candidate: null, sequence: 1});
    const queued = signaler.send('*', {type: 'ice', candidate: null, sequence: 2});
    await pause(20);
    assert.equal(harness.publications.length, 1, 'later sends are still waiting for their publication interval');
    const rejections = [rejectsPromptly(waiting, /Nostr signaler closed/), rejectsPromptly(queued, /Nostr signaler closed/)];
    if (cancellation === 'close') signaler.close();
    else controller.abort();
    await Promise.all(rejections);
    assert.equal(harness.publications.length, 1, `${cancellation} must stop throttled and queued EVENT publications`);
    assert.ok(harness.sockets.every(socket => socket.readyState === 3));
  }
});

test('Nostr publication fallback waits for pending EOSE and forwards the same signed event after a fast denial', async t => {
  const harness = mockRelays({'wss://first.test/': {ack: false}, 'wss://second.test/': {noEose: true}});
  const signaler = await createMock(t, harness, {relays: ['wss://first.test', 'wss://second.test'], timeoutMs: 500});
  const [first, second] = harness.sockets;
  let settlement = 'pending';
  const sending = signaler.send('*', {type: 'discover'});
  sending.then(() => { settlement = 'resolved'; }, () => { settlement = 'rejected'; });
  await until(() => harness.publications.length === 1 && first.readyState === 3, 'fast negative relay ACK');
  assert.equal(settlement, 'pending', 'the pending fallback must keep the publication alive after the first relay denies it');
  assert.equal(second.readyState, 1);
  assert.ok(second.subscription);
  const original = harness.publications[0].event;
  second.message(['EOSE', second.subscription]);
  await sending;
  assert.equal(settlement, 'resolved');
  assert.equal(harness.publications.length, 2);
  const forwarded = harness.publications[1].event;
  assert.equal(harness.publications[1].socket, second);
  assert.equal(forwarded.id, original.id);
  assert.equal(forwarded.sig, original.sig);
  assert.deepEqual(forwarded, original, 'fallback forwards the original signed event rather than generating a replacement');
  second.message(['EOSE', second.subscription]);
  assert.equal(harness.publications.length, 2, 'repeated EOSE cannot publish the same event again');
});
