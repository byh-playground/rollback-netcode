import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedPoint, SeededPRNG, statelessRandom, hashBytes } from '../rollback-netcode.js';

test('fixed-point products and quotients use exact integer intermediates', () => {
  assert.equal(fixedPoint.mul(1234567, -456789), Number(1234567n * -456789n / 1024n));
  assert.equal(fixedPoint.div(-1234567, 789), Number(-1234567n * 1024n / 789n));
  assert.equal(fixedPoint.add(1024, 512), fixedPoint.fromNumber(1.5));
  assert.equal(fixedPoint.toNumber(fixedPoint.fromNumber(-2.25)), -2.25);
  assert.throws(() => fixedPoint.mul(2147483647, 2147483647), RangeError);
  assert.throws(() => fixedPoint.div(1, 0), RangeError);
});

test('saving PRNG state reproduces the exact subsequent integer sequence', () => {
  const original = new SeededPRNG(1234);
  for (let i = 0; i < 31; i++) original.nextUint32();
  const restored = new SeededPRNG(original.state);
  assert.deepEqual(Array.from({ length: 128 }, () => original.nextUint32()), Array.from({ length: 128 }, () => restored.nextUint32()));
  for (const bound of [1, 3, 17, 65535, 0x100000000]) for (let i = 0; i < 100; i++) {
    const value = original.nextInt(bound); assert.ok(Number.isInteger(value) && value >= 0 && value < bound);
  }
});

test('stateless randomness does not depend on event evaluation order', () => {
  const forward = [0, 1, 77, 991].map(id => [id, statelessRandom(17, id)]);
  const reverse = [991, 77, 1, 0].map(id => [id, statelessRandom(17, id)]).reverse();
  assert.deepEqual(forward, reverse);
});

test('state hashing has a known byte-level result and respects view boundaries', () => {
  assert.equal(hashBytes(new TextEncoder().encode('hello')), 0x4f9f2cab);
  const storage = new Uint8Array([9, 104, 101, 108, 108, 111, 8]);
  assert.equal(hashBytes(storage.subarray(1, 6)), 0x4f9f2cab);
});
