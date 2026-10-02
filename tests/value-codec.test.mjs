import test from 'node:test';
import assert from 'node:assert/strict';
import { binaryCodec, jsonCodec, createValueCodec } from '../rollback-netcode.js';
const plain = { z: [null, true, false, 0, 1.25, '한글🚗'], a: { seed: 42, '__proto__': null } };
test('default binary and optional JSON preserve values and canonical ordering', () => {
  assert.equal(createValueCodec().format, 'binary');
  for (const codec of [binaryCodec, jsonCodec]) {
    const bytes = codec.encode(plain), value = codec.decode(bytes);
    assert.deepEqual(value, JSON.parse(JSON.stringify(plain)));
    assert.deepEqual(codec.encode(value), bytes);
    assert.deepEqual(codec.encode({ b: 1, a: 2 }), codec.encode({ a: 2, b: 1 }));
  }
  assert.deepEqual(binaryCodec.decode(binaryCodec.encode(new Uint8Array([0, 255]))), new Uint8Array([0, 255]));
});
test('malformed, noncanonical and resource-exhausting values fail', () => {
  const valid = binaryCodec.encode(plain);
  for (let i = 0; i < valid.length; i++) assert.throws(() => binaryCodec.decode(valid.slice(0, i)));
  assert.throws(() => binaryCodec.decode(new Uint8Array([...valid, 0])));
  assert.throws(() => binaryCodec.decode(new Uint8Array([82, 86, 1, 255])));
  for (const codec of [binaryCodec, jsonCodec]) {
    for (const value of [undefined, NaN, Infinity, new Date(), [undefined], '\ud800']) assert.throws(() => codec.encode(value));
    const cyclic = {}; cyclic.self = cyclic; assert.throws(() => codec.encode(cyclic));
    assert.throws(() => createValueCodec({ format: codec.format, maxBytes: 8 }).encode(plain));
    assert.throws(() => createValueCodec({ format: codec.format, maxDepth: 1 }).encode(plain));
    assert.throws(() => createValueCodec({ format: codec.format, maxEntries: 3 }).encode(plain));
  }
  assert.throws(() => jsonCodec.decode(new TextEncoder().encode('{"b":1,"a":2}')));
  assert.throws(() => jsonCodec.decode(new TextEncoder().encode('{"a":1,"a":1}')));
  assert.throws(() => jsonCodec.encode(new Uint8Array([1])));
});
test('prototype keys are ordinary record data and UTF8 errors fail', () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":3}');
  for (const codec of [binaryCodec, jsonCodec]) {
    const decoded = codec.decode(codec.encode(value));
    assert.equal(decoded.__proto__.polluted, true); assert.equal({}.polluted, undefined);
  }
  assert.throws(() => binaryCodec.decode(new Uint8Array([82,86,1,4,1,0,0,0,255])));
});
test('compact int32 encoding is unique, bounded and keeps float64 outside its range', () => {
  for (const value of [-2147483649, -2147483648, -65, -64, -1, -0, 0, 1, 63, 64, 2147483647, 2147483648, Number.MAX_SAFE_INTEGER, 1.5]) {
    const bytes = binaryCodec.encode(value);
    assert.equal(binaryCodec.decode(bytes), Object.is(value, -0) ? 0 : value);
    assert.deepEqual(binaryCodec.encode(binaryCodec.decode(bytes)), bytes);
  }
  assert.equal(binaryCodec.encode(0).length, 5);
  for (const tail of [[128, 0], [255,255,255,255,16], [128,128,128,128,128]]) assert.throws(() => binaryCodec.decode(new Uint8Array([82,86,1,8,...tail])));
  const floatOne = new Uint8Array(12); floatOne.set([82,86,1,3]); new DataView(floatOne.buffer).setFloat64(4,1,true);
  assert.throws(() => binaryCodec.decode(floatOne));
  const bom = '\ufefftext'; assert.equal(binaryCodec.decode(binaryCodec.encode(bom)), bom);
  const bytes = new Uint8Array([1,2]); const decoded = binaryCodec.decode(binaryCodec.encode(bytes)); bytes[0] = 9; assert.equal(decoded[0],1);
});
test('repeated strings use canonical per-payload references', () => {
  const value = [{ stableFieldName: 'repeated-string' }, { stableFieldName: 'repeated-string' }];
  const bytes = binaryCodec.encode(value);
  assert.deepEqual(binaryCodec.decode(bytes), value);
  assert.deepEqual(binaryCodec.encode(value), bytes);
  assert.throws(() => binaryCodec.decode(new Uint8Array([82,86,1,9,0])));
  assert.throws(() => binaryCodec.decode(new Uint8Array([82,86,1,5,2,0,0,0,4,1,0,0,0,65,4,1,0,0,0,65])));
  assert.deepEqual(binaryCodec.decode(binaryCodec.encode(['', '', 'constructor', 'constructor'])), ['', '', 'constructor', 'constructor']);
});
test('many references and mixed numeric values remain independent across payloads', () => {
  const value = Array.from({length: 300}, (_, i) => ({ label: 'unit-' + i, type: i % 2 ? 'tank' : 'ranger', x: i / 7, hp: i, active: true }));
  const bytes = binaryCodec.encode(value);
  binaryCodec.encode({other: 'earlier payload must not affect references'});
  assert.deepEqual(binaryCodec.encode(value), bytes);
  assert.deepEqual(binaryCodec.decode(bytes), value);
  binaryCodec.decode(binaryCodec.encode({other: 'decode dictionary isolation'}));
  assert.deepEqual(binaryCodec.decode(bytes), value);
  for (const sub of [bytes.subarray(0, bytes.length - 1), bytes.subarray(0, 4)]) assert.throws(() => binaryCodec.decode(sub));
  const bounded = createValueCodec({maxEntries: 3});
  assert.throws(() => bounded.decode(bytes));
});
