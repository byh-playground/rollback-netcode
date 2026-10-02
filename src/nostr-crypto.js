// NIP-01/BIP340 signaling. These short-lived keys identify a signaling session,
// never a wallet. JavaScript BigInt arithmetic is not constant-time.
const nostrField = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const nostrOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const nostrGenerator = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n
];
const nostrInfinity = [0n, 1n, 0n];
export const nostrEncoder = new TextEncoder();

function nostrMod(nostrValue, nostrModulus = nostrField) {
  const nostrRemainder = nostrValue % nostrModulus;
  return nostrRemainder < 0n ? nostrRemainder + nostrModulus : nostrRemainder;
}

function nostrPow(nostrBase, nostrExponent) {
  let nostrResult = 1n;
  nostrBase = nostrMod(nostrBase);
  while (nostrExponent > 0n) {
    if (nostrExponent & 1n) nostrResult = nostrMod(nostrResult * nostrBase);
    nostrBase = nostrMod(nostrBase * nostrBase);
    nostrExponent >>= 1n;
  }
  return nostrResult;
}

function nostrDouble(nostrPoint) {
  const [nostrX, nostrY, nostrZ] = nostrPoint;
  if (nostrZ === 0n || nostrY === 0n) return nostrInfinity;
  const nostrA = nostrMod(nostrX * nostrX);
  const nostrB = nostrMod(nostrY * nostrY);
  const nostrC = nostrMod(nostrB * nostrB);
  const nostrD = nostrMod(2n * (nostrMod((nostrX + nostrB) ** 2n) - nostrA - nostrC));
  const nostrE = nostrMod(3n * nostrA);
  const nostrNextX = nostrMod(nostrE * nostrE - 2n * nostrD);
  return [nostrNextX, nostrMod(nostrE * (nostrD - nostrNextX) - 8n * nostrC), nostrMod(2n * nostrY * nostrZ)];
}

function nostrAdd(nostrLeft, nostrRight) {
  if (nostrLeft[2] === 0n) return nostrRight;
  if (nostrRight[2] === 0n) return nostrLeft;
  const [nostrX1, nostrY1, nostrZ1] = nostrLeft;
  const [nostrX2, nostrY2, nostrZ2] = nostrRight;
  const nostrZ1Squared = nostrMod(nostrZ1 * nostrZ1);
  const nostrZ2Squared = nostrMod(nostrZ2 * nostrZ2);
  const nostrU1 = nostrMod(nostrX1 * nostrZ2Squared);
  const nostrU2 = nostrMod(nostrX2 * nostrZ1Squared);
  const nostrS1 = nostrMod(nostrY1 * nostrZ2Squared * nostrZ2);
  const nostrS2 = nostrMod(nostrY2 * nostrZ1Squared * nostrZ1);
  if (nostrU1 === nostrU2) return nostrS1 === nostrS2 ? nostrDouble(nostrLeft) : nostrInfinity;
  const nostrH = nostrMod(nostrU2 - nostrU1);
  const nostrI = nostrMod(4n * nostrH * nostrH);
  const nostrJ = nostrMod(nostrH * nostrI);
  const nostrR = nostrMod(2n * (nostrS2 - nostrS1));
  const nostrV = nostrMod(nostrU1 * nostrI);
  const nostrNextX = nostrMod(nostrR * nostrR - nostrJ - 2n * nostrV);
  return [
    nostrNextX,
    nostrMod(nostrR * (nostrV - nostrNextX) - 2n * nostrS1 * nostrJ),
    nostrMod(((nostrZ1 + nostrZ2) ** 2n - nostrZ1Squared - nostrZ2Squared) * nostrH)
  ];
}

function nostrMultiply(nostrScalar, nostrPoint = nostrGenerator) {
  let nostrResult = nostrInfinity;
  while (nostrScalar > 0n) {
    if (nostrScalar & 1n) nostrResult = nostrAdd(nostrResult, nostrPoint);
    nostrPoint = nostrDouble(nostrPoint);
    nostrScalar >>= 1n;
  }
  return nostrResult;
}

function nostrAffine(nostrPoint) {
  if (nostrPoint[2] === 0n) return null;
  const nostrInverse = nostrPow(nostrPoint[2], nostrField - 2n);
  const nostrInverseSquared = nostrMod(nostrInverse * nostrInverse);
  return [nostrMod(nostrPoint[0] * nostrInverseSquared), nostrMod(nostrPoint[1] * nostrInverseSquared * nostrInverse)];
}

function nostrLiftX(nostrX) {
  if (nostrX >= nostrField) return null;
  const nostrC = nostrMod(nostrX ** 3n + 7n);
  const nostrY = nostrPow(nostrC, (nostrField + 1n) / 4n);
  if (nostrMod(nostrY * nostrY) !== nostrC) return null;
  return [nostrX, (nostrY & 1n) ? nostrField - nostrY : nostrY, 1n];
}

function nostrRequireBytes(nostrValue, nostrLength, nostrName) {
  if (!(nostrValue instanceof Uint8Array) || nostrValue.length !== nostrLength) {
    throw new TypeError(`${nostrName} must be a ${nostrLength}-byte Uint8Array`);
  }
  return new Uint8Array(nostrValue);
}

export function nostrBytesToNumber(nostrBytes) {
  let nostrValue = 0n;
  for (const nostrByte of nostrBytes) nostrValue = (nostrValue << 8n) | BigInt(nostrByte);
  return nostrValue;
}

function nostrNumberToBytes(nostrValue) {
  const nostrBytes = new Uint8Array(32);
  for (let nostrIndex = 31; nostrIndex >= 0; nostrIndex--) {
    nostrBytes[nostrIndex] = Number(nostrValue & 255n);
    nostrValue >>= 8n;
  }
  return nostrBytes;
}

export function nostrToHex(nostrBytes) {
  return Array.from(nostrBytes, nostrByte => nostrByte.toString(16).padStart(2, '0')).join('');
}

export function nostrFromHex(nostrHex) {
  return Uint8Array.from(nostrHex.match(/../g), nostrByte => parseInt(nostrByte, 16));
}

function nostrConcat(...nostrParts) {
  const nostrBytes = new Uint8Array(nostrParts.reduce((nostrSize, nostrPart) => nostrSize + nostrPart.length, 0));
  let nostrOffset = 0;
  for (const nostrPart of nostrParts) {
    nostrBytes.set(nostrPart, nostrOffset);
    nostrOffset += nostrPart.length;
  }
  return nostrBytes;
}

export function nostrRequireCrypto(nostrCryptoImpl, nostrRandom = false) {
  if (!nostrCryptoImpl?.subtle || typeof nostrCryptoImpl.subtle.digest !== 'function' ||
      (nostrRandom && typeof nostrCryptoImpl.getRandomValues !== 'function')) {
    throw new Error('Nostr signaling requires WebCrypto SHA-256 and secure randomness (use HTTPS)');
  }
}

export async function nostrHash(nostrBytes, nostrCryptoImpl) {
  nostrRequireCrypto(nostrCryptoImpl);
  return new Uint8Array(await nostrCryptoImpl.subtle.digest('SHA-256', nostrBytes));
}

async function nostrTaggedHash(nostrTag, nostrBytes, nostrCryptoImpl) {
  const nostrTagHash = await nostrHash(nostrEncoder.encode(nostrTag), nostrCryptoImpl);
  return nostrHash(nostrConcat(nostrTagHash, nostrTagHash, nostrBytes), nostrCryptoImpl);
}

export function nostrPublicKey(nostrSecret) {
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, 'secret');
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError('Invalid secp256k1 secret');
    return nostrNumberToBytes(nostrAffine(nostrMultiply(nostrScalar))[0]);
  } finally {
    nostrSecretCopy.fill(0);
  }
}

export async function nostrVerify(nostrSignature, nostrMessage, nostrPublic, nostrCryptoImpl) {
  if (!(nostrSignature instanceof Uint8Array) || nostrSignature.length !== 64 ||
      !(nostrMessage instanceof Uint8Array) || nostrMessage.length !== 32 ||
      !(nostrPublic instanceof Uint8Array) || nostrPublic.length !== 32) return false;
  const nostrSignatureCopy = new Uint8Array(nostrSignature);
  const nostrMessageCopy = new Uint8Array(nostrMessage);
  const nostrPublicCopy = new Uint8Array(nostrPublic);
  const nostrPoint = nostrLiftX(nostrBytesToNumber(nostrPublicCopy));
  const nostrR = nostrBytesToNumber(nostrSignatureCopy.subarray(0, 32));
  const nostrS = nostrBytesToNumber(nostrSignatureCopy.subarray(32));
  if (!nostrPoint || nostrR >= nostrField || nostrS >= nostrOrder) return false;
  const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash('BIP0340/challenge',
    nostrConcat(nostrSignatureCopy.subarray(0, 32), nostrPublicCopy, nostrMessageCopy), nostrCryptoImpl)) % nostrOrder;
  const nostrResult = nostrAffine(nostrAdd(nostrMultiply(nostrS), nostrMultiply(nostrChallenge,
    [nostrPoint[0], nostrMod(-nostrPoint[1]), 1n])));
  return nostrResult !== null && (nostrResult[1] & 1n) === 0n && nostrResult[0] === nostrR;
}

export async function nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, nostrCryptoImpl) {
  const nostrMessageCopy = nostrRequireBytes(nostrMessage, 32, 'message');
  const nostrAuxiliaryCopy = nostrRequireBytes(nostrAuxiliary, 32, 'auxiliary randomness');
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, 'secret');
  let nostrMaskedSecret;
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError('Invalid secp256k1 secret');
    const nostrPoint = nostrAffine(nostrMultiply(nostrScalar));
    const nostrNormalizedSecret = (nostrPoint[1] & 1n) ? nostrOrder - nostrScalar : nostrScalar;
    const nostrPublic = nostrNumberToBytes(nostrPoint[0]);
    const nostrAuxiliaryHash = await nostrTaggedHash('BIP0340/aux', nostrAuxiliaryCopy, nostrCryptoImpl);
    nostrMaskedSecret = nostrNumberToBytes(nostrNormalizedSecret);
    for (let nostrIndex = 0; nostrIndex < 32; nostrIndex++) nostrMaskedSecret[nostrIndex] ^= nostrAuxiliaryHash[nostrIndex];
    const nostrNonce = nostrBytesToNumber(await nostrTaggedHash('BIP0340/nonce',
      nostrConcat(nostrMaskedSecret, nostrPublic, nostrMessageCopy), nostrCryptoImpl)) % nostrOrder;
    if (nostrNonce === 0n) throw new Error('BIP340 nonce generation failed');
    const nostrNoncePoint = nostrAffine(nostrMultiply(nostrNonce));
    const nostrNormalizedNonce = (nostrNoncePoint[1] & 1n) ? nostrOrder - nostrNonce : nostrNonce;
    const nostrR = nostrNumberToBytes(nostrNoncePoint[0]);
    const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash('BIP0340/challenge',
      nostrConcat(nostrR, nostrPublic, nostrMessageCopy), nostrCryptoImpl)) % nostrOrder;
    const nostrSignature = nostrConcat(nostrR, nostrNumberToBytes(nostrMod(nostrNormalizedNonce + nostrChallenge * nostrNormalizedSecret, nostrOrder)));
    if (!await nostrVerify(nostrSignature, nostrMessageCopy, nostrPublic, nostrCryptoImpl)) throw new Error('BIP340 signature self-check failed');
    return nostrSignature;
  } finally {
    nostrSecretCopy.fill(0);
    nostrAuxiliaryCopy.fill(0);
    nostrMaskedSecret?.fill(0);
  }
}

/** Low-level 32-byte-message helpers for conformance tests, not wallet signing. */
export const nostrCrypto = Object.freeze({
  publicKey: nostrPublicKey,
  sign: (nostrMessage, nostrSecret, nostrAuxiliary) => nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, globalThis.crypto),
  verify: (nostrSignature, nostrMessage, nostrPublic) => nostrVerify(nostrSignature, nostrMessage, nostrPublic, globalThis.crypto)
});
