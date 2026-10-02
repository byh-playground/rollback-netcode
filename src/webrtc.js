import { CHUNK_SIZE, TYPE, HEADER } from './protocol.js';
import { integer, bytes } from './utilities.js';
/** Transport capability adapter. Channel reliability is independent of ordering. */
export class WebRTCTransport {
  constructor({ inputChannel, controlChannel, highWaterMark = 262144, lowWaterMark = 65536 } = {}) {
    if (!controlChannel || typeof controlChannel.send !== 'function') throw new TypeError('controlChannel');
    integer(highWaterMark, 'highWaterMark', CHUNK_SIZE, 16 * 1024 * 1024);
    integer(lowWaterMark, 'lowWaterMark', 0, highWaterMark);
    this.inputChannel = inputChannel ?? controlChannel; this.controlChannel = controlChannel;
    this.highWaterMark = highWaterMark; this.listeners = new Set(); this.statusListeners = new Set(); this.closed = false;
    this.connectionState='connected';this._lastStatus=null;
    this.channels = [...new Set([this.inputChannel, this.controlChannel])];
    this._onMessage = async event => {
      if (this.closed) return;
      let data = event.data;
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        if (data.size > CHUNK_SIZE) return;
        data = await data.arrayBuffer();
      }
      if (this.closed) return;
      try {
        const b = bytes(data);
        if (b.length > CHUNK_SIZE) return;
        for (const listener of this.listeners) listener(b.slice());
      } catch { /* Malformed external messages are not JS evaluation. */ }
    };
    for (const channel of this.channels) {
      channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = lowWaterMark;
      channel.addEventListener('message', this._onMessage);
      channel.addEventListener('open',this._onStatus= this._onStatus??(()=>this._notifyStatus()));
      channel.addEventListener('close',this._onStatus);
      channel.addEventListener('error',this._onChannelError=this._onChannelError??(()=>{this.connectionState='failed';this._notifyStatus()}));
    }
  }
  get state(){
    if(this.closed||this.connectionState==='closed'||this.channels.some(c=>c.readyState==='closed'||c.readyState==='closing'))return 'closed';
    if(this.connectionState==='failed')return 'failed';
    if(this.connectionState==='disconnected')return 'interrupted';
    return this.channels.every(c=>c.readyState==='open')?'open':'connecting';
  }
  _notifyStatus(){const state=this.state;if(state===this._lastStatus)return;this._lastStatus=state;for(const listener of this.statusListeners){try{listener(state)}catch{}}}
  setConnectionState(state){this.connectionState=state;this._notifyStatus()}
  subscribeStatus(listener){if(typeof listener!=='function')throw new TypeError('status subscriber');this.statusListeners.add(listener);return()=>this.statusListeners.delete(listener)}
  get bufferedAmount() { return this.channels.reduce((n, c) => n + c.bufferedAmount, 0); }
  send(data) {
    const b = bytes(data);
    if (b.length > CHUNK_SIZE) throw new RangeError('DataChannel chunk size');
    const type = b.length >= HEADER ? b[5] : 0;
    const channel = type === TYPE.INPUT || type === TYPE.CLOCK ? this.inputChannel : this.controlChannel;
    if (this.closed || channel.readyState !== 'open' || this.bufferedAmount + b.length > this.highWaterMark) return false;
    try { channel.send(b); return true; }
    catch (error) { if (error.name === 'OperationError' || error.name === 'InvalidStateError') return false; throw error; }
  }
  subscribe(handler) {
    if (this.closed || typeof handler !== 'function') throw new TypeError('transport subscriber');
    this.listeners.add(handler); return () => this.listeners.delete(handler);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._notifyStatus();
    for (const channel of this.channels) { channel.removeEventListener('message', this._onMessage);channel.removeEventListener('open',this._onStatus);channel.removeEventListener('close',this._onStatus);channel.removeEventListener('error',this._onChannelError);channel.close(); }
    this.listeners.clear();this.statusListeners.clear();
  }
}

const DEFAULT_ICE = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]);
/** Signaler is-a routing adapter: send(to,message), subscribe(handler), id. */
export function createWebRTCPeer({ initiator = false, signaler, remoteId,
  rtcConfig = { iceServers: DEFAULT_ICE }, timeoutMs = 20000,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection, onStatus = () => {}, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('connection aborted'));
  if (typeof RTCPeerConnectionImpl !== 'function' || typeof signaler?.send !== 'function' || typeof signaler.subscribe !== 'function' || !remoteId) return Promise.reject(new TypeError('WebRTC and Signaler capabilities required'));
  // Explicit opt-in is required for caller supplied TURN; defaults contain STUN only.
  let pc;
  try { integer(timeoutMs, 'timeoutMs', 1, 120000); pc = new RTCPeerConnectionImpl(rtcConfig); }
  catch (error) { return Promise.reject(error); }
  let inputChannel, controlChannel, transport, unsubscribe, timer, disposed = false, settled = false;
  let chain = Promise.resolve(); const earlyIce = [], iceBatch = []; let iceTimer;
  const status = value => { try { onStatus(value); } catch { /* Observer only. */ } };
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  const close = () => {
    if (disposed) return;
    disposed = true; clearTimeout(timer); clearTimeout(iceTimer); unsubscribe?.(); signal?.removeEventListener('abort', close); transport?.close(); pc.close();
    if (!settled) { settled = true; reject(new Error('WebRTC connection closed')); }
  };
  const fail = error => { status({ type: 'connection-error', error }); if (!settled) { settled = true; reject(error); } close(); };
  signal?.addEventListener('abort', close, { once: true });
  const send = message => Promise.resolve(signaler.send(remoteId, message));
  const maybeReady = () => {
    if (disposed || settled || inputChannel?.readyState !== 'open' || controlChannel?.readyState !== 'open') return;
    clearTimeout(timer); settled = true; transport = new WebRTCTransport({ inputChannel, controlChannel });
    status({ type: 'connected' }); resolve({ transport, peerConnection: pc, close });
  };
  const channel = value => {
    if (value.label === 'inputs' && !inputChannel) inputChannel = value;
    else if (value.label === 'control' && !controlChannel) controlChannel = value;
    else { value.close(); return; }
    value.addEventListener('open', maybeReady); maybeReady();
  };
  pc.addEventListener('datachannel', event => channel(event.channel));
  const flushCandidates = () => {
    clearTimeout(iceTimer);
    if (disposed || !iceBatch.length) return;
    send({ type: 'ice', candidates: iceBatch.splice(0) }).catch(fail);
  };
  pc.addEventListener('icecandidate', event => {
    if (disposed) return;
    if (event.candidate) {
      if (iceBatch.length >= 128) { fail(new RangeError('ICE candidate batch capacity')); return; }
      iceBatch.push(event.candidate.toJSON()); clearTimeout(iceTimer); iceTimer = setTimeout(flushCandidates, 100);
    } else flushCandidates();
  });
  pc.addEventListener('connectionstatechange', () => {
    transport?.setConnectionState(pc.connectionState);
    status({ type: 'connection-state', state: pc.connectionState });
    if (pc.connectionState === 'failed') fail(new Error('P2P connection failed; no automatic TURN fallback'));
  });
  const flushIce = async () => { while (earlyIce.length) await pc.addIceCandidate(earlyIce.shift()); };
  unsubscribe = signaler.subscribe(event => {
    if (disposed || event.from !== remoteId || event.to !== signaler.id && event.to !== '*') return;
    const message = event.message;
    chain = chain.then(async () => {
      if (disposed) return;
      if (message?.type === 'offer' && !initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description); await flushIce();
        await pc.setLocalDescription(await pc.createAnswer());
        await send({ type: 'answer', description: pc.localDescription.toJSON() });
      } else if (message?.type === 'answer' && initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description); await flushIce();
      } else if (message?.type === 'ice') {
        const candidates = message.candidates ?? (message.candidate ? [message.candidate] : []);
        if (!Array.isArray(candidates) || candidates.length > 128) throw new RangeError('ICE candidate batch');
        for (const candidate of candidates) {
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else if (earlyIce.length < 128) earlyIce.push(candidate);
          else throw new RangeError('ICE queue capacity');
        }
      } else if (message?.type === 'bye') close();
    }).catch(fail);
  });
  timer = setTimeout(() => fail(new Error('P2P connection timeout')), integer(timeoutMs, 'timeoutMs', 1, 120000));
  if (initiator) {
    channel(pc.createDataChannel('inputs', { ordered: false, maxRetransmits: 0 }));
    channel(pc.createDataChannel('control', { ordered: true }));
    chain = chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await send({ type: 'offer', description: pc.localDescription.toJSON() });
    }).catch(fail);
  }
  return result;
}
