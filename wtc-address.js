'use strict';
/**
 * wtc-address.js — Wattcoin native address module
 *
 * All addresses start with "wtc1q" and are 43 characters long:
 *   wtc1q<38 bech32m chars>
 *   e.g. wtc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0
 *
 * Derivation:
 *   32-byte private key (random)
 *   → secp256k1 → 33-byte compressed public key
 *   → SHA-256 → RIPEMD-160 → 20-byte hash160
 *   → bech32m_encode("wtc", v0, hash160) → "wtc1q..."
 *
 * Signatures: secp256k1 ECDSA, canonical low-s, with recovery id.
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// secp256k1 field arithmetic (pure BigInt — mirrors electron-main.js)
// ─────────────────────────────────────────────────────────────────────────────

const _P  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
const _N  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const _Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
const _Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;

function _modP(v) { return ((v % _P) + _P) % _P; }
function _modN(v) { return ((v % _N) + _N) % _N; }

function _powMod(base, exp, mod) {
  let r = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) r = r * base % mod;
    exp >>= 1n;
    base = base * base % mod;
  }
  return r;
}

function _invP(a) { return _powMod(_modP(a), _P - 2n, _P); }
function _invN(a) { return _powMod(_modN(a), _N - 2n, _N); }

// Jacobian coordinates — infinity represented as [0n, 1n, 0n]
function _ptDouble([X, Y, Z]) {
  if (Y === 0n || Z === 0n) return [0n, 1n, 0n];
  const A = _modP(X * X), B = _modP(Y * Y), C = _modP(B * B);
  const D = _modP(2n * (_modP((X + B) * (X + B)) - A - C));
  const E = _modP(3n * A);
  const X2 = _modP(E * E - 2n * D);
  const Y2 = _modP(E * (D - X2) - 8n * C);
  return [X2, Y2, _modP(2n * Y * Z)];
}

function _ptAdd(PA, PB) {
  if (PA[2] === 0n) return PB;
  if (PB[2] === 0n) return PA;
  const [X1, Y1, Z1] = PA, [X2, Y2, Z2] = PB;
  const Z1Z1 = _modP(Z1 * Z1), Z2Z2 = _modP(Z2 * Z2);
  const U1 = _modP(X1 * Z2Z2), U2 = _modP(X2 * Z1Z1);
  const S1 = _modP(Y1 * Z2 * Z2Z2), S2 = _modP(Y2 * Z1 * Z1Z1);
  const H = _modP(U2 - U1), R = _modP(S2 - S1);
  if (H === 0n) return R === 0n ? _ptDouble(PA) : [0n, 1n, 0n];
  const H2 = _modP(H * H), H3 = _modP(H2 * H);
  const X3 = _modP(R * R - H3 - 2n * U1 * H2);
  return [X3, _modP(R * (U1 * H2 - X3) - S1 * H3), _modP(H * Z1 * Z2)];
}

function _ptMul(k, [Px, Py]) {
  let R = [0n, 1n, 0n], Q = [Px, Py, 1n];
  k = _modN(k);
  while (k > 0n) {
    if (k & 1n) R = _ptAdd(R, Q);
    Q = _ptDouble(Q);
    k >>= 1n;
  }
  return R;
}

function _jacToAff([X, Y, Z]) {
  if (Z === 0n) return null;
  const iz = _invP(Z), iz2 = _modP(iz * iz);
  return [_modP(X * iz2), _modP(Y * iz2 * iz)];
}

// Recover a public key (affine) from an ECDSA signature + message hash.
function _recoverPublicKey(hash32, r, s, recid) {
  const x = r + (recid & 2 ? _N : 0n);
  if (x >= _P) return null;
  const y2 = _modP(x * x % _P * x + 7n);
  let y = _powMod(y2, (_P + 1n) / 4n, _P);
  if (_modP(y * y) !== y2) return null;
  if ((y & 1n) !== BigInt(recid & 1)) y = _modP(_P - y);
  const rInv = _invN(r);
  const hash = BigInt('0x' + hash32.toString('hex'));
  const u1 = _modN(_N - _modN(rInv * hash));
  const u2 = _modN(rInv * s);
  return _jacToAff(_ptAdd(_ptMul(u1, [_Gx, _Gy]), _ptMul(u2, [x, y])));
}

// ─────────────────────────────────────────────────────────────────────────────
// Key operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a 33-byte compressed secp256k1 public key from a 32-byte private key.
 */
function privateKeyToPublicKey(privKeyBuf) {
  const k = BigInt('0x' + privKeyBuf.toString('hex'));
  if (k <= 0n || k >= _N) throw new Error('Invalid private key: out of range');
  const pt = _jacToAff(_ptMul(k, [_Gx, _Gy]));
  if (!pt) throw new Error('Invalid private key: point at infinity');
  const prefix = (pt[1] & 1n) === 0n ? 0x02 : 0x03;
  return Buffer.concat([
    Buffer.from([prefix]),
    Buffer.from(pt[0].toString(16).padStart(64, '0'), 'hex'),
  ]);
}

/**
 * Compute RIPEMD-160(SHA-256(data)) — the standard 20-byte hash160.
 */
function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

// ─────────────────────────────────────────────────────────────────────────────
// bech32m encoding/decoding (BIP-350)
// HRP = "wtc"  →  all addresses start with "wtc1"
// ─────────────────────────────────────────────────────────────────────────────

const _HRP          = 'wtc';
const _BECH32M_CONST = 0x2bc830a3;
const _CHARSET      = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const _CHARSET_REV  = Object.fromEntries([..._CHARSET].map((c, i) => [c, i]));

function _bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function _hrpExpand(hrp) {
  const r = [];
  for (const c of hrp) r.push(c.charCodeAt(0) >> 5);
  r.push(0);
  for (const c of hrp) r.push(c.charCodeAt(0) & 31);
  return r;
}

function _bech32mChecksum(hrp, data) {
  const poly = _bech32Polymod([..._hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ _BECH32M_CONST;
  return [0, 1, 2, 3, 4, 5].map(i => (poly >> (5 * (5 - i))) & 31);
}

function _bech32mVerify(hrp, data) {
  return _bech32Polymod([..._hrpExpand(hrp), ...data]) === _BECH32M_CONST;
}

// Convert a byte array between bit-widths (e.g. 8→5 for bech32 encoding).
function _convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const result = [], maxv = (1 << toBits) - 1;
  for (const v of data) {
    if (v < 0 || v >> fromBits) return null;
    acc = (acc << fromBits) | v;
    bits += fromBits;
    while (bits >= toBits) { bits -= toBits; result.push((acc >> bits) & maxv); }
  }
  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public address API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encode a 20-byte hash160 as a WTC native address.
 * Output is always "wtc1q" + 39 bech32m chars = 44 characters.
 *
 * @param {Buffer} hash160Buf  20-byte hash
 * @returns {string}  "wtc1q..."
 */
function encodeAddress(hash160Buf) {
  if (!Buffer.isBuffer(hash160Buf) || hash160Buf.length !== 20) {
    throw new Error('hash160 must be a 20-byte Buffer');
  }
  const words = _convertBits([...hash160Buf], 8, 5, true);
  if (!words) throw new Error('encodeAddress: convertBits failed');
  const data = [0, ...words]; // 0 = witness version (P2WPKH-style)
  const checksum = _bech32mChecksum(_HRP, data);
  return _HRP + '1' + [...data, ...checksum].map(d => _CHARSET[d]).join('');
}

/**
 * Decode a WTC address back to its 20-byte hash160.
 * Returns null if the address is malformed, wrong HRP, or has a bad checksum.
 *
 * @param {string} addr
 * @returns {Buffer|null}
 */
function decodeAddressToHash160(addr) {
  if (typeof addr !== 'string') return null;
  const lower = addr.toLowerCase();
  const sep = lower.lastIndexOf('1');
  if (sep < 1 || sep + 7 > lower.length) return null;
  const hrp = lower.slice(0, sep);
  if (hrp !== _HRP) return null;
  const data = [];
  for (const c of lower.slice(sep + 1)) {
    if (!(c in _CHARSET_REV)) return null;
    data.push(_CHARSET_REV[c]);
  }
  if (!_bech32mVerify(hrp, data)) return null;
  const payload = data.slice(0, -6); // remove 6-char checksum
  if (payload.length < 1 || payload[0] !== 0) return null; // witness version must be 0
  const bytes = _convertBits(payload.slice(1), 5, 8, false);
  if (!bytes || bytes.length !== 20) return null;
  return Buffer.from(bytes);
}

/**
 * Returns true if addr is a well-formed WTC address.
 *
 * @param {string} addr
 * @returns {boolean}
 */
function isValidAddress(addr) {
  return decodeAddressToHash160(addr) !== null;
}

/**
 * Derive a WTC address from a 33-byte compressed public key buffer.
 *
 * @param {Buffer} pubKeyBuf  33-byte compressed public key
 * @returns {string}  "wtc1q..."
 */
function addressFromPublicKey(pubKeyBuf) {
  if (!Buffer.isBuffer(pubKeyBuf) || pubKeyBuf.length !== 33) {
    throw new Error('pubKey must be a 33-byte compressed public key');
  }
  return encodeAddress(hash160(pubKeyBuf));
}

/**
 * Derive a WTC address from a 32-byte private key buffer.
 *
 * @param {Buffer} privKeyBuf  32-byte private key
 * @returns {string}  "wtc1q..."
 */
function addressFromPrivateKey(privKeyBuf) {
  return encodeAddress(hash160(privateKeyToPublicKey(privKeyBuf)));
}

/**
 * Generate a fresh secp256k1 keypair with a native WTC address.
 *
 * @returns {{ privateKey: string, publicKey: string, address: string }}
 *   privateKey  64-char hex (32 bytes) — keep secret
 *   publicKey   66-char hex (33 bytes, compressed)
 *   address     "wtc1q..." (44 chars)
 */
function generateKeypair() {
  let privKeyBuf;
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = crypto.randomBytes(32);
    const k = BigInt('0x' + candidate.toString('hex'));
    if (k > 0n && k < _N) { privKeyBuf = candidate; break; }
  }
  if (!privKeyBuf) throw new Error('generateKeypair: RNG failure (32 attempts)');
  const pubKeyBuf = privateKeyToPublicKey(privKeyBuf);
  return {
    privateKey: privKeyBuf.toString('hex'),
    publicKey:  pubKeyBuf.toString('hex'),
    address:    encodeAddress(hash160(pubKeyBuf)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ECDSA signing and verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign a 32-byte message hash with a secp256k1 private key.
 * Uses canonical low-s form to prevent signature malleability.
 *
 * @param {Buffer}        hash32   32-byte message hash
 * @param {Buffer|string} privKey  32-byte private key (Buffer or 64-char hex)
 * @returns {{ r: string, s: string, v: number }}
 *   r, s  64-char hex (32 bytes each)
 *   v     recovery id: 0 or 1
 */
function sign(hash32, privKey) {
  const privBuf = typeof privKey === 'string' ? Buffer.from(privKey, 'hex') : privKey;
  if (!Buffer.isBuffer(hash32) || hash32.length !== 32) throw new Error('sign: hash must be 32 bytes');
  if (!Buffer.isBuffer(privBuf) || privBuf.length !== 32) throw new Error('sign: privKey must be 32 bytes');
  const d    = BigInt('0x' + privBuf.toString('hex'));
  const hash = BigInt('0x' + hash32.toString('hex'));
  for (let attempt = 0; attempt < 64; attempt++) {
    const k = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
    if (k <= 0n || k >= _N) continue;
    const Rpt = _jacToAff(_ptMul(k, [_Gx, _Gy]));
    if (!Rpt) continue;
    const r = _modN(Rpt[0]);
    if (r === 0n) continue;
    const s = _modN(_invN(k) * _modN(hash + r * d));
    if (s === 0n) continue;
    // Normalise to low-s (canonical form)
    const sLow = s > _N / 2n ? _modN(_N - s) : s;
    const v    = Number(Rpt[1] & 1n) ^ (s !== sLow ? 1 : 0);
    return {
      r: r.toString(16).padStart(64, '0'),
      s: sLow.toString(16).padStart(64, '0'),
      v,
    };
  }
  throw new Error('sign: failed to generate valid nonce after 64 attempts');
}

/**
 * Verify that a signature was produced by the private key whose address is given.
 * Recovers the public key from (r, s, v) + hash and checks that its address matches.
 *
 * @param {Buffer}        hash32   32-byte message hash (same as passed to sign())
 * @param {{ r, s, v }}   sig      Signature from sign()
 * @param {string}        address  WTC address ("wtc1q...")
 * @returns {boolean}
 */
function verifySignature(hash32, sig, address) {
  try {
    if (!Buffer.isBuffer(hash32) || hash32.length !== 32) return false;
    const r = BigInt('0x' + String(sig && sig.r || ''));
    const s = BigInt('0x' + String(sig && sig.s || ''));
    if (r <= 0n || r >= _N || s <= 0n || s >= _N) return false;
    if (s > _N / 2n) return false; // reject non-canonical high-s
    const expectedH160 = decodeAddressToHash160(address);
    if (!expectedH160) return false;
    // Try both recovery ids — v tells us the right one, but we check both for robustness
    for (let recid = 0; recid <= 1; recid++) {
      const pt = _recoverPublicKey(hash32, r, s, recid);
      if (!pt) continue;
      const prefix = (pt[1] & 1n) === 0n ? 0x02 : 0x03;
      const pubKey = Buffer.concat([
        Buffer.from([prefix]),
        Buffer.from(pt[0].toString(16).padStart(64, '0'), 'hex'),
      ]);
      if (hash160(pubKey).equals(expectedH160)) return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Standard double-SHA-256 hash for blocks and transactions.
 * SHA-256(SHA-256(data)) → 32-byte Buffer.
 *
 * @param {Buffer|string} data  Raw bytes or UTF-8 string
 * @returns {Buffer}  32-byte hash
 */
function txHash(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

module.exports = {
  // Keypair & address generation
  generateKeypair,
  addressFromPrivateKey,
  addressFromPublicKey,
  encodeAddress,
  decodeAddressToHash160,
  isValidAddress,
  // Signing
  sign,
  verifySignature,
  txHash,
  // Lower-level (used by chain modules)
  privateKeyToPublicKey,
  hash160,
};
