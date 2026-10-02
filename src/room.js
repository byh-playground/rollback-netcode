import { PROTOCOL_VERSION } from './protocol.js';
import { integer } from './utilities.js';
import { createWebRTCPeer } from './webrtc.js';
import { createNostrSignaler } from './nostr.js';
/** Two-player room discovery is an optional capability, separate from the fixed-roster core. */
export async function createNostrRoom({ role, room, namespace = 'rollback-netcode', relays,
  rtcConfig, timeoutMs = 30000, onStatus = () => {}, signal,
  signalerFactory = createNostrSignaler, peerFactory = createWebRTCPeer } = {}) {
  if (!['host', 'join'].includes(role)) throw new TypeError('room role');
  integer(timeoutMs, 'timeoutMs', 1, 120000);
  if (typeof signalerFactory !== 'function' || typeof peerFactory !== 'function') throw new TypeError('room adapter factories');
  if (signal?.aborted) throw new Error('room aborted');
  if (!room && role === 'host') {
    const value = new Uint32Array(1); globalThis.crypto.getRandomValues(value);
    room = String(value[0] % 10000).padStart(4, '0');
  }
  if (!/^\d{4}$/.test(room ?? '')) throw new TypeError('four-digit room');
  const controller = new AbortController();
  const externalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', externalAbort, { once: true });
  const roomSignal = controller.signal;
  let signaler;
  try { signaler = await signalerFactory({ room, namespace, relays,
    timeoutMs: Math.min(timeoutMs, 10000), onStatus, signal: roomSignal }); }
  catch (error) { signal?.removeEventListener('abort', externalAbort); throw error; }
  if (roomSignal.aborted) { signaler.close(); signal?.removeEventListener('abort', externalAbort); throw new Error('room aborted'); }
  return new Promise((resolve, reject) => {
    let connection, unsubscribe, pulse, deadline, collisionTimer;
    let disposed = false, connecting = false, completed = false, selectedPeer, checking = role === 'host';
    const nonce = new Uint8Array(16); globalThis.crypto.getRandomValues(nonce);
    let sessionId = [...nonce].map(n => n.toString(16).padStart(2, '0')).join('');
    const status = value => { try { onStatus(value); } catch { /* Presentation observer. */ } };
    const close = () => {
      if (disposed) return;
      disposed = true; clearInterval(pulse); clearTimeout(deadline); clearTimeout(collisionTimer);
      unsubscribe?.(); roomSignal.removeEventListener('abort', abort);
      signal?.removeEventListener('abort', externalAbort); controller.abort(); connection?.close(); signaler.close();
    };
    const fail = error => { if (!completed) { completed = true; reject(error); } close(); };
    const abort = () => fail(new Error('room aborted'));
    roomSignal.addEventListener('abort', abort, { once: true });
    const send = (to, message) => signaler.send(to, message).catch(fail);
    const presence = to => send(to, { type: 'presence', room, namespace, host: signaler.id, sessionId, protocol: PROTOCOL_VERSION });
    const connect = remoteId => {
      if (connecting || disposed) return;
      connecting = true; selectedPeer = remoteId;
      Promise.resolve().then(() => peerFactory({ initiator: role === 'join', signaler, remoteId, rtcConfig,
        timeoutMs: Math.min(timeoutMs, 20000), onStatus, signal: roomSignal })).then(value => {
        if (disposed) { value.close(); return; }
        connection = value; completed = true; clearInterval(pulse); clearTimeout(deadline); clearTimeout(collisionTimer);
        unsubscribe?.();
        resolve({ room, sessionId, localPlayerId: role === 'host' ? 'a' : 'b',
          remotePlayerId: role === 'host' ? 'b' : 'a', transport: value.transport,
          peerConnection: value.peerConnection, close });
      }).catch(fail);
    };
    unsubscribe = signaler.subscribe(({ from, to, message }) => {
      if (disposed || from === signaler.id) return;
      if (role === 'host') {
        if (message.type === 'presence' && message.host === from && message.protocol === PROTOCOL_VERSION) {
          fail(new Error('room code is already in use; choose another four-digit code')); return;
        }
        if (message.type === 'discover' && !checking && (!selectedPeer || selectedPeer === from)) {
          // Install the answer subscription before advertising to this joiner.
          connect(from); presence(from);
        }
      } else if (message.type === 'presence' && message.host === from && message.protocol === PROTOCOL_VERSION && typeof message.sessionId === 'string') {
        if (selectedPeer && selectedPeer !== from) return;
        selectedPeer = from;
        if (to === signaler.id) { sessionId = message.sessionId; connect(from); }
        else send(from, { type: 'discover' });
      }
    });
    if (disposed) { unsubscribe?.(); return; }
    deadline = setTimeout(() => fail(new Error('room discovery timeout')), timeoutMs);
    const advertise = () => {
      if (disposed || connecting || checking) return;
      if (role === 'host') presence('*'); else send(selectedPeer ?? '*', { type: 'discover' });
    };
    pulse = setInterval(advertise, 1000);
    status({ type: 'room', room, role });
    if (disposed) return;
    if (checking) collisionTimer = setTimeout(() => { checking = false; advertise(); }, 1200);
    else advertise();
  });
}
