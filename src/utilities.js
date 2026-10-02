export const nowMs = () => globalThis.performance?.now() ?? Date.now();
export const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function integer(value, name, min = 0, max = 0xffffffff) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(name);
  return value;
}
export function bytes(value, name = 'bytes') {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  for (const b of bytes(value)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
export function statelessRandom(seed, eventId) {
  let x = (seed ^ Math.imul(integer(eventId, 'eventId'), 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
export class SeededPRNG {
  constructor(seed = 1) { this.state = integer(seed, 'seed') >>> 0; }
  nextUint32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  nextInt(bound) {
    integer(bound, 'bound', 1, 0x100000000);
    const limit = Math.floor(0x100000000 / bound) * bound;
    let x;
    do { x = this.nextUint32(); } while (x >= limit);
    return x % bound;
  }
}
const signed = (x) => integer(x, 'fixed-point result', -2147483648, 2147483647);
export const fixedPoint = Object.freeze({
  scale: 1024,
  fromNumber: (x) => signed(Math.round(x * 1024)),
  toNumber: (x) => signed(x) / 1024,
  add: (a, b) => signed(signed(a) + signed(b)),
  sub: (a, b) => signed(signed(a) - signed(b)),
  mul: (a, b) => {
    signed(a); signed(b);
    const product=a*b;
    // Exact integer product: the fast path preserves truncation, including -0.
    if(Number.isSafeInteger(product))return signed(Math.trunc(product/1024)||0);
    return signed(Number(BigInt(a)*BigInt(b)/1024n));
  },
  div: (a, b) => {
    if (signed(b) === 0) throw new RangeError('fixed-point division by zero');
    return signed(Number(BigInt(signed(a)) * 1024n / BigInt(b)));
  },
});
