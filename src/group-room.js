import { PROTOCOL_VERSION, encoder } from './protocol.js';
import { compareIds, integer, nowMs } from './utilities.js';
import { createNostrSignaler } from './nostr.js';
import { createWebRTCPeer } from './webrtc.js';
import { createStarTransports } from './star-transport.js';

function groupRoomId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
/** Fixed-roster 2..8-player room. Topology changes transports, never the simulation Core. */
export async function createNostrGroupRoom({ role, room, playerCount = 2, topology = 'mesh', namespace = 'rollback-netcode',
  relays, rtcConfig, timeoutMs = 60000, onStatus = () => {}, signal,
  signalerFactory = createNostrSignaler, peerFactory = createWebRTCPeer } = {}) {
  if (!['host', 'join'].includes(role) || !['mesh', 'star'].includes(topology)) throw new TypeError('group room role/topology');
  integer(playerCount, 'playerCount', 2, 8); integer(timeoutMs, 'timeoutMs', 1, 120000);
  if (typeof namespace !== 'string' || !namespace.trim() || new TextEncoder().encode(namespace + ':group-v1').length > 128) throw new TypeError('group namespace');
  if ([onStatus, signalerFactory, peerFactory].some(fn => typeof fn !== 'function')) throw new TypeError('group room capability');
  if (signal?.aborted) throw new Error('group room aborted');
  const random = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(v => v.toString(16).padStart(2, '0')).join('');
  if (!room && role === 'host') room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
  if (!/^\d{4}$/.test(room ?? '')) throw new TypeError('four-digit room');
  const peerController = new AbortController(), signalController = new AbortController(), startedAt = nowMs();
  const earlyAbort = () => { peerController.abort(); signalController.abort(); };
  signal?.addEventListener('abort', earlyAbort, { once: true });
  let signaler;
  try {
    signaler = await signalerFactory({ room, namespace: namespace + ':group-v1', relays, signal: signalController.signal,
      timeoutMs: Math.min(timeoutMs, 10000), onStatus,
      maxVerificationsPerSecond: Math.max(16, playerCount * 4), verificationBurst: playerCount * 4 });
    if (!groupRoomId(signaler?.id) || typeof signaler.send !== 'function' || typeof signaler.subscribe !== 'function' || typeof signaler.close !== 'function') throw new TypeError('group signaler capability');
    if (signal?.aborted || signalController.signal.aborted) throw new Error('group room aborted');
  } catch (error) { earlyAbort(); signaler?.close?.(); signal?.removeEventListener('abort', earlyAbort); throw error; }
  signal?.removeEventListener('abort', earlyAbort);

  return new Promise((resolve, reject) => {
    const self = signaler.id, members = new Set([self]), departed = new Set(), acks = new Set([self]), ready = new Set(), starts = new Set([self]);
    const peers = new Map(), subscribers = new Map(), backlog = new Map(), controlPending = new Map(), removers = [];
    let host = role === 'host' ? self : null, sessionId = role === 'host' ? random() : null, roster = null, rosterKey = '';
    let phase = role === 'host' ? 'checking' : 'discovering', disposed = false, settled = false, connecting = false, localReady = false;
    let unsubscribe, interval, collisionTimer, deadline, router, backlogBytes = 0, startPublished = false;
    const status = (type, detail = {}) => { try { onStatus({ type, room, role, playerCount, topology, phase, ...detail }); } catch {} };
    function message(op, extra = {}) { return { type: 'group', version: 1, protocol: PROTOCOL_VERSION, op, host, sessionId, playerCount, topology, ...extra }; }
    function dispose(reason, notify = true) {
      if (disposed) return; disposed = true;
      clearInterval(interval); clearTimeout(collisionTimer); clearTimeout(deadline);
      unsubscribe?.(); signal?.removeEventListener('abort', abort);
      peerController.abort(); removers.splice(0).forEach(fn => fn()); router?.close();
      peers.forEach(p => p.close()); peers.clear(); subscribers.clear(); backlog.clear(); backlogBytes = 0;
      // Give a departure publication a bounded grace period; RTC closes immediately.
      const finish = () => { signalController.abort(); signaler.close(); };
      if (notify && host && sessionId) {
        const grace = setTimeout(finish, 1500); grace.unref?.();
        Promise.resolve().then(() => signaler.send(role === 'host' ? '*' : host, message('leave', { reason })))
          .catch(() => {}).finally(() => { clearTimeout(grace); finish(); });
      } else finish();
    }
    function fail(error, notify = true) {
      if (disposed) return; const value = error instanceof Error ? error : new Error(String(error));
      const former = phase; phase = 'failed'; dispose(value.message, notify);
      status('group-failed', { reason: value.message, previousPhase: former });
      if (!settled) { settled = true; reject(value); }
    }
    function abort() { fail(new Error('group room aborted')); }
    function send(to, op, extra = {}) {
      if (disposed) return Promise.resolve();
      const key = to + ':' + op; if (controlPending.has(key)) return controlPending.get(key);
      if (controlPending.size >= 32) return Promise.resolve();
      const pending = Promise.resolve().then(() => { if (!disposed) return signaler.send(to, message(op, extra)); })
        .catch(error => { fail(error); }).finally(() => controlPending.delete(key));
      controlPending.set(key, pending); return pending;
    }
    function close() {
      if (disposed) return; const pending = !settled; phase = 'closed'; dispose('room closed'); status('group-closed');
      if (pending) { settled = true; reject(new Error('group room closed')); }
    }
    function finish() {
      if (disposed || settled || !localReady) return;
      settled = true; phase = 'running'; clearTimeout(deadline); clearInterval(interval);
      const physical = new Map([...peers].map(([id, peer]) => [id, peer.transport]));
      status('group-started', { players: [...roster], localPlayerId: self });
      // A status observer is allowed to close/abort before the result is exposed.
      if (disposed) { reject(new Error('group room closed by observer')); return; }
      resolve({ room, sessionId, playerCount, topology, players: Object.freeze([...roster]), localPlayerId: self,
        authorityPlayerId: host, hostPlayerId: host,
        transports: new Map(router?.transports ?? physical),
        peerConnections: new Map([...peers].map(([id, peer]) => [id, peer.peerConnection])),
        get closed() { return disposed; }, get metrics() { return router?.metrics ?? null; }, close });
    }
    function hostProgress() {
      if (disposed || role !== 'host' || !roster) return;
      if (phase === 'roster' && acks.size === playerCount) { phase = 'connecting'; connect(); send('*', 'connect', { rosterKey }); }
      if (phase === 'connecting' && ready.size === playerCount) {
        phase = 'starting'; send('*', 'start', { rosterKey }).then(() => { startPublished = true; hostProgress(); });
      }
      if (phase === 'starting' && startPublished && starts.size === playerCount) finish();
    }
    function wantedPeers() { return roster.filter(id => id !== self && (topology === 'mesh' || self === host || id === host)); }
    function scopedSignaler(remote) {
      return { id: self,
        send(to, payload) {
          if (disposed || to !== remote) return Promise.reject(new Error('group peer scope'));
          return signaler.send(to, { ...payload, groupSession: sessionId });
        },
        subscribe(fn) {
          const set = subscribers.get(remote) ?? new Set(); subscribers.set(remote, set); set.add(fn);
          const queued = backlog.get(remote) ?? []; backlog.delete(remote);
          for (const item of queued) { backlogBytes -= item.size; if (!disposed) fn(item.envelope); }
          return () => set.delete(fn);
        }, close() {}
      };
    }
    function connect() {
      if (disposed || connecting || !roster) return; connecting = true; phase = 'connecting';
      status('group-connecting', { players: [...roster] }); if (disposed) return;
      Promise.all(wantedPeers().map(remote => Promise.resolve().then(() => {
        if (disposed) throw new Error('group room closed');
        return peerFactory({ initiator: compareIds(self, remote) > 0, signaler: scopedSignaler(remote), remoteId: remote,
          rtcConfig, timeoutMs: Math.min(timeoutMs, 30000), onStatus: event => status('group-peer', { peerId: remote, event }), signal: peerController.signal });
      }).then(peer => {
        if (disposed) { peer.close(); return; }
        if (!peer?.transport?.send || !peer.transport.subscribe || typeof peer.close !== 'function') throw new TypeError('group peer capability');
        peers.set(remote, peer);
        if (peer.transport.subscribeStatus) removers.push(peer.transport.subscribeStatus(state => {
          if (!disposed && (state === 'closed' || state === 'failed' || (!settled && state === 'interrupted'))) fail(new Error('group peer unavailable: ' + remote));
        }));
      }))).then(() => {
        if (disposed) return;
        if ([...peers.values()].some(p => p.transport.state && p.transport.state !== 'open')) throw new Error('group transport not open');
        if (topology === 'star') router = createStarTransports({ players: roster, localPlayerId: self, hostPlayerId: host, sessionId,
          physicalTransports: new Map([...peers].map(([id, p]) => [id, p.transport])), onError: fail });
        localReady = true; status('group-ready', { players: [...roster] }); if (disposed) return;
        if (role === 'host') { ready.add(self); hostProgress(); } else send(host, 'ready', { rosterKey });
      }).catch(fail);
    }
    function publishRoster() { send('*', 'roster', { players: roster, rosterKey }); }
    function advertise(to = '*') { send(to, 'hello', { accepting: phase === 'collecting', memberCount: members.size }); }
    function acceptRoster(from, m) {
      if (from !== host || !Array.isArray(m.players) || m.players.length !== playerCount ||
          m.players.some(id => !groupRoomId(id)) || new Set(m.players).size !== playerCount ||
          !m.players.includes(self) || !m.players.includes(host) || m.players.join('\n') !== [...m.players].sort(compareIds).join('\n') ||
          m.rosterKey !== m.players.join('\n')) { fail(new Error('invalid group roster')); return; }
      if (roster && rosterKey !== m.rosterKey) { fail(new Error('group roster changed')); return; }
      if (!roster) { roster = Object.freeze([...m.players]); rosterKey = m.rosterKey; phase = 'roster'; status('group-roster', { players: [...roster] }); }
      send(host, 'ack', { rosterKey });
    }
    function receive(envelope) {
      if (disposed || !envelope || envelope.from === self || !groupRoomId(envelope.from) ||
          !['*', self].includes(envelope.to) || !envelope.message || typeof envelope.message !== 'object') return;
      const { from, to, message: m } = envelope;
      if (['offer', 'answer', 'ice', 'bye'].includes(m.type)) {
        if (!roster || to !== self || m.groupSession !== sessionId || !wantedPeers().includes(from)) return;
        const set = subscribers.get(from);
        if (set?.size) { for (const fn of set) fn(envelope); return; }
        const size = encoder.encode(JSON.stringify(m)).length, queued = backlog.get(from) ?? [];
        if (queued.length >= 32 || backlogBytes + size > 2 * 1024 * 1024) { fail(new Error('group signaling backlog capacity')); return; }
        queued.push({ envelope, size }); backlog.set(from, queued); backlogBytes += size; return;
      }
      if (m.type !== 'group' || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
      if (role === 'host' && m.op === 'hello' && m.host === from) {
        if (['checking', 'collecting'].includes(phase)) fail(new Error('room code is already in use'));
        else if (m.accepting !== false) advertise(from);
        return;
      }
      if (role === 'join' && m.op === 'hello' && m.host === from && groupRoomId(m.sessionId)) {
        if (host && (host !== from || sessionId !== m.sessionId)) return;
        if (m.playerCount !== playerCount || m.topology !== topology) { fail(new Error('group playerCount/topology mismatch'), false); return; }
        const selected = !!host;
        if (!host) { host = from; sessionId = m.sessionId; }
        if (!roster) { if (m.accepting === false && !selected) { fail(new Error('group room is full or already started'), false); return; } send(host, 'join'); }
        return;
      }
      if (role === 'host' && m.op === 'discover') { if (phase !== 'checking') advertise(from); return; }
      if (m.host !== host || m.sessionId !== sessionId || m.playerCount !== playerCount || m.topology !== topology) return;
      if (role === 'host') {
        if (m.op === 'join') {
          if (members.has(from)) { if (roster) publishRoster(); return; }
          if (phase !== 'collecting' || departed.has(from)) { send(from, 'reject', { reason: 'group room is full or already started' }); return; }
          members.add(from); status('group-members', { players: [...members].sort(compareIds) });
          if (disposed) return;
          if (members.size === playerCount) { roster = Object.freeze([...members].sort(compareIds)); rosterKey = roster.join('\n'); phase = 'roster'; status('group-roster', { players: [...roster] }); publishRoster(); }
        } else if (m.op === 'leave' && members.has(from)) {
          if (phase === 'collecting') { members.delete(from); departed.add(from); if (departed.size > 64) fail(new Error('group membership churn limit')); else status('group-members', { players: [...members].sort(compareIds) }); }
          else fail(new Error('group participant left'));
        } else if (roster?.includes(from) && m.rosterKey === rosterKey) {
          if (m.op === 'ack') acks.add(from);
          if (m.op === 'ready' && ['connecting', 'starting'].includes(phase)) ready.add(from);
          if (m.op === 'start-ack' && phase === 'starting') starts.add(from);
          hostProgress();
        }
      } else if (from === host) {
        if (m.op === 'reject') fail(new Error(String(m.reason || 'group rejected')), false);
        else if (m.op === 'leave') fail(new Error('group host left'), false);
        else if (m.op === 'roster') acceptRoster(from, m);
        else if (roster && m.rosterKey === rosterKey) {
          if (m.op === 'connect') { connect(); if (localReady) send(host, 'ready', { rosterKey }); }
          if (m.op === 'start' && localReady) send(host, 'start-ack', { rosterKey }).then(finish);
        }
      }
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    unsubscribe = signaler.subscribe(receive);
    if (disposed) { unsubscribe?.(); return; }
    const remaining = timeoutMs - (nowMs() - startedAt);
    if (remaining <= 0) { fail(new Error('group room timeout')); return; }
    deadline = setTimeout(() => fail(new Error('group room timeout: ' + phase)), remaining);
    interval = setInterval(() => {
      if (disposed) return;
      if (role === 'host') {
        if (phase === 'collecting') advertise();
        else if (phase === 'roster') publishRoster();
        else if (phase === 'connecting') send('*', 'connect', { rosterKey });
        else if (phase === 'starting') send('*', 'start', { rosterKey }).then(() => { startPublished = true; hostProgress(); });
      } else if (!host) send('*', 'discover');
      else if (!roster) send(host, 'join');
      else if (!connecting) send(host, 'ack', { rosterKey });
      else if (localReady) send(host, 'ready', { rosterKey });
    }, 1000);
    status('room'); if (disposed) return;
    if (role === 'host') collisionTimer = setTimeout(() => { if (!disposed) { phase = 'collecting'; advertise(); } }, 1200);
    else send('*', 'discover');
  });
}
