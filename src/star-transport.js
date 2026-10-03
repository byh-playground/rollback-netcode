import { CHUNK_SIZE, TYPE } from './protocol.js';
import { bytes, hashBytes, nowMs, integer } from './utilities.js';

const starHeader = 24, starPayload = CHUNK_SIZE - starHeader, starMagic = 0x31535452;
/** Logical peer transports over one physical host link per guest. Owns framing, not game state. */
export function createStarTransports({ players, localPlayerId, hostPlayerId, sessionId, physicalTransports,
  onError = () => {}, maxQueuedBytes = 5 * 1024 * 1024 } = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8 || new Set(players).size !== players.length ||
      !players.includes(localPlayerId) || !players.includes(hostPlayerId) || typeof sessionId !== 'string' ||
      !(physicalTransports instanceof Map) || typeof onError !== 'function') throw new TypeError('star transport configuration');
  integer(maxQueuedBytes, 'star queue budget', CHUNK_SIZE * 2, 64 * 1024 * 1024);
  const local = players.indexOf(localPlayerId), host = players.indexOf(hostPlayerId), isHost = local === host;
  const required = isHost ? players.filter(id => id !== localPlayerId) : [hostPlayerId];
  if (required.some(id => !physicalTransports.get(id)?.subscribe || !physicalTransports.get(id)?.send)) throw new TypeError('missing star physical transport');
  const tag = hashBytes(new TextEncoder().encode(sessionId)), listeners = new Map(), statusListeners = new Map();
  const queues = new Map(required.map(id => [id, []])), assemblies = new Map(), completed = new Map();
  const unsubs = [], stats = { sentFrames: 0, forwardedFrames: 0, rejectedFrames: 0, queuedBytes: 0, queuedFrames: 0, assemblyBytes: 0 };
  let closed = false, sequence = 0, pumping = false;
  function reject() { stats.rejectedFrames++; }
  function close() {
    if (closed) return; closed = true; clearInterval(timer);
    for (const remove of unsubs.splice(0)) remove();
    queues.forEach(q => q.length = 0); assemblies.clear(); completed.clear();
    stats.queuedBytes = 0; stats.queuedFrames = 0; stats.assemblyBytes = 0;
    for (const set of statusListeners.values()) for (const fn of set) { try { fn('closed'); } catch {} }
    listeners.clear(); statusListeners.clear();
  }
  function fail(message) { if (closed) return; close(); try { onError(new Error(message)); } catch {} }
  function pump() {
    if (closed || pumping) return; pumping = true;
    try {
      const now = nowMs();
      for (const [id, q] of queues) {
        let work = 0;
        while (q.length && work++ < 128 && !closed) {
          if (now - q[0].at > 10000) { fail('star forwarding backpressure timeout'); break; }
          if (physicalTransports.get(id).send(q[0].bytes) === false) break;
          stats.queuedBytes -= q.shift().bytes.length; stats.queuedFrames--; stats.sentFrames++;
        }
      }
      for (const [key, a] of assemblies) if (now - a.at > 2000) { assemblies.delete(key); stats.assemblyBytes -= a.total; }
    } catch (error) { fail('star forwarding failed: ' + error.message); }
    finally { pumping = false; }
  }
  function enqueue(id, frames, forwarded) {
    const size = frames.reduce((n, b) => n + b.length, 0), q = queues.get(id);
    if (closed || !q || (physicalTransports.get(id).state && physicalTransports.get(id).state !== 'open')) return false;
    if (stats.queuedBytes + size > maxQueuedBytes || stats.queuedFrames + frames.length > 4096) { if (forwarded) fail('star forwarding queue capacity'); return false; }
    const at = nowMs(); for (const b of frames) q.push({ bytes: b.slice(), at });
    stats.queuedBytes += size; stats.queuedFrames += frames.length; if (forwarded) stats.forwardedFrames += frames.length;
    pump(); return !closed;
  }
  function deliver(from, id, payload, lane) {
    const actualLane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
    if (actualLane !== lane) { reject(); return; }
    let seen = completed.get(from); if (!seen) completed.set(from, seen = new Set());
    if (seen.has(id)) return; seen.add(id); if (seen.size > 256) seen.delete(seen.values().next().value);
    const target = listeners.get(players[from]);
    if (target?.size) for (const fn of target) fn(payload.slice());
    // Core HELLO/input retransmission owns delivery before a consumer subscribes.
  }
  function receive(physicalId, data) {
    if (closed) return;
    let b; try { b = bytes(data); } catch { reject(); return; }
    if (b.length < starHeader || b.length > CHUNK_SIZE) { reject(); return; }
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), from = b[6], to = b[7], lane = b[5];
    const id = v.getUint32(12, true), total = v.getUint16(16, true), offset = v.getUint16(18, true), length = v.getUint16(20, true);
    if (v.getUint32(0, true) !== starMagic || b[4] !== 1 || v.getUint32(8, true) !== tag ||
        v.getUint16(22, true) !== 0 || ![1, TYPE.INPUT, TYPE.CLOCK].includes(lane) ||
        from >= players.length || to >= players.length || from === to || from === local ||
        !id || !total || total > CHUNK_SIZE || ![0, starPayload].includes(offset) || offset >= total ||
        length !== Math.min(starPayload, total - offset) || b.length !== starHeader + length ||
        (isHost ? players[from] !== physicalId : physicalId !== hostPlayerId || to !== local)) { reject(); return; }
    if (to !== local) { if (!isHost || !enqueue(players[to], [b], true)) { if (!closed) fail('star destination is not available'); } return; }
    if (completed.get(from)?.has(id)) return;
    if (total <= starPayload) { deliver(from, id, b.slice(starHeader), lane); return; }
    const key = from + ':' + id; let a = assemblies.get(key);
    if (!a) {
      if (assemblies.size >= 32 || stats.assemblyBytes + total > 512 * 1024) { reject(); return; }
      a = { total, lane, bytes: new Uint8Array(total), seen: new Set(), at: nowMs() }; assemblies.set(key, a); stats.assemblyBytes += total;
    }
    if (a.total !== total || a.lane !== lane) { reject(); return; }
    if (a.seen.has(offset)) {
      for (let i = 0; i < length; i++) if (a.bytes[offset + i] !== b[starHeader + i]) { reject(); return; }
      return;
    }
    a.bytes.set(b.subarray(starHeader), offset); a.seen.add(offset);
    if (a.seen.size === 2) { assemblies.delete(key); stats.assemblyBytes -= total; deliver(from, id, a.bytes, lane); }
  }
  const timer = setInterval(pump, 16); timer.unref?.();
  const transports = new Map();
  for (const remote of players.filter(id => id !== localPlayerId)) {
    listeners.set(remote, new Set()); statusListeners.set(remote, new Set());
    const physical = isHost ? remote : hostPlayerId;
    transports.set(remote, {
      get state() { return closed ? 'closed' : physicalTransports.get(physical).state ?? 'open'; },
      send(data) {
        if (closed) return false; const payload = bytes(data);
        if (!payload.length || payload.length > CHUNK_SIZE) throw new RangeError('star packet size');
        sequence = (sequence + 1) >>> 0 || 1; const id = sequence, frames = [];
        const lane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
        for (let offset = 0; offset < payload.length; offset += starPayload) {
          const length = Math.min(starPayload, payload.length - offset), b = new Uint8Array(starHeader + length), v = new DataView(b.buffer);
          v.setUint32(0, starMagic, true); b[4] = 1; b[5] = lane; b[6] = local; b[7] = players.indexOf(remote);
          v.setUint32(8, tag, true); v.setUint32(12, id, true); v.setUint16(16, payload.length, true);
          v.setUint16(18, offset, true); v.setUint16(20, length, true); b.set(payload.subarray(offset, offset + length), starHeader); frames.push(b);
        }
        return enqueue(physical, frames, false);
      },
      subscribe(fn) { if (closed || typeof fn !== 'function') throw new TypeError('star subscriber'); const set = listeners.get(remote); set.add(fn); return () => set.delete(fn); },
      subscribeStatus(fn) { if (closed || typeof fn !== 'function') throw new TypeError('star status subscriber'); const set = statusListeners.get(remote); set.add(fn); return () => set.delete(fn); },
      close() { listeners.get(remote)?.clear(); statusListeners.get(remote)?.clear(); }
    });
  }
  try { for (const id of required) {
    const raw = physicalTransports.get(id);
    unsubs.push(raw.subscribe(data => receive(id, data)));
    if (raw.subscribeStatus) unsubs.push(raw.subscribeStatus(state => {
      for (const [remote, set] of statusListeners) if (!isHost || remote === id) for (const fn of set) { try { fn(state); } catch {} }
    }));
  } } catch (error) { close(); throw error; }
  return { transports, close, get metrics() { return { ...stats }; } };
}
