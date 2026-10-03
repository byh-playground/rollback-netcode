import { VERSION, PROTOCOL_VERSION, CHUNK_SIZE, MAX_TICK, defaults, profiles, encoder, decoder, MAGIC, TYPE, HEADER, SNAP_CHUNK_BYTES, Writer, Reader, packet, frameEqual, copyFrame, runSimulationFrame } from './protocol.js';
import { nowMs, compareIds, integer, bytes, equalBytes, hashBytes } from './utilities.js';
function profileOf(profile) {
  const p = { ...defaults, ...profile };
  for (const field of ['tickRate', 'stateHistorySize', 'checksumInterval', 'resimulationBudget', 'maxCatchupSteps',
    'heartbeatMs', 'adaptationIntervalMs', 'maxSnapshotBytes', 'maxHistoryBytes', 'maxReplayBytes', 'maxCommandBytes',
    'maxPendingCommands', 'maxQueuedBytes', 'recoveryTimeoutMs', 'maxRecoveryAttempts', 'peerInterruptMs', 'peerTimeoutMs']) integer(p[field], field, 1, 0x7fffffff);
  for (const field of ['baseInputDelayTicks', 'minInputDelayTicks', 'maxInputDelayTicks', 'rollbackWindowTicks', 'tickDriftThreshold']) integer(p[field], field, 0, 65535);
  if (p.minInputDelayTicks > p.baseInputDelayTicks || p.baseInputDelayTicks > p.maxInputDelayTicks) throw new RangeError('input delay bounds');
  if (p.peerTimeoutMs <= p.peerInterruptMs) throw new RangeError('peerTimeoutMs must exceed peerInterruptMs');
  if (p.stateHistorySize < p.rollbackWindowTicks + 2) throw new RangeError('stateHistorySize must exceed rollback window by two');
  if (p.stateHistorySize > 8192) throw new RangeError('stateHistorySize capacity (8192)');
  if (p.tickRate > 240 || p.maxCommandBytes > CHUNK_SIZE - 1024 || p.maxSnapshotBytes > 64 * 1024 * 1024) throw new RangeError('profile size limit');
  if (!['hold', 'neutral'].includes(p.predictionPolicy) && typeof p.predictionPolicy !== 'function') throw new TypeError('predictionPolicy');
  if (!['none', 'hold', 'dilation'].includes(p.pacingPolicy) || p.stallPolicy !== 'wait') throw new TypeError('pacing/stall policy');
  return Object.freeze(p);
}
export class StateHistory {
  constructor(size, maxBytes = 64 * 1024 * 1024) { this.slots = new Array(size); this.size = size; this.maxBytes = maxBytes; this.byteLength = 0; }
  get(tick) { const s = this.slots[tick % this.size]; return s?.tick === tick ? s : undefined; }
  put(state) {
    const i = state.tick % this.size, next = this.byteLength - (this.slots[i]?.bytes.length ?? 0) + state.bytes.length;
    if (next > this.maxBytes) throw Object.assign(new RangeError('state history byte budget'),{code:'history-capacity',requiredBytes:next,maxHistoryBytes:this.maxBytes,snapshotBytes:state.bytes.length});
    this.slots[i] = state; this.byteLength = next;
  }
  invalidateAfter(tick) {
    for (let i = 0; i < this.size; i++) if (this.slots[i]?.tick > tick) { this.byteLength -= this.slots[i].bytes.length; this.slots[i] = undefined; }
  }
}

export function createSession(options) { return new RollbackSession(options); }
export class RollbackSession {
  constructor({ players, localPlayerId, sessionId, simulationVersion, seed = 1, inputSize,
    profile = profiles.action, adapter, authorityPlayerId, onEvent = () => {}, recordReplay = true, clock = nowMs } = {}) {
    if (!Array.isArray(players) || players.length < 1 || players.length > 8 ||
      players.some(p => typeof p !== 'string' || !p.length || p.length > 128) || new Set(players).size !== players.length) throw new TypeError('fixed player roster (1..8 unique IDs)');
    this.players = Object.freeze([...players].sort(compareIds));
    if (!this.players.includes(localPlayerId)) throw new TypeError('localPlayerId');
    if (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 128 || typeof simulationVersion !== 'string' || !simulationVersion.length || simulationVersion.length > 128) throw new TypeError('sessionId/simulationVersion');
    if (!adapter || ['save', 'load', 'step', 'validateSnapshot'].some(n => typeof adapter[n] !== 'function')) throw new TypeError('Simulation Adapter must save, load, step, validateSnapshot');
    this.localPlayerId = localPlayerId; this.sessionId = sessionId; this.simulationVersion = simulationVersion;
    this.seed = integer(seed, 'seed'); this.inputSize = integer(inputSize, 'inputSize', 1, 1024);
    if (typeof clock !== 'function') throw new TypeError('monotonic runtime clock');
    this._clock = clock;
    this.profile = profileOf(profile); this.adapter = adapter; this.onEvent = onEvent;
    this.authorityPlayerId = authorityPlayerId ?? this.players[0];
    if (!this.players.includes(this.authorityPlayerId)) throw new TypeError('authorityPlayerId');
    this._tick = 0; this._inputDelay = this.profile.baseInputDelayTicks; this._requestedInputDelay = this._inputDelay;
    this.closed = false; this._failure = null;
    this._history = new StateHistory(this.profile.stateHistorySize, this.profile.maxHistoryBytes);
    this._inputWriter = new Writer(CHUNK_SIZE * this.players.length);
    this._inputs = new Map(this.players.map(p => [p, new Map()]));
    this._through = new Map(this.players.map(p => [p, -1]));
    this._used = new Map(); this._peers = new Map(); this._pendingCommands = [];
    this._commandSequence = 0; this._sequence = 0; this._captureTick = -1;
    this._lastLocalInput = new Uint8Array(this.inputSize);
    this._rollbackFrom = Infinity; this._resimTarget = null; this._inputHash = 2166136261;
    this._lastHashTick = -1; this._nextTransfer = 0; this._recoveryAttempts = 0;
    this._incomingSnapshot = null; this._requestedRecovery = null; this._recoveryStage = null;
    this._lastAdaptation = null; this._stableWindows = 0; this._pace = 1;
    this._window = { advances: 0, received: 0, late: 0, depth: 0, rollback: 0, stall: 0, cost: 0, costSamples: 0 };
    this._metrics = { rollbacks: 0, resimulatedTicks: 0, maxRollbackDepth: 0, stalls: 0, holds: 0,
      recoveries: 0, rejectedSnapshots: 0, rejectedPackets: 0, sentBytes: 0, receivedBytes: 0,
      predictedTicks: 0, hashMismatches: 0, latestResimulationMs: 0, smoothedRTT: 0, jitter: 0,
      lateInputRate: 0, rollbackFrequency: 0, stallFrequency: 0, resimulationCostMs: 0,
      stateHashComputations:0,hashedStateBytes:0 };
    this._recordReplay = recordReplay; this._replayFrames = []; this._replayBytes = 0; this._replayFinalHash = undefined;
    const initial = this._save();
    const requiredBytes=initial.length*this.profile.stateHistorySize;
    if(requiredBytes>this.profile.maxHistoryBytes)throw Object.assign(new RangeError('initial snapshot cannot fill state history byte budget'),{code:'history-capacity',snapshotBytes:initial.length,requiredBytes,maxHistoryBytes:this.profile.maxHistoryBytes});
    this._initialState = initial.slice();
    const initialRecord={ tick: 0, bytes: initial, inputHash: this._inputHash };
    this._history.put(initialRecord);
    this._hello = encoder.encode(JSON.stringify({ protocol: PROTOCOL_VERSION, library: VERSION, sessionId,
      simulationVersion, seed, players: this.players, tickRate: this.profile.tickRate, inputSize,
      authorityPlayerId: this.authorityPlayerId, initialHash: this._stateHash(initialRecord) }));
    for (let t = 0; t < this.inputDelay; t++) this._commitLocal(t, this._lastLocalInput, []);
  }
  get tick() { return this._tick; }
  get inputDelay() { return this._inputDelay; }
  get confirmedTick() { return Math.min(...this._through.values()); }
  get resimulating() { return this._resimTarget !== null || this._rollbackFrom !== Infinity || this._recoveryStage !== null; }
  get failure() { return this._failure; }
  get requestedInputDelay() { return this._requestedInputDelay; }
  get ready() { return !this.closed && !this._failure && this.players.every(p => p === this.localPlayerId || this._peers.get(p)?.ready && this._peers.get(p).connectionState === 'connected'); }
  get status() {
    if (this.closed) return 'closed'; if (this._failure) return 'failed';
    const peers=[...this._peers.values()];
    if(peers.some(p=>p.connectionState==='disconnected'))return 'disconnected';
    if(peers.some(p=>p.connectionState==='interrupted'))return 'interrupted';
    if(!this.ready)return 'synchronizing';
    if(this._requestedRecovery||this._recoveryStage)return 'recovering';
    return this.resimulating?'resimulating':'running';
  }
  getPeerState(peerId) {
    const peer=this._peers.get(peerId);if(!peer)return undefined;
    return Object.freeze({peerId,state:peer.connectionState,handshakeComplete:peer.ready,lastReceivedAt:peer.lastReceivedAt,
      simTick:peer.tick,confirmedInputTick:peer.confirmed,ackTick:peer.ack,rtt:peer.rtt,jitter:peer.jitter});
  }
  get metrics() { return { ...this._metrics, inputDelay: this.inputDelay, requestedInputDelay:this.requestedInputDelay,
    confirmedTick: this.confirmedTick, tick: this.tick, pace: this._pace,retainedSnapshotBytes:this._history.byteLength }; }
  _stateHash(state) {
    if(!state)return undefined;
    if(state.hash===undefined){state.hash=hashBytes(state.bytes);this._metrics.stateHashComputations++;this._metrics.hashedStateBytes+=state.bytes.length}
    return state.hash;
  }
  _hashInputFrame(tick,inputs,previousHash){
    const w=this._inputWriter.reset();w.u32(tick);
    for(const f of inputs){w.raw(f.input);w.u16(f.commands.length);for(const c of f.commands){w.u32(c.sequence);w.u16(c.payload.length);w.raw(c.payload)}}
    return hashBytes(w.usedBytes(),previousHash);
  }
  _event(type, detail = {}) { try { this.onEvent({ type, tick: this.tick, ...detail }); } catch { /* Observers cannot change the protocol. */ } }
  _fail(type, detail={}) {
    if(this._failure||this.closed)return;
    this._failure=Object.freeze({type,...detail});this._event(type,detail);
  }
  _peerTransition(peer,state,type,detail={}) {
    if(peer.connectionState===state)return;
    const previous=peer.connectionState;peer.connectionState=state;
    if(type)this._event(type,{peerId:peer.id,previous,state,...detail});
  }
  _transportStatus(peer,state) {
    const value=typeof state==='string'?state:state?.state;
    peer.transportState=value;
    if(value==='closed'||value==='failed')this._peerTransition(peer,'disconnected','peer-disconnected',{reason:'transport-'+value});
    else if(value==='interrupted')this._peerTransition(peer,'interrupted','peer-interrupted',{reason:'transport-interrupted'});
    // An open channel still needs a fresh, valid protocol packet to resume.
  }
  _peerAlive(peer,sequence,now) {
    if(['closed','failed'].includes(peer.transportState))return;
    const delta=peer.lastReceivedSequence===null?1:(sequence-peer.lastReceivedSequence)>>>0;
    if(delta===0||delta>=0x80000000)return;
    peer.lastReceivedSequence=sequence;peer.lastReceivedAt=now;
    this._peerTransition(peer,'connected',peer.connectionState==='connecting'?null:'peer-resumed');
  }
  _peerLiveness(peer,now) {
    if(['closed','failed'].includes(peer.transportState))return;
    const silence=Math.max(0,now-peer.lastReceivedAt);
    if(silence>=this.profile.peerTimeoutMs)this._peerTransition(peer,'disconnected','peer-timeout',{silenceMs:silence});
    else if(silence>=this.profile.peerInterruptMs&&peer.connectionState!=='disconnected')this._peerTransition(peer,'interrupted','peer-interrupted',{reason:'silence',silenceMs:silence});
  }
  _save() {
    const state = bytes(this.adapter.save(), 'snapshot').slice();
    if (!state.length || state.length > this.profile.maxSnapshotBytes) throw new RangeError('snapshot size');
    return state;
  }
  _nextSequence() { this._sequence = (this._sequence + 1) >>> 0; return this._sequence; }
  attachTransport(peerId, transport) {
    if (this.closed) throw new Error('session closed');
    if (this._failure) throw new Error('session failed: '+this._failure.type);
    if (peerId === this.localPlayerId || !this.players.includes(peerId) || this._peers.has(peerId)) throw new TypeError('peerId already attached or outside roster');
    if (typeof transport?.send !== 'function' || typeof transport.subscribe !== 'function') throw new TypeError('Transport capability: send and subscribe');
    const peer = { id: peerId, transport, ready: false, ack: -1, tick: 0, confirmed: -1,
      clockSequence: null, clockAt: 0, lastSent: -Infinity, lastHello: -Infinity,
      pendingPings: new Map(), echo: 0, rtt: 0, jitter: 0, hashes: new Map(),
      controls: [], queuedBytes: 0, lastHashQueued: 0, unsubscribe: null, unsubscribeStatus: null,
      connectionState:'connecting',transportState:undefined,lastReceivedAt:this._clock(),lastReceivedSequence:null };
    this._peers.set(peerId, peer);
    peer.unsubscribe = transport.subscribe(data => this.receive(peerId, data));
    peer.unsubscribeStatus=transport.subscribeStatus?.(state=>this._transportStatus(peer,state));
    if(transport.state)this._transportStatus(peer,transport.state);
    this._sendHello(peer, this._clock());
    return () => { peer.unsubscribe?.(); peer.unsubscribeStatus?.(); this._peers.delete(peerId); };
  }
  _send(peer, data) {
    try {
      if (peer.transport.send(data) === false) return false;
      this._metrics.sentBytes += data.length; return true;
    } catch (error) { this._event('transport-error', { peerId: peer.id, error }); return false; }
  }
  _sendHello(peer, now) {
    if (this._send(peer, packet(TYPE.HELLO, this._nextSequence(), w => w.raw(this._hello)))) peer.lastHello = now;
  }
  _queue(peer, data) {
    if (peer.queuedBytes + data.length > this.profile.maxQueuedBytes) return false;
    peer.controls.push(data); peer.queuedBytes += data.length; return true;
  }
  _commitLocal(tick, input, commands) {
    integer(tick, 'session tick limit', 0, MAX_TICK);
    const frame = { input: input.slice(), commands };
    if (this._inputs.get(this.localPlayerId).has(tick)) throw new Error('committed input is immutable');
    this._inputs.get(this.localPlayerId).set(tick, frame);
    this._through.set(this.localPlayerId, tick);
  }
  queueCommand(payload) {
    if (this.closed) throw new Error('session closed');
    if (this._failure) throw new Error('session failed: '+this._failure.type);
    const b = bytes(payload).slice();
    if (!b.length || b.length > Math.min(this.profile.maxCommandBytes,CHUNK_SIZE-1024-this.inputSize-6) || this._pendingCommands.length >= this.profile.maxPendingCommands) throw new RangeError('command capacity');
    integer(this._commandSequence + 1, 'command sequence', 1);
    const sequence = ++this._commandSequence;
    this._pendingCommands.push({ sequence, payload: b }); return sequence;
  }
  setInputDelay(ticks) {
    integer(ticks, 'input delay', this.profile.minInputDelayTicks, this.profile.maxInputDelayTicks);
    this._requestedInputDelay=ticks;
    if(ticks>this.inputDelay)this._applyInputDelay(ticks);
  }
  _applyInputDelay(ticks){const previous=this.inputDelay;this._inputDelay=ticks;this._event('input-delay',{previous,value:ticks})}
  _capture(input) {
    const b = bytes(input);
    if (b.length !== this.inputSize) throw new RangeError('inputSize');
    const previous = this._inputs.get(this.localPlayerId).get(this._through.get(this.localPlayerId))?.input ?? this._lastLocalInput;
    this._lastLocalInput = b.slice();
    if (this._captureTick === this.tick) return;
    this._captureTick = this.tick;
    // Reduce by one only when the sample is identical and no edge command waits.
    // The next changed sample then has an uncommitted future slot; no pulse is lost.
    if(this._requestedInputDelay<this.inputDelay&&equalBytes(b,previous)&&!this._pendingCommands.length)this._applyInputDelay(this.inputDelay-1);
    const target = integer(this.tick + this.inputDelay, 'session tick limit', 0, MAX_TICK);
    const through = this._through.get(this.localPlayerId);
    // Only an identical sample may be coalesced with an immutable future frame.
    if (target <= through) return;
    for (let t = through + 1; t < target; t++) this._commitLocal(t, previous, []);
    let budget = CHUNK_SIZE - 1024 - this.inputSize;
    const commands = [];
    while (this._pendingCommands.length && this._pendingCommands[0].payload.length + 6 <= budget) {
      const c = this._pendingCommands.shift(); budget -= c.payload.length + 6;
      commands.push({ ...c, executeTick: target });
    }
    this._commitLocal(target, this._lastLocalInput, commands);
  }
  releaseInput() {
    if (this.closed || this._failure) return;
    this._lastLocalInput = new Uint8Array(this.inputSize);
    const last = this._inputs.get(this.localPlayerId).get(this._through.get(this.localPlayerId));
    if (last && equalBytes(last.input, this._lastLocalInput)) {
      for (const peer of this._peers.values()) if (peer.ready) this._sendInputs(peer);
      return;
    }
    const target = integer(Math.max(this.tick + this.inputDelay, this._through.get(this.localPlayerId) + 1), 'session tick limit', 0, MAX_TICK);
    for (let t = this._through.get(this.localPlayerId) + 1; t <= target; t++) this._commitLocal(t, this._lastLocalInput, []);
    for (const peer of this._peers.values()) if (peer.ready) this._sendInputs(peer);
    this._event('input-release', { executeTick: target });
  }
  _sendInputs(peer) {
    const map = this._inputs.get(this.localPlayerId);
    const first = peer.ack + 1;
    if (!map.has(first)) return;
    const frames = [];
    let cost = HEADER + 16;
    for (let t = first; frames.length < 128 && map.has(t); t++) {
      const f = map.get(t);
      const n = 7 + this.inputSize + f.commands.reduce((s, c) => s + 6 + c.payload.length, 0);
      if (cost + n > CHUNK_SIZE) break;
      frames.push(f); cost += n;
    }
    if (!frames.length) return;
    this._send(peer, packet(TYPE.INPUT, this._nextSequence(), w => {
      w.u32(first); w.u16(frames.length); w.u16(this.inputSize); w.i32(this._through.get(peer.id)); w.u32(this.tick);
      for (let i = 0; i < frames.length;) {
        const f = frames[i]; let run = 1;
        while (i + run < frames.length && !frames[i + run].commands.length && equalBytes(f.input, frames[i + run].input)) run++;
        w.u16(run); w.raw(f.input); w.u16(f.commands.length);
        for (const c of f.commands) { w.u32(c.sequence); w.u16(c.payload.length); w.raw(c.payload); }
        i += run;
      }
    }));
  }
  _sendClock(peer, now, replyTo) {
    const id = this._nextSequence();
    const data = packet(TYPE.CLOCK, id, w => {
      w.u32(this.tick); w.i32(this.confirmedTick); w.i32(this._through.get(peer.id)); w.u32(replyTo ?? 0); w.u8(replyTo === undefined ? 0 : 1);
    });
    if (this._send(peer, data)) {
      if (replyTo === undefined) { peer.pendingPings.set(id, now); peer.lastSent = now; }
      while (peer.pendingPings.size > 32) peer.pendingPings.delete(peer.pendingPings.keys().next().value);
    }
  }
  poll(now = this._clock()) {
    if (this.closed || this._failure) return;
    if (!Number.isFinite(now)) throw new TypeError('network time');
    for (const peer of this._peers.values()) {
      this._peerLiveness(peer,now);
      if (!peer.ready) { if (now - peer.lastHello >= this.profile.heartbeatMs) this._sendHello(peer, now); continue; }
      if (now - peer.lastSent >= this.profile.heartbeatMs) { this._sendInputs(peer); this._sendClock(peer, now); }
      let sent = 0;
      while (peer.controls.length && sent < 65536) {
        const data = peer.controls[0]; if (!this._send(peer, data)) break;
        peer.controls.shift(); peer.queuedBytes -= data.length; sent += data.length;
      }
    }
    if (this._incomingSnapshot && now - this._incomingSnapshot.started > this.profile.recoveryTimeoutMs) this._rejectSnapshot('snapshot timeout');
    if (this._requestedRecovery && now - this._requestedRecovery.at > this.profile.recoveryTimeoutMs) {
      if (this._recoveryStage) this._rejectSnapshot('candidate replay timeout');
      else this._requestedRecovery = null;
      this._event('recovery-timeout');
      this._recoveryExhausted('timeout');
    }
    // Reconciliation must finish even when gameplay is paused at a terminal tick.
    // It consumes a bounded resimulation budget, never a new logical tick.
    if(this._failure)return;
    if (this._recoveryStage) this._continueRecovery();
    else if (this.resimulating) this._rollback();
    if(this._failure)return;
    this._adapt(now); this._sendHashes(); this._checkHashes(); this._recordConfirmed();
  }
  receive(peerId, data, now = this._clock()) {
    if (this.closed || this._failure) return false;
    const peer = this._peers.get(peerId);
    if (!peer || ['closed','failed'].includes(peer.transportState)) return false;
    try {
      const b = bytes(data);
      if (b.length < HEADER || b.length > CHUNK_SIZE) throw new RangeError('packet size');
      const r = new Reader(b);
      if (r.u32() !== MAGIC) throw new Error('protocol magic');
      const protocolVersion=r.u8();
      if(protocolVersion!==PROTOCOL_VERSION){this._event('version-mismatch',{peerId,field:'protocol',expected:PROTOCOL_VERSION,received:protocolVersion});throw new Error('protocol version')}
      const type = r.u8(); if (r.u16() !== 0) throw new Error('reserved header');
      const sequence = r.u32();
      this._metrics.receivedBytes += b.length;
      if (type === TYPE.HELLO) {
        const hello = r.raw(b.length - HEADER); r.end();
        if (!equalBytes(hello, this._hello)) {
          const expected=JSON.parse(decoder.decode(this._hello)),received=JSON.parse(decoder.decode(hello));
          const fields=Object.keys(expected).filter(field=>JSON.stringify(expected[field])!==JSON.stringify(received?.[field]));
          if(!fields.length)throw new Error('noncanonical HELLO');
          const type=fields.some(field=>['protocol','library','simulationVersion'].includes(field))?'version-mismatch':'handshake-mismatch';
          this._fail(type,{peerId,fields:Object.freeze(fields),mismatches:Object.freeze(fields.map(field=>Object.freeze({field,expected:expected[field],received:received?.[field]})))});return false;
        }
        const wasReady = peer.ready; peer.ready = true;
        this._peerAlive(peer,sequence,now);
        if (!wasReady) { this._sendHello(peer, now); this._event('peer-ready', { peerId }); }
        return true;
      }
      if (!peer.ready) return false;
      if (type === TYPE.INPUT) this._receiveInputs(peer, r, sequence, now);
      else if (type === TYPE.CLOCK) this._receiveClock(peer, r, sequence, now);
      else if (type === TYPE.HASH) {
        const tick = r.u32(), hash = r.u32(), inputHash = r.u32(); r.end();
        if (tick <= this.tick + this.profile.stateHistorySize && tick >= Math.max(0, this.tick - this.profile.stateHistorySize + 1)) peer.hashes.set(tick, { hash, inputHash });
      } else if (type === TYPE.REQUEST) {
        const tick = r.u32(); r.end(); this._sendSnapshot(peer, tick);
      } else if (type === TYPE.BEGIN) this._beginSnapshot(peer, r, now);
      else if (type === TYPE.CHUNK) this._snapshotChunk(peer, r);
      else throw new Error('unknown packet type');
      this._peerAlive(peer,sequence,now);
      return true;
    } catch (error) {
      this._metrics.rejectedPackets++; this._event('protocol-error', { peerId, error }); return false;
    }
  }
  _receiveInputs(peer, r, sequence, now) {
    const first = r.u32(), count = r.u16(), size = r.u16(), ack = r.i32(), simTick = r.u32();
    if (!count || count > 128 || size !== this.inputSize || first + count - 1 > MAX_TICK || first + count > this.tick + this.profile.stateHistorySize * 4 + this.profile.maxInputDelayTicks + 1) throw new RangeError('input timeline');
    if (ack < -1 || ack > this._through.get(this.localPlayerId)) throw new RangeError('ack');
    const incoming = [];
    while (incoming.length < count) {
      const run = r.u16(); if (!run || incoming.length + run > count) throw new RangeError('input run');
      const input = r.raw(size), n = r.u16(), commands = [];
      if (n > this.profile.maxPendingCommands) throw new RangeError('command count');
      let previous = 0;
      for (let i = 0; i < n; i++) {
        const sequence = r.u32(), len = r.u16();
        if (!sequence || sequence <= previous || !len || len > this.profile.maxCommandBytes) throw new RangeError('command shape/order');
        previous = sequence; commands.push({ sequence, executeTick: first + incoming.length, payload: r.raw(len) });
      }
      incoming.push({ input, commands });
      for (let j = 1; j < run; j++) incoming.push({ input: input.slice(), commands: [] });
    }
    r.end();
    const map = this._inputs.get(peer.id);
    // Validate the complete packet before publishing any portion of it.
    for (let i = 0; i < count; i++) {
      const old = map.get(first + i); if (old && !frameEqual(old, incoming[i])) throw new Error('conflicting committed input');
    }
    peer.ack = Math.max(peer.ack, ack);
    if (peer.progressSequence === undefined || ((sequence - peer.progressSequence) >>> 0) < 0x80000000 && sequence !== peer.progressSequence) {
      peer.progressSequence = sequence; peer.tick = simTick; peer.clockAt = now;
    }
    const oldest = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
    for (let i = 0; i < count; i++) {
      const t = first + i;
      if (map.has(t) || t < oldest) continue;
      map.set(t, incoming[i]);
      this._window.received++;
      if (t < this.tick) this._window.late++;
      const used = this._used.get(t)?.find(x => x.playerId === peer.id);
      if (used && t < this.tick && !frameEqual(used, incoming[i])) {
        if (this._recoveryStage) this._rejectSnapshot('input history changed during candidate replay');
        if (!this._history.get(t)) { this._event('history-exhausted', { inputTick: t }); this.requestResync(Math.min(this.confirmedTick + 1, this.tick)); }
        else this._rollbackFrom = Math.min(this._rollbackFrom, t);
      }
    }
    let through = this._through.get(peer.id);
    while (map.has(through + 1)) through++;
    this._through.set(peer.id, through);
  }
  _receiveClock(peer, r, sequence, now) {
    const tick = r.u32(), confirmed = r.i32(), ack = r.i32(), echo = r.u32(), reply = r.u8(); r.end();
    if (reply > 1) throw new RangeError('clock reply flag');
    if (tick > MAX_TICK + 1 || confirmed < -1 || confirmed > ack || ack < -1 || ack > this._through.get(this.localPlayerId)) throw new RangeError('clock/ack');
    const fresh = peer.clockSequence === null || ((sequence - peer.clockSequence) >>> 0) < 0x80000000 && sequence !== peer.clockSequence;
    if (!fresh) return;
    peer.clockSequence = sequence; peer.confirmed = confirmed;
    if (peer.progressSequence === undefined || ((sequence - peer.progressSequence) >>> 0) < 0x80000000 && sequence !== peer.progressSequence) {
      peer.progressSequence = sequence; peer.tick = tick; peer.clockAt = now;
    }
    peer.ack = Math.max(peer.ack, ack); peer.echo = sequence;
    if (!reply) this._sendClock(peer, now, sequence);
    const sent = reply ? peer.pendingPings.get(echo) : undefined;
    if (sent !== undefined && now >= sent) {
      const sample = now - sent; peer.pendingPings.delete(echo);
      const difference = Math.abs(sample - peer.rtt);
      peer.rtt = peer.rtt ? peer.rtt * .875 + sample * .125 : sample;
      peer.jitter = peer.jitter * .75 + (peer.rtt === sample ? 0 : difference * .25);
      this._metrics.smoothedRTT = Math.max(...[...this._peers.values()].map(p => p.rtt));
      this._metrics.jitter = Math.max(...[...this._peers.values()].map(p => p.jitter));
    }
  }
  _resolve(tick) {
    return this.players.map(playerId => {
      const map = this._inputs.get(playerId), actual = map.get(tick);
      if (actual) return { playerId, ...copyFrame(actual), predicted: false };
      let prior = this._used.get(tick - 1)?.find(f => f.playerId === playerId)?.input ?? new Uint8Array(this.inputSize);
      const policy = this.profile.predictionPolicy;
      if (typeof policy === 'function') prior = bytes(policy({ playerId, tick, previousInput: prior.slice(), lastConfirmedTick: this._through.get(playerId) }));
      else if (policy === 'neutral') prior = new Uint8Array(this.inputSize);
      if (prior.length !== this.inputSize) throw new RangeError('predictor inputSize');
      // Only continuous state is predicted; a missing one-shot command is never repeated.
      return { playerId, input: prior.slice(), commands: [], predicted: true };
    });
  }
  _step(inputs, resimulating) {
    const before = this._history.get(this.tick);
    const tick = this.tick;
    integer(tick, 'session tick limit', 0, MAX_TICK);
    try {
      runSimulationFrame(this.adapter, { tick, tickRate: this.profile.tickRate, inputs, resimulating });
      const inputHash = this._hashInputFrame(tick,inputs,this._inputHash);
      const state = this._save();
      this._history.put({ tick: tick + 1, bytes: state, inputHash });
      this._used.set(tick, inputs.map(f => ({ ...copyFrame(f), playerId: f.playerId, predicted: f.predicted })));
      this._tick++; this._inputHash = inputHash;
    } catch (error) {
      if (before) this.adapter.load(before.bytes.slice());
      this._fail('fatal', { error }); throw error;
    }
  }
  _rollback() {
    const started = nowMs();
    if (this._rollbackFrom !== Infinity) {
      const target = this._resimTarget ?? this.tick, from = this._rollbackFrom;
      const saved = this._history.get(from);
      if (!saved) throw new Error('rollback state expired');
      this.adapter.load(saved.bytes.slice()); this._tick = from; this._inputHash = saved.inputHash;
      this._history.invalidateAfter(from); this._rollbackFrom = Infinity; this._resimTarget = target;
      this._metrics.rollbacks++; this._window.rollback++;
      this._metrics.maxRollbackDepth = Math.max(this._metrics.maxRollbackDepth, target - from);
      this._window.depth = Math.max(this._window.depth, target - from);
      this._event('rollback', { from, target });
    }
    let work = 0;
    while (this._resimTarget !== null && this.tick < this._resimTarget && work < this.profile.resimulationBudget) {
      this._step(this._resolve(this.tick), true); work++; this._metrics.resimulatedTicks++;
    }
    if (this._resimTarget !== null && this.tick === this._resimTarget) this._resimTarget = null;
    this._metrics.latestResimulationMs = nowMs() - started;
    this._window.cost += this._metrics.latestResimulationMs;
    this._window.costSamples++;
    return this._resimTarget === null;
  }
  _frameAdvantage(now) {
    let advantage = -Infinity;
    for (const peer of this._peers.values()) if (peer.ready && peer.clockSequence !== null) {
      // Remote reports are samples. Extrapolation is deliberately capped on stale data.
      const age = Math.max(0, Math.min(1000 / this.profile.tickRate, now - peer.clockAt));
      const estimated = peer.tick + (age + peer.rtt / 2) * this.profile.tickRate / 1000;
      advantage = Math.max(advantage, this.tick - estimated);
    }
    return Number.isFinite(advantage) ? advantage : 0;
  }
  advance(input = this._lastLocalInput) {
    if (this.closed) throw new Error('session closed');
    const now = this._clock(); this.poll(now);
    if(this._failure)return {status:'failed',tick:this.tick,failure:this.failure};
    if(['interrupted','disconnected'].includes(this.status))return {status:this.status,tick:this.tick};
    if(this._requestedRecovery||this._recoveryStage)return {status:'recovering',tick:this.tick};
    if (this.resimulating) return { status: 'resimulating', tick: this.tick };
    this._capture(input);
    for (const peer of this._peers.values()) if (peer.ready) this._sendInputs(peer);
    if (!this.ready) return { status: 'synchronizing', tick: this.tick };
    const advantage = this._frameAdvantage(now);
    const threshold = this.profile.tickDriftThreshold;
    const hold = this.profile.pacingPolicy === 'hold' && advantage > threshold ||
      this.profile.pacingPolicy === 'dilation' && advantage > Math.max(4, threshold * 3);
    if (hold) { this._metrics.holds++; return { status: 'held', tick: this.tick }; }
    const inputs = this._resolve(this.tick), predicted = inputs.some(f => f.predicted);
    const minAck = this._peers.size ? Math.min(...[...this._peers.values()].map(p => p.ack)) : this.tick;
    if (predicted && this.tick - (this.confirmedTick + 1) >= this.profile.rollbackWindowTicks ||
      this._through.get(this.localPlayerId) - minAck >= this.profile.stateHistorySize * 4) {
      this._metrics.stalls++; this._window.stall++; return { status: 'stalled', tick: this.tick };
    }
    this._step(inputs, false); this._window.advances++;
    if (predicted) this._metrics.predictedTicks++;
    this._recordConfirmed(); this._sendHashes(); this._checkHashes(); this._prune();
    return { status: 'advanced', tick: this.tick };
  }
  _adapt(now) {
    if (this._lastAdaptation === null) { this._lastAdaptation = now; return; }
    if (now - this._lastAdaptation < this.profile.adaptationIntervalMs) return;
    const seconds = (now - this._lastAdaptation) / 1000;
    this._lastAdaptation = now;
    const w = this._window;
    const lateRate = w.received ? w.late / w.received : 0;
    this._metrics.lateInputRate = this._metrics.lateInputRate * .75 + lateRate * .25;
    this._metrics.rollbackFrequency = this._metrics.rollbackFrequency * .75 + w.rollback / seconds * .25;
    this._metrics.stallFrequency = this._metrics.stallFrequency * .75 + w.stall / seconds * .25;
    const cost = w.costSamples ? w.cost / w.costSamples : 0;
    this._metrics.resimulationCostMs = this._metrics.resimulationCostMs * .75 + cost * .25;
    if (this.profile.adaptiveInputDelay) {
      const measured = Math.ceil((this._metrics.smoothedRTT / 2 + 2 * this._metrics.jitter) * this.profile.tickRate / 1000);
      const pressure = this._metrics.lateInputRate > .1 || this._metrics.rollbackFrequency > 2 ||
        w.depth > 3 || this._metrics.stallFrequency > 2 || this._metrics.resimulationCostMs > 1000 / this.profile.tickRate;
      if (pressure || measured > this.inputDelay + 1) {
        this.setInputDelay(Math.min(this.profile.maxInputDelayTicks, Math.max(this.inputDelay + 1,measured))); this._stableWindows = 0;
      } else if (w.advances > 0 && !w.late && !w.stall && measured <= this.inputDelay - 1) {
        if (++this._stableWindows >= 3) { this.setInputDelay(Math.max(this.profile.minInputDelayTicks, this.inputDelay - 1)); this._stableWindows = 0; }
      } else this._stableWindows = 0;
    }
    if (this.profile.pacingPolicy === 'dilation') {
      const drift = this._frameAdvantage(now);
      const target = Math.abs(drift) < .5 ? 1 : Math.max(.98, Math.min(1.05, 1 + drift * .005));
      const change = Math.max(-.005, Math.min(.005, (target - this._pace) * .2));
      this._pace = Math.max(.98, Math.min(1.05, this._pace + change));
    }
    this._window = { advances: 0, received: 0, late: 0, depth: 0, rollback: 0, stall: 0, cost: 0, costSamples: 0 };
  }
  _sendHashes() {
    if (this.resimulating) return;
    const upTo = Math.min(this.tick, this.confirmedTick + 1);
    const t = Math.floor(upTo / this.profile.checksumInterval) * this.profile.checksumInterval;
    if (!t) return;
    const s = this._history.get(t); if (!s) return;
    for (const peer of this._peers.values()) if (peer.ready && peer.lastHashQueued < t) {
      // Coalesce congestion into the newest retained confirmed boundary.
      // Unsent hashes remain derivable from the ring instead of an unbounded queue.
      if (this._queue(peer, packet(TYPE.HASH, this._nextSequence(), w => { w.u32(t); w.u32(this._stateHash(s)); w.u32(s.inputHash); }))) peer.lastHashQueued = t;
    }
  }
  _checkHashes() {
    if (this.resimulating) return;
    for (const peer of this._peers.values()) for (const [tick, remote] of peer.hashes) {
      if (tick > Math.min(this.tick, this.confirmedTick + 1)) continue;
      const local = this._history.get(tick);
      if (!local) { peer.hashes.delete(tick); continue; }
      if (local.inputHash !== remote.inputHash) { peer.hashes.delete(tick); this._event('input-history-mismatch', { peerId: peer.id, at: tick }); continue; }
      if (this._stateHash(local) !== remote.hash) {
        if (!remote.notified) { remote.notified = true; this._metrics.hashMismatches++; this._event('desync', { peerId: peer.id, at: tick }); }
        if (this.localPlayerId === this.authorityPlayerId || this.requestResync(tick)) peer.hashes.delete(tick);
      } else peer.hashes.delete(tick);
    }
  }
  getStateHash(tick = this.tick) { return this._stateHash(this._history.get(tick)); }
  requestResync(tick) {
    if(this.closed||this._failure)return false;
    integer(tick, 'recovery tick', 0, Math.min(this.tick, this.confirmedTick + 1));
    if (this.localPlayerId === this.authorityPlayerId) return false;
    const peer = this._peers.get(this.authorityPlayerId);
    if (!peer?.ready || this._requestedRecovery) return false;
    if(this._recoveryExhausted('attempt-limit'))return false;
    const state = this._history.get(tick); if (!state) return false;
    if (!this._queue(peer, packet(TYPE.REQUEST, this._nextSequence(), w => w.u32(tick)))) return false;
    this._requestedRecovery = { tick, inputHash: state.inputHash, at: this._clock() };
    this._recoveryAttempts++; return true;
  }
  _sendSnapshot(peer, tick) {
    if (this.localPlayerId !== this.authorityPlayerId || this.resimulating || tick > this.confirmedTick + 1) return;
    const state = this._history.get(tick); if (!state) return;
    const transfer = (++this._nextTransfer) >>> 0, count = Math.ceil(state.bytes.length / SNAP_CHUNK_BYTES);
    const packets = [packet(TYPE.BEGIN, this._nextSequence(), w => {
      w.u32(transfer); w.u32(tick); w.u32(state.bytes.length); w.u32(this._stateHash(state)); w.u32(state.inputHash); w.u16(count);
    })];
    for (let i = 0; i < count; i++) packets.push(packet(TYPE.CHUNK, this._nextSequence(), w => {
      w.u32(transfer); w.u32(i); w.raw(state.bytes.subarray(i * SNAP_CHUNK_BYTES, (i + 1) * SNAP_CHUNK_BYTES));
    }));
    if (peer.queuedBytes + packets.reduce((s, b) => s + b.length, 0) > this.profile.maxQueuedBytes) { this._event('recovery-backpressure', { peerId: peer.id }); return; }
    for (const p of packets) this._queue(peer, p);
  }
  _beginSnapshot(peer, r, now) {
    const transfer = r.u32(), tick = r.u32(), total = r.u32(), hash = r.u32(), inputHash = r.u32(), count = r.u16(); r.end();
    const busy = this._recoveryStage?.candidate ?? this._incomingSnapshot;
    if (busy) {
      if (peer.id === this.authorityPlayerId && transfer === busy.transfer && tick === busy.tick && total === busy.total && hash === busy.hash && inputHash === busy.inputHash && count === busy.count) return;
      throw new Error('another snapshot candidate is active');
    }
    if (peer.id !== this.authorityPlayerId || !this._requestedRecovery || this._requestedRecovery.tick !== tick ||
      inputHash !== this._requestedRecovery.inputHash || !this._history.get(tick) || tick > this.confirmedTick + 1 ||
      !total || total > this.profile.maxSnapshotBytes || count !== Math.ceil(total / SNAP_CHUNK_BYTES) || this._incomingSnapshot) throw new Error('snapshot candidate metadata');
    this._incomingSnapshot = { transfer, tick, total, hash, inputHash, count, bytes: new Uint8Array(total),
      seen: new Uint8Array(count), received: 0, started: now };
  }
  _snapshotChunk(peer, r) {
    const transfer = r.u32(), index = r.u32(), candidate = this._incomingSnapshot;
    if (peer.id !== this.authorityPlayerId || !candidate || transfer !== candidate.transfer || index >= candidate.count) throw new Error('snapshot transfer');
    const chunk = r.raw(r.data.length - r.offset); r.end();
    const expected = Math.min(SNAP_CHUNK_BYTES, candidate.total - index * SNAP_CHUNK_BYTES);
    if (chunk.length !== expected) throw new RangeError('snapshot chunk length');
    const start = index * SNAP_CHUNK_BYTES;
    if (candidate.seen[index]) {
      if (!equalBytes(candidate.bytes.subarray(start, start + expected), chunk)) throw new Error('conflicting snapshot chunk');
      return;
    }
    candidate.bytes.set(chunk, start); candidate.seen[index] = 1; candidate.received++;
    if (candidate.received === candidate.count) this._commitSnapshot(candidate);
  }
  _rejectSnapshot(reason) {
    this._incomingSnapshot = null; this._requestedRecovery = null; this._recoveryStage = null;
    this._metrics.rejectedSnapshots++; this._event('recovery-rejected', { reason });
    this._recoveryExhausted(reason);
  }
  _recoveryExhausted(reason){
    if(this._recoveryAttempts<this.profile.maxRecoveryAttempts)return false;
    this._fail('desync-unrecoverable',{reason,attempts:this._recoveryAttempts,authorityPlayerId:this.authorityPlayerId});return true;
  }
  _commitSnapshot(candidate) {
    if (this.resimulating || !this._history.get(candidate.tick) || hashBytes(candidate.bytes) !== candidate.hash) { this._rejectSnapshot('expired or corrupt candidate'); return; }
    const original = this._save();
    try {
      if (this.adapter.validateSnapshot(candidate.bytes.slice(), { tick: candidate.tick }) !== true) throw new Error('adapter rejected candidate');
      this.adapter.load(candidate.bytes.slice());
      if (!equalBytes(this._save(), candidate.bytes)) throw new Error('snapshot round-trip changed candidate');
      this._recoveryStage = { candidate, original, current: this.tick, next: candidate.tick,
        inputHash: candidate.inputHash, state: candidate.bytes.slice(), staged: [], stagedInputs: [], stageBytes: 0 };
      this._incomingSnapshot = null;
    } catch (error) { this._rejectSnapshot(error.message); }
    finally { this.adapter.load(original); }
  }
  _continueRecovery() {
    const job = this._recoveryStage;
    if (!job) return;
    const started = nowMs();
    try {
      this.adapter.load(job.state.slice());
      let work = 0;
      while (job.next < job.current && work < this.profile.resimulationBudget) {
        const t = job.next, inputs = this._resolve(t);
        runSimulationFrame(this.adapter, { tick: t, tickRate: this.profile.tickRate, inputs,
          resimulating: true, recovering: true });
        job.inputHash = this._hashInputFrame(t,inputs,job.inputHash);
        job.state = this._save();
        job.staged.push({ tick: t + 1, bytes: job.state, inputHash: job.inputHash });
        job.stagedInputs.push([t, inputs]); job.next++; work++; this._metrics.resimulatedTicks++;
        job.stageBytes += job.state.length;
        if (job.stageBytes > this.profile.maxHistoryBytes) throw new RangeError('candidate replay byte budget');
      }
      if (job.next < job.current) { this.adapter.load(job.original.slice()); return; }
      // Construct a complete replacement ring before exposing either game or runtime state.
      const replacement = new StateHistory(this.profile.stateHistorySize, this.profile.maxHistoryBytes);
      for (const state of this._history.slots) if (state && state.tick < job.candidate.tick) replacement.put(state);
      replacement.put({ tick: job.candidate.tick, bytes: job.candidate.bytes,
        hash: job.candidate.hash, inputHash: job.candidate.inputHash });
      for (const state of job.staged) replacement.put(state);
      const used = new Map(this._used);
      for (const [t, inputs] of job.stagedInputs) used.set(t, inputs);
      this._history = replacement; this._used = used; this._inputHash = job.inputHash;
      this._recoveryStage = null; this._requestedRecovery = null;
      this._recoveryAttempts = 0;
      this._metrics.recoveries++;
      this._event('recovered', { from: job.candidate.tick, target: job.current });
    } catch (error) {
      this.adapter.load(job.original.slice());
      this._rejectSnapshot(error.message);
    } finally {
      this._metrics.latestResimulationMs = nowMs() - started;
      this._window.cost += this._metrics.latestResimulationMs;
      this._window.costSamples++;
    }
  }
  _recordConfirmed() {
    if (!this._recordReplay || this.resimulating || this._failure) return;
    this._replayFinalState=this._history.get(this._replayFrames.length)??this._replayFinalState;
    const through = Math.min(this.confirmedTick, this.tick - 1);
    for (let t = this._replayFrames.length; t <= through; t++) {
      const inputs = this.players.map(playerId => ({ playerId, ...copyFrame(this._inputs.get(playerId).get(t)), predicted: false }));
      const n = inputs.reduce((s, f) => s + f.input.length + f.commands.reduce((k, c) => k + c.payload.length + 12, 0), 16);
      if (this._replayBytes + n > this.profile.maxReplayBytes) {
        this._replayFinalHash=this._stateHash(this._replayFinalState);this._replayFinalState=null;
        this._recordReplay = false; this._event('replay-capacity'); return;
      }
      this._replayFrames.push({ tick: t, inputs }); this._replayBytes += n;
      this._replayFinalState = this._history.get(t + 1);
    }
  }
  exportSyncTestFrames({maxFrames=32}={}) {
    integer(maxFrames,'maxFrames',1,256);
    if (this.resimulating) throw new Error('finish rollback before exporting synctest frames');
    this._recordConfirmed();
    return { initialState: this._initialState.slice(), players: [...this.players],
      inputSize: this.inputSize, tickRate: this.profile.tickRate, initialTick: 0,
      frames: this._replayFrames.slice(0,maxFrames).map(f => ({ tick: f.tick,
        inputs: f.inputs.map(x => ({ ...copyFrame(x), playerId: x.playerId, predicted: false })) })) };
  }
  exportReplay() {
    if (this.resimulating) throw new Error('finish rollback before exporting replay');
    this._recordConfirmed();
    const tick = this._replayFrames.length;
    return { version: VERSION, simulationVersion: this.simulationVersion, seed: this.seed,
      players: [...this.players], inputSize: this.inputSize, tickRate: this.profile.tickRate,
      initialState: this._initialState.slice(), frames: this._replayFrames.map(f => ({ tick: f.tick,
        inputs: f.inputs.map(x => ({ ...copyFrame(x), playerId: x.playerId, predicted: false })) })),
      tick, hash: this._stateHash(this._history.get(tick)) ?? this._stateHash(this._replayFinalState) ?? this._replayFinalHash ?? hashBytes(this._initialState),
      truncated: !this._recordReplay };
  }
  _prune() {
    const oldest = Math.max(0, this.tick - this.profile.stateHistorySize + 1);
    for (const t of this._used.keys()) if (t < oldest - 1) this._used.delete(t);
    const minAck = this._peers.size ? Math.min(...[...this._peers.values()].map(p => p.ack)) : this.tick;
    for (const [playerId, map] of this._inputs) for (const t of map.keys()) if (t < oldest && (playerId !== this.localPlayerId || t <= minAck)) map.delete(t);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const peer of this._peers.values()) { peer.unsubscribe?.(); peer.unsubscribeStatus?.(); peer.transport.close?.(); }
    this._peers.clear(); this._incomingSnapshot = null; this._recoveryStage = null; this._pendingCommands.length = 0; this._event('closed');
  }
}

export function playReplay({ adapter, replay, simulationVersion = replay?.simulationVersion } = {}) {
  if (replay?.version !== VERSION || replay.simulationVersion !== simulationVersion || !Array.isArray(replay.frames)) throw new Error('replay compatibility');
  adapter.load(bytes(replay.initialState).slice());
  let tick = 0;
  for (const f of replay.frames) {
    if (f.tick !== tick) throw new Error('non-contiguous replay');
    runSimulationFrame(adapter, { tick, tickRate: replay.tickRate, inputs: f.inputs.map(x => ({ ...x, predicted: false })), resimulating: true, replaying: true }); tick++;
  }
  return { tick, hash: hashBytes(bytes(adapter.save())) };
}
