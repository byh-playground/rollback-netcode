import { bytes, equalBytes } from './utilities.js';
export const VERSION = '0.1.0-dev';
export const PROTOCOL_VERSION = 1;
export const CHUNK_SIZE = 16384;
export const MAX_TICK = 0x7ffffffe; // Signed ACK fields reserve -1 for no confirmed input.

export const defaults = {
  tickRate: 60, baseInputDelayTicks: 2, minInputDelayTicks: 0, maxInputDelayTicks: 8,
  rollbackWindowTicks: 12, stateHistorySize: 64, predictionPolicy: 'hold',
  stallPolicy: 'wait', tickDriftThreshold: 2, pacingPolicy: 'hold',
  checksumInterval: 30, resimulationBudget: 24, maxCatchupSteps: 4,
  adaptiveInputDelay: true, heartbeatMs: 100, adaptationIntervalMs: 1000,
  maxSnapshotBytes: 4 * 1024 * 1024, maxHistoryBytes: 64 * 1024 * 1024, maxReplayBytes: 64 * 1024 * 1024,
  maxCommandBytes: 2048, maxPendingCommands: 256, maxQueuedBytes: 5 * 1024 * 1024,
  recoveryTimeoutMs: 10000, maxRecoveryAttempts: 3,
};
export const profiles = Object.freeze({
  action: Object.freeze({ ...defaults }),
  rts: Object.freeze({ ...defaults, tickRate: 20, baseInputDelayTicks: 4,
    maxInputDelayTicks: 12, rollbackWindowTicks: 6, stateHistorySize: 32,
    predictionPolicy: 'neutral', checksumInterval: 20, resimulationBudget: 12 }),
  lockstep: Object.freeze({ ...defaults, rollbackWindowTicks: 0,
    stateHistorySize: 32, predictionPolicy: 'neutral' }),
});

export const encoder = new TextEncoder();
export const decoder = new TextDecoder('utf-8', { fatal: true });
// Gameplay packets use explicitly defined little-endian fields, not JS object serialization.
export const MAGIC = 0x314b4252;
export const TYPE = Object.freeze({ HELLO: 1, INPUT: 2, CLOCK: 3, HASH: 4,
  REQUEST: 5, BEGIN: 6, CHUNK: 7 });
export const HEADER = 12;
export const SNAP_CHUNK_BYTES = CHUNK_SIZE - HEADER - 8;
export class Writer {
  constructor(size = CHUNK_SIZE) { this.data = new Uint8Array(size); this.view = new DataView(this.data.buffer); this.offset = 0; }
  room(n) { if (this.offset + n > this.data.length) throw new RangeError('packet capacity'); }
  u8(n) { this.room(1); this.view.setUint8(this.offset++, n); }
  u16(n) { this.room(2); this.view.setUint16(this.offset, n, true); this.offset += 2; }
  u32(n) { this.room(4); this.view.setUint32(this.offset, n, true); this.offset += 4; }
  i32(n) { this.room(4); this.view.setInt32(this.offset, n, true); this.offset += 4; }
  raw(b) { this.room(b.length); this.data.set(b, this.offset); this.offset += b.length; }
  finish() { return this.data.slice(0, this.offset); }
}
export class Reader {
  constructor(data) { this.data = bytes(data); this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength); this.offset = 0; }
  room(n) { if (this.offset + n > this.data.length) throw new RangeError('truncated packet'); }
  u8() { this.room(1); return this.view.getUint8(this.offset++); }
  u16() { this.room(2); const n = this.view.getUint16(this.offset, true); this.offset += 2; return n; }
  u32() { this.room(4); const n = this.view.getUint32(this.offset, true); this.offset += 4; return n; }
  i32() { this.room(4); const n = this.view.getInt32(this.offset, true); this.offset += 4; return n; }
  raw(n) { this.room(n); const b = this.data.slice(this.offset, this.offset + n); this.offset += n; return b; }
  end() { if (this.offset !== this.data.length) throw new RangeError('trailing packet bytes'); }
}
export function packet(type, sequence, write) {
  const w = new Writer();
  w.u32(MAGIC); w.u8(PROTOCOL_VERSION); w.u8(type); w.u16(0); w.u32(sequence);
  write(w);
  return w.finish();
}
export function frameEqual(a, b) {
  if (!equalBytes(a.input, b.input) || a.commands.length !== b.commands.length) return false;
  return a.commands.every((c, i) => c.sequence === b.commands[i].sequence && equalBytes(c.payload, b.commands[i].payload));
}
export function copyFrame(frame) {
  return { input: frame.input.slice(), commands: frame.commands.map(c => ({ ...c, payload: c.payload.slice() })) };
}
