/** 게임 구조를 가정하지 않는 값 ↔ bytes capability. Core는 이 모듈에 의존하지 않는다. */
export function createValueCodec({ format = 'binary', maxBytes = 16 * 1024 * 1024, maxDepth = 128, maxEntries = 1000000 } = {}) {
  if (!['binary', 'json'].includes(format)) throw new TypeError('Unknown codec format');
  for (const limit of [maxBytes, maxDepth, maxEntries]) if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid codec limit');
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  function normalize(value, depth = 0, seen = new Set(), budget = { count: 0 }) {
    if (depth > maxDepth || ++budget.count > maxEntries) throw new RangeError('Value codec budget exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Finite numbers required'); return Object.is(value, -0) ? 0 : value; }
    if (typeof value === 'string') { if (decoder.decode(encoder.encode(value)) !== value) throw new TypeError('Invalid Unicode string'); return value; }
    if (!value || typeof value !== 'object' || seen.has(value)) throw new TypeError('Unsupported or cyclic value');
    seen.add(value);
    let result;
    if (value instanceof Uint8Array) {
      if (format === 'json') throw new TypeError('JSON codec does not support byte values');
      result = value;
    } else if (Array.isArray(value)) {
      result = Array.from(value, item => normalize(item, depth + 1, seen, budget));
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Plain records required');
      result = {};
      for (const key of Object.keys(value).sort()) { normalize(key, depth + 1, seen, budget); Object.defineProperty(result, key, { value: normalize(value[key], depth + 1, seen, budget), enumerable: true, writable: true, configurable: true }); }
    }
    seen.delete(value); return result;
  }
  const stringCache = new Map();
  let cachedStringBytes = 0;
  function stringBytes(value) {
    let data = stringCache.get(value);
    if (data) return data;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('Invalid Unicode string'); }
      else if (c >= 0xdc00 && c <= 0xdfff) throw new TypeError('Invalid Unicode string');
    }
    data = encoder.encode(value);
    if (data.length <= 256 && stringCache.size < 1024 && cachedStringBytes + data.length <= 131072) { stringCache.set(value, data); cachedStringBytes += data.length; }
    return data;
  }
  function encode(value) {
    if (format === 'json') { const bytes = encoder.encode(JSON.stringify(normalize(value))); if (bytes.length > maxBytes) throw new RangeError('Codec byte budget exceeded'); return bytes; }
    let bytes = new Uint8Array(Math.min(1024, maxBytes)), offset = 0, view = new DataView(bytes.buffer), entries = 0;
    const seen = new Set(), strings = new Map();
    function reserve(size) { if (offset + size > maxBytes) throw new RangeError('Codec byte budget exceeded'); if (offset + size > bytes.length) { const next = new Uint8Array(Math.min(maxBytes, Math.max(offset + size, bytes.length * 2))); next.set(bytes); bytes = next; view = new DataView(bytes.buffer); } }
    function byte(n) { reserve(1); bytes[offset++] = n; }
    function length(n) { reserve(4); view.setUint32(offset, n, true); offset += 4; }
    function raw(data) { length(data.length); reserve(data.length); bytes.set(data, offset); offset += data.length; }
    function variable(n) { while (n >= 128) { byte((n % 128) + 128); n = Math.floor(n / 128); } byte(n); }
    function write(v, depth = 0) {
      if (depth > maxDepth || ++entries > maxEntries) throw new RangeError('Value codec budget exceeded');
      if (v === null) byte(0);
      else if (v === false) byte(1);
      else if (v === true) byte(2);
      else if (typeof v === 'number') {
        if (!Number.isFinite(v)) throw new TypeError('Finite numbers required');
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) { byte(8); variable(v < 0 ? -v * 2 - 1 : v * 2); }
        else { byte(3); reserve(8); view.setFloat64(offset, v, true); offset += 8; }
      }
      else if (typeof v === 'string') { const ref = strings.get(v); if (ref !== undefined) { byte(9); variable(ref); } else { strings.set(v, strings.size); byte(4); raw(stringBytes(v)); } }
      else {
        if (!v || typeof v !== 'object' || seen.has(v)) throw new TypeError('Unsupported or cyclic value');
        if (v instanceof Uint8Array) { byte(7); raw(v); return; }
        seen.add(v);
        if (Array.isArray(v)) { byte(5); length(v.length); for (const item of v) write(item, depth + 1); }
        else {
          const prototype = Object.getPrototypeOf(v);
          if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Plain records required');
          byte(6); const keys = Object.keys(v).sort(); length(keys.length);
          for (const key of keys) { write(key, depth + 1); write(v[key], depth + 1); }
        }
        seen.delete(v);
      }
    }
    byte(82); byte(86); byte(1); write(value); return bytes.slice(0, offset);
  }
  function decode(input) {
    const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
    if (!bytes || bytes.length > maxBytes) throw new RangeError('Invalid codec bytes');
    let result;
    if (format === 'json') result = normalize(JSON.parse(decoder.decode(bytes)));
    else {
      let offset = 0, entries = 0;
      const strings = [], stringSet = new Set();
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      function need(n) { if (n > bytes.length - offset) throw new RangeError('Truncated codec bytes'); }
      function byte() { need(1); return bytes[offset++]; }
      function length() { need(4); const n = view.getUint32(offset, true); offset += 4; return n; }
      function raw() { const n = length(); need(n); const data = bytes.subarray(offset, offset + n); offset += n; return data; }
      function read(depth = 0) {
        if (depth > maxDepth || ++entries > maxEntries) throw new RangeError('Value codec budget exceeded');
        const tag = byte();
        if (tag === 0) return null; if (tag === 1) return false; if (tag === 2) return true;
        if (tag === 3) { need(8); const n = view.getFloat64(offset, true); offset += 8; if (!Number.isFinite(n) || Object.is(n, -0) || (Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) throw new TypeError('Noncanonical number'); return n; }
        if (tag === 8 || tag === 9) {
          let n = 0, scale = 1, part;
          for (let i = 0; i < 5; i++) {
            part = byte(); n += (part & 127) * scale;
            if (n > 4294967295) throw new TypeError('Integer overflow');
            if (part < 128) {
              if (i && part === 0) throw new TypeError('Noncanonical integer');
              if (tag === 9) { if (n >= strings.length) throw new TypeError('Invalid string reference'); return strings[n]; }
              return n % 2 ? -(n + 1) / 2 : n / 2;
            }
            scale *= 128;
          }
          throw new TypeError('Invalid integer');
        }
        if (tag === 4) { const value = decoder.decode(raw()); if (stringSet.has(value)) throw new TypeError('Noncanonical repeated string'); stringSet.add(value); strings.push(value); return value; }
        if (tag === 7) return raw().slice();
        if (tag !== 5 && tag !== 6) throw new TypeError('Invalid codec tag');
        const n = length(); if (n > maxEntries - entries) throw new RangeError('Value codec budget exceeded');
        if (tag === 5) { const arr = []; for (let i = 0; i < n; i++) arr.push(read(depth + 1)); return arr; }
        const obj = {}; let previous;
        for (let i = 0; i < n; i++) { const key = read(depth + 1); if (typeof key !== 'string' || (i && key <= previous)) throw new TypeError('Noncanonical record key'); if (key === '__proto__') Object.defineProperty(obj, key, { value: read(depth + 1), enumerable: true, writable: true, configurable: true }); else obj[key] = read(depth + 1); previous = key; }
        return obj;
      }
      if (byte() !== 82 || byte() !== 86 || byte() !== 1) throw new TypeError('Invalid codec header');
      result = read(); if (offset !== bytes.length) throw new TypeError('Trailing codec bytes');
    }
    if (format === 'json') { const canonical = encode(result); if (canonical.length !== bytes.length || canonical.some((v, i) => v !== bytes[i])) throw new TypeError('Noncanonical codec bytes'); }
    return result;
  }
  return Object.freeze({ format, encode, decode });
}
export const binaryCodec = createValueCodec();
export const jsonCodec = createValueCodec({ format: 'json' });
