import { integer, nowMs } from './utilities.js';
import { nostrOrder, nostrEncoder, nostrRequireCrypto, nostrHash, nostrVerify, nostrSign, nostrBytesToNumber, nostrToHex, nostrFromHex, nostrPublicKey } from './nostr-crypto.js';
const nostrHex32 = /^[0-9a-f]{64}$/;
const nostrHex64 = /^[0-9a-f]{128}$/;
const nostrSignalTypes = new Set(['discover', 'presence', 'offer', 'answer', 'ice', 'bye']);
const nostrContentLimit = 128 * 1024;
const nostrFreshSeconds = 120;
const nostrFutureSeconds = 30;
function nostrIsSignalMessage(nostrMessage) {
  return nostrMessage !== null && typeof nostrMessage === 'object' && !Array.isArray(nostrMessage) &&
    Object.prototype.hasOwnProperty.call(nostrMessage, 'type') && nostrSignalTypes.has(nostrMessage.type);
}

function nostrListen(nostrSocket, nostrType, nostrHandler) {
  if (typeof nostrSocket.addEventListener === 'function') {
    nostrSocket.addEventListener(nostrType, nostrHandler);
    return () => nostrSocket.removeEventListener(nostrType, nostrHandler);
  }
  const nostrProperty = `on${nostrType}`;
  nostrSocket[nostrProperty] = nostrHandler;
  return () => { if (nostrSocket[nostrProperty] === nostrHandler) nostrSocket[nostrProperty] = null; };
}

/** Public-relay discovery/SDP/ICE only. Game input and state belong on WebRTC. */
export async function createNostrSignaler({
  room,
  namespace = 'rollback-netcode',
  relays = ['wss://relay.primal.net', 'wss://relay.damus.io'],
  timeoutMs = 10000,
  onStatus = () => {},
  WebSocketImpl = globalThis.WebSocket,
  cryptoImpl = globalThis.crypto,
  signal,
  publishIntervalMs = 500,
  maxVerificationsPerSecond = 16,
  verificationBurst = 8
} = {}) {
  if (signal?.aborted) throw new Error('Nostr signaler aborted');
  if (typeof room !== 'string' || !/^\d{4}$/.test(room)) throw new TypeError('room must contain exactly four ASCII digits');
  if (typeof namespace !== 'string' || namespace.trim().length === 0 || nostrEncoder.encode(namespace).length > 128) throw new TypeError('namespace must be a nonempty string of at most 128 UTF-8 bytes');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) throw new RangeError('timeoutMs must be greater than zero and at most 120000');
  integer(publishIntervalMs, 'publishIntervalMs', 0, 10000);
  integer(maxVerificationsPerSecond,'maxVerificationsPerSecond',1,1024);
  integer(verificationBurst,'verificationBurst',1,32);
  if (typeof WebSocketImpl !== 'function') throw new Error('Nostr signaling requires WebSocket support');
  if (typeof onStatus !== 'function') throw new TypeError('onStatus must be a function');
  nostrRequireCrypto(cryptoImpl, true);
  if (!Array.isArray(relays) || relays.length === 0 || relays.length > 16) throw new TypeError('relays must contain between 1 and 16 WebSocket URLs');
  const nostrUrls = [...new Set(relays.map(nostrRelay => {
    if (typeof nostrRelay !== 'string') throw new TypeError('Relay URLs must be strings');
    const nostrUrl = new URL(nostrRelay);
    if (!['ws:', 'wss:'].includes(nostrUrl.protocol) || nostrUrl.username || nostrUrl.password || nostrUrl.hash) throw new TypeError('Relays must be ws:// or wss:// URLs without credentials or fragments');
    return nostrUrl.href;
  }))];
  const nostrRandom = nostrLength => cryptoImpl.getRandomValues(new Uint8Array(nostrLength));
  const nostrSecret = new Uint8Array(32);
  let nostrSecretReady = false;
  for (let nostrAttempt = 0; nostrAttempt < 16; nostrAttempt++) {
    nostrSecret.set(nostrRandom(32));
    const nostrValue = nostrBytesToNumber(nostrSecret);
    if (nostrValue > 0n && nostrValue < nostrOrder) { nostrSecretReady = true; break; }
  }
  if (!nostrSecretReady) { nostrSecret.fill(0); throw new Error('Secure random secret generation failed'); }
  const nostrId = nostrToHex(nostrPublicKey(nostrSecret));
  const nostrRoomTag = `${namespace}:${room}`;
  const nostrSubscription = `rn-${nostrToHex(nostrRandom(16))}`;
  const nostrListeners = new Set();
  const nostrBacklog = [];
  const nostrSeen = new Map();
  const nostrVerifying = new Set();
  const nostrPending = new Map();
  const nostrStates = [];
  let verificationTokens=verificationBurst,verificationAt=nowMs();
  const verificationMetrics={attempted:0,verified:0,throttled:0,totalVerificationMs:0,maxVerificationMs:0};
  let nostrClosed = false;
  let nostrSending = 0;
  let nostrSendTail = Promise.resolve(), nostrLastPublication = -Infinity;
  const nostrWaiters = new Map();
  let nostrHasSubscriber = false;
  let nostrReadyResolve;
  let nostrReadyReject;
  let nostrInitializationSettled = false;
  const nostrReady = new Promise((nostrResolve, nostrReject) => { nostrReadyResolve = nostrResolve; nostrReadyReject = nostrReject; });
  const nostrStatus = (nostrStatusName, nostrRelay, nostrMessage) => {
    if (nostrClosed && nostrStatusName !== 'closed') return;
    try { onStatus({type: 'signaler', transport: 'nostr', status: nostrStatusName, ...(nostrRelay ? {relay: nostrRelay} : {}), ...(nostrMessage ? {message: String(nostrMessage)} : {})}); } catch { /* An observer cannot break signaling. */ }
  };

  function nostrFinishPublication(nostrEventId, nostrError) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication) return;
    clearTimeout(nostrPublication.timer);
    nostrPending.delete(nostrEventId);
    if (nostrError) nostrPublication.reject(nostrError);
    else nostrPublication.resolve();
  }

  function nostrPublicationFailure(nostrState, nostrEventId, nostrReason) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication || !nostrPublication.remaining.delete(nostrState)) return;
    nostrPublication.failures.push(`${nostrState.url}: ${nostrReason}`);
    if (nostrPublication.remaining.size === 0 && !nostrStates.some(nostrRelay => !nostrRelay.failed && !nostrRelay.ready)) nostrFinishPublication(nostrEventId,
      new Error(`No Nostr relay accepted the event: ${nostrPublication.failures.join('; ')}`));
  }

  function nostrFailRelay(nostrState, nostrReason) {
    if (nostrState.failed || nostrClosed) return;
    nostrState.failed = true;
    nostrState.ready = false;
    clearTimeout(nostrState.timer);
    for (const nostrRemove of nostrState.remove) nostrRemove();
    try { nostrState.socket?.close(); } catch { /* Already closed. */ }
    for (const nostrEventId of nostrPending.keys()) nostrPublicationFailure(nostrState, nostrEventId, nostrReason);
    nostrStatus('error', nostrState.url, nostrReason);
    if (!nostrInitializationSettled && nostrStates.length === nostrUrls.length && nostrStates.every(nostrRelay => nostrRelay.failed)) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error(`No Nostr relay became ready: ${nostrReason}`));
    }
  }

  function nostrDeliver(nostrEnvelope) {
    if (nostrClosed) return;
    if (!nostrHasSubscriber) {
      if (nostrBacklog.length === 32) nostrBacklog.shift();
      nostrBacklog.push(nostrEnvelope);
      return;
    }
    for (const nostrHandler of [...nostrListeners]) {
      if (nostrClosed) break;
      try {
        const nostrResult = nostrHandler(nostrEnvelope);
        if (nostrResult && typeof nostrResult.then === 'function') Promise.resolve(nostrResult).catch(nostrError => nostrStatus('error', null, nostrError?.message || 'Signaling subscriber failed'));
      } catch (nostrError) { nostrStatus('error', null, nostrError?.message || 'Signaling subscriber failed'); }
    }
  }

  async function nostrReceive(nostrEvent) {
    if (nostrClosed || !nostrEvent || typeof nostrEvent !== 'object' || Array.isArray(nostrEvent) ||
        typeof nostrEvent.id !== 'string' || typeof nostrEvent.pubkey !== 'string' || typeof nostrEvent.sig !== 'string' ||
        !nostrHex32.test(nostrEvent.id) || !nostrHex32.test(nostrEvent.pubkey) || !nostrHex64.test(nostrEvent.sig) ||
        nostrEvent.pubkey === nostrId || nostrEvent.kind !== 20078 || !Number.isSafeInteger(nostrEvent.created_at) ||
        typeof nostrEvent.content !== 'string' || nostrEvent.content.length > nostrContentLimit ||
        !Array.isArray(nostrEvent.tags) || nostrEvent.tags.length > 16 || nostrVerifying.size >= 32) return;
    const nostrNow = Date.now();
    const nostrNowSeconds = Math.floor(nostrNow / 1000);
    if (nostrEvent.created_at < nostrNowSeconds - nostrFreshSeconds || nostrEvent.created_at > nostrNowSeconds + nostrFutureSeconds ||
        nostrEncoder.encode(nostrEvent.content).length > nostrContentLimit) return;
    for (const [nostrSeenId, nostrExpiry] of nostrSeen) { if (nostrExpiry > nostrNow) break; nostrSeen.delete(nostrSeenId); }
    if (nostrSeen.has(nostrEvent.id) || nostrVerifying.has(nostrEvent.id)) return;
    if (!nostrEvent.tags.every(nostrTag => Array.isArray(nostrTag) && nostrTag.length > 0 && nostrTag.length <= 4 &&
        nostrTag.every(nostrValue => typeof nostrValue === 'string' && nostrEncoder.encode(nostrValue).length <= 256))) return;
    const nostrRoomTags = nostrEvent.tags.filter(nostrTag => nostrTag[0] === 'd');
    const nostrRecipientTags = nostrEvent.tags.filter(nostrTag => nostrTag[0] === 'p');
    if (nostrRoomTags.length !== 1 || nostrRoomTags[0][1] !== nostrRoomTag) return;
    let nostrContent;
    try { nostrContent = JSON.parse(nostrEvent.content); } catch { return; }
    if (!nostrContent || nostrContent.v !== 1 || nostrContent.namespace !== namespace || nostrContent.room !== room ||
        nostrContent.from !== nostrEvent.pubkey || typeof nostrContent.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(nostrContent.nonce) ||
        (nostrContent.to !== '*' && nostrContent.to !== nostrId) || !nostrIsSignalMessage(nostrContent.message)) return;
    if (nostrContent.to === '*' ? nostrRecipientTags.length !== 0 :
        nostrRecipientTags.length !== 1 || nostrRecipientTags[0][1] !== nostrContent.to) return;
    const measuredNow=nowMs();
    verificationTokens=Math.min(verificationBurst,verificationTokens+Math.max(0,measuredNow-verificationAt)*maxVerificationsPerSecond/1000);verificationAt=measuredNow;
    if(verificationTokens<1){verificationMetrics.throttled++;return}
    verificationTokens--;verificationMetrics.attempted++;
    nostrVerifying.add(nostrEvent.id);
    try {
      const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content])), cryptoImpl);
      if (nostrToHex(nostrHashBytes) !== nostrEvent.id || !await nostrVerify(nostrFromHex(nostrEvent.sig), nostrHashBytes, nostrFromHex(nostrEvent.pubkey), cryptoImpl) || nostrClosed) return;
      if (nostrSeen.size >= 2048) nostrSeen.delete(nostrSeen.keys().next().value);
      nostrSeen.set(nostrEvent.id, nostrNow + 300000);
      verificationMetrics.verified++;nostrDeliver({from: nostrContent.from, to: nostrContent.to, message: nostrContent.message});
    } catch (nostrError) { nostrStatus('error', null, nostrError?.message || 'Nostr verification failed'); }
    finally { nostrVerifying.delete(nostrEvent.id);const elapsed=nowMs()-measuredNow;verificationMetrics.totalVerificationMs+=elapsed;verificationMetrics.maxVerificationMs=Math.max(verificationMetrics.maxVerificationMs,elapsed); }
  }

  function nostrHandleMessage(nostrState, nostrData) {
    if (nostrClosed || nostrState.failed || typeof nostrData !== 'string' || nostrData.length > 1024 * 1024) return;
    let nostrFrame;
    try { nostrFrame = JSON.parse(nostrData); } catch { return; }
    if (!Array.isArray(nostrFrame)) return;
    if (nostrFrame[0] === 'EOSE' && nostrFrame.length === 2 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      if (nostrState.ready) return;
      nostrState.ready = true;
      clearTimeout(nostrState.timer);
      nostrStatus('connected', nostrState.url);
      if (!nostrInitializationSettled) { nostrInitializationSettled = true; nostrReadyResolve(); }
      // A fast relay can reject a publication while a fallback is still opening.
      // Forward the same signed event when that fallback becomes ready.
      for (const nostrPublication of nostrPending.values()) if (!nostrPublication.attempted.has(nostrState)) {
        nostrPublication.attempted.add(nostrState); nostrPublication.remaining.add(nostrState);
        try { nostrState.socket.send(nostrPublication.frame); }
        catch (nostrError) { nostrFailRelay(nostrState, nostrError?.message || 'Fallback publication failed'); }
      }
    } else if (nostrFrame[0] === 'EVENT' && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      void nostrReceive(nostrFrame[2]);
    } else if (nostrFrame[0] === 'OK' && nostrFrame.length === 4 && typeof nostrFrame[1] === 'string' &&
        typeof nostrFrame[2] === 'boolean' && typeof nostrFrame[3] === 'string') {
      const nostrPublication = nostrPending.get(nostrFrame[1]);
      if (!nostrPublication?.remaining.has(nostrState)) return;
      if (nostrFrame[2]) { nostrFinishPublication(nostrFrame[1]); nostrStatus('published', nostrState.url); }
      else nostrFailRelay(nostrState, nostrFrame[3].slice(0, 256) || 'Relay rejected the event');
    } else if (nostrFrame[0] === 'CLOSED' && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && typeof nostrFrame[2] === 'string') {
      nostrFailRelay(nostrState, `Relay ended the signaling subscription: ${nostrFrame[2].slice(0, 256)}`);
    } else if (nostrFrame[0] === 'NOTICE' && typeof nostrFrame[1] === 'string') {
      nostrStatus('notice', nostrState.url, nostrFrame[1].slice(0, 256));
    }
  }

  function nostrClose() {
    if (nostrClosed) return;
    nostrClosed = true;
    signal?.removeEventListener('abort', nostrClose);
    for (const [nostrTimer, nostrReject] of nostrWaiters) { clearTimeout(nostrTimer); nostrReject(new Error('Nostr signaler closed')); }
    nostrWaiters.clear();
    for (const nostrState of nostrStates) {
      clearTimeout(nostrState.timer);
      if (nostrState.socket?.readyState === 1 && nostrState.requested) {
        try { nostrState.socket.send(JSON.stringify(['CLOSE', nostrSubscription])); } catch { /* Best-effort unsubscribe. */ }
      }
      for (const nostrRemove of nostrState.remove) nostrRemove();
      try { nostrState.socket?.close(); } catch { /* Already closed. */ }
      nostrState.ready = false;
    }
    for (const nostrEventId of nostrPending.keys()) nostrFinishPublication(nostrEventId, new Error('Nostr signaler closed'));
    if (!nostrInitializationSettled) { nostrInitializationSettled = true; nostrReadyReject(new Error('Nostr signaler closed')); }
    nostrSecret.fill(0);
    nostrListeners.clear();
    nostrBacklog.length = 0;
    nostrSeen.clear();
    nostrVerifying.clear();
    nostrStatus('closed');
  }

  signal?.addEventListener('abort', nostrClose, { once: true });
  for (const nostrUrl of nostrUrls) {
    if (nostrClosed) break;
    const nostrState = {url: nostrUrl, socket: null, ready: false, requested: false, failed: false, remove: [], timer: null};
    nostrStates.push(nostrState);
    nostrStatus('connecting', nostrUrl);
    if (nostrClosed) break;
    try {
      const nostrSocket = nostrState.socket = new WebSocketImpl(nostrUrl);
      if (nostrClosed) { try { nostrSocket.close(); } catch { /* Already closed. */ } break; }
      nostrState.timer = setTimeout(() => nostrFailRelay(nostrState, 'Nostr connection/subscription timed out'), timeoutMs);
      const nostrOpen = () => {
        if (nostrClosed || nostrState.failed || nostrState.requested) return;
        nostrState.requested = true;
        try { nostrSocket.send(JSON.stringify(['REQ', nostrSubscription, {kinds: [20078], '#d': [nostrRoomTag], since: Math.floor(Date.now() / 1000) - nostrFreshSeconds, limit: 0}])); }
        catch (nostrError) { nostrFailRelay(nostrState, nostrError?.message || 'Nostr subscription failed'); }
      };
      nostrState.remove.push(
        nostrListen(nostrSocket, 'open', nostrOpen),
        nostrListen(nostrSocket, 'message', nostrEvent => nostrHandleMessage(nostrState, nostrEvent.data)),
        nostrListen(nostrSocket, 'error', () => nostrFailRelay(nostrState, 'Nostr WebSocket error')),
        nostrListen(nostrSocket, 'close', () => nostrFailRelay(nostrState, 'Nostr relay disconnected'))
      );
      if (nostrSocket.readyState === 1) nostrOpen();
    } catch (nostrError) { nostrFailRelay(nostrState, nostrError?.message || 'Nostr connection failed'); }
  }
  try { await nostrReady; } catch (nostrError) { nostrClose(); throw nostrError; }

  return {
    id: nostrId,
    room,
    get metrics(){return {...verificationMetrics}},
    async send(nostrTo, nostrMessage) {
      if (nostrClosed) throw new Error('Nostr signaler closed');
      if (nostrTo !== '*' && (typeof nostrTo !== 'string' || !nostrHex32.test(nostrTo))) throw new TypeError('Nostr recipient must be a lowercase public key or *');
      if (!nostrIsSignalMessage(nostrMessage)) throw new TypeError('Nostr carries discovery, presence, offer, answer, ice and bye signaling only');
      if (nostrSending >= 64) throw new Error('Too many pending Nostr publications');
      if (!nostrStates.some(nostrState => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1)) throw new Error('No live Nostr relays');
      nostrSending++;
      const nostrPrevious = nostrSendTail;
      let nostrUnlock;
      nostrSendTail = new Promise(nostrResolve => { nostrUnlock = nostrResolve; });
      try {
        let nostrContent;
        try { nostrContent = JSON.stringify({v: 1, namespace, room, from: nostrId, to: nostrTo, nonce: nostrToHex(nostrRandom(16)), message: nostrMessage}); }
        catch { throw new TypeError('Nostr signaling message must be JSON serializable'); }
        if (nostrEncoder.encode(nostrContent).length > nostrContentLimit) throw new RangeError('Nostr signaling content exceeds 128 KiB');
        if (!nostrIsSignalMessage(JSON.parse(nostrContent).message)) throw new TypeError('Nostr signaling message serialization changed its type');
        await nostrPrevious;
        if (nostrClosed) throw new Error('Nostr signaler closed');
        const nostrWait = publishIntervalMs - (Date.now() - nostrLastPublication);
        if (nostrWait > 0) await new Promise((nostrResolve, nostrReject) => {
          const nostrTimer = setTimeout(() => { nostrWaiters.delete(nostrTimer); nostrResolve(); }, nostrWait);
          nostrWaiters.set(nostrTimer, nostrReject);
        });
        if (nostrClosed) throw new Error('Nostr signaler closed');
        const nostrEvent = {pubkey: nostrId, created_at: Math.floor(Date.now() / 1000), kind: 20078,
          tags: [['d', nostrRoomTag], ...(nostrTo === '*' ? [] : [['p', nostrTo]])], content: nostrContent};
        const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrId, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrContent])), cryptoImpl);
        if (nostrClosed) throw new Error('Nostr signaler closed');
        const nostrAuxiliary = nostrRandom(32);
        try { nostrEvent.sig = nostrToHex(await nostrSign(nostrHashBytes, nostrSecret, nostrAuxiliary, cryptoImpl)); }
        finally { nostrAuxiliary.fill(0); }
        nostrEvent.id = nostrToHex(nostrHashBytes);
        if (nostrClosed) throw new Error('Nostr signaler closed');
        const nostrAvailable = nostrStates.filter(nostrState => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1);
        if (nostrAvailable.length === 0) throw new Error('No live Nostr relays');
        const nostrFrame = JSON.stringify(['EVENT', nostrEvent]);
        nostrLastPublication = Date.now();
        await new Promise((nostrResolve, nostrReject) => {
          const nostrPublication = {resolve: nostrResolve, reject: nostrReject, remaining: new Set(nostrAvailable),
            attempted: new Set(nostrAvailable), frame: nostrFrame, failures: [], timer: null};
          nostrPending.set(nostrEvent.id, nostrPublication);
          nostrPublication.timer = setTimeout(() => nostrFinishPublication(nostrEvent.id, new Error('Nostr publication timed out without a positive relay OK')), timeoutMs);
          for (const nostrState of nostrAvailable) {
            if (nostrClosed) break;
            try { nostrState.socket.send(nostrFrame); }
            catch (nostrError) { nostrFailRelay(nostrState, nostrError?.message || 'Nostr publication failed'); }
          }
        });
      } finally { await nostrPrevious; nostrSending--; nostrUnlock(); }
    },
    subscribe(nostrHandler) {
      if (nostrClosed) throw new Error('Nostr signaler closed');
      if (typeof nostrHandler !== 'function') throw new TypeError('Signaling subscriber must be a function');
      nostrListeners.add(nostrHandler);
      if (!nostrHasSubscriber) {
        nostrHasSubscriber = true;
        const nostrQueued = nostrBacklog.splice(0);
        for (const nostrEnvelope of nostrQueued) nostrDeliver(nostrEnvelope);
      }
      return () => nostrListeners.delete(nostrHandler);
    },
    close: nostrClose
  };
}
