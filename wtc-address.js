// SPDX-License-Identifier: MIT
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
 *   → secp256k1 (elliptic) → 33-byte compressed public key
 *   → SHA-256 → RIPEMD-160 → 20-byte hash160
 *   → bech32m_encode("wtc", v0, hash160) → "wtc1q..."
 *
 * Signatures: secp256k1 ECDSA, canonical low-s, with recovery id.
 */

const crypto = require('crypto');
const EC = require('elliptic').ec;
const ec = new EC('secp256k1');

// ─────────────────────────────────────────────────────────────────────────────
// Key operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a 33-byte compressed secp256k1 public key from a 32-byte private key.
 */
function privateKeyToPublicKey(privKeyBuf) {
  const key = ec.keyFromPrivate(privKeyBuf);
  return Buffer.from(key.getPublic(true, 'hex'), 'hex');
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
  const data = [0, ...words];
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
  const payload = data.slice(0, -6);
  if (payload.length < 1 || payload[0] !== 0) return null;
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
  const key = ec.genKeyPair();
  const privHex = key.getPrivate('hex').padStart(64, '0');
  const pubHex = key.getPublic(true, 'hex');
  return {
    privateKey: privHex,
    publicKey: pubHex,
    address: encodeAddress(hash160(Buffer.from(pubHex, 'hex'))),
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
  const key = ec.keyFromPrivate(privBuf);
  const sig = key.sign(hash32, { canonical: true });
  return {
    r: sig.r.toString(16, 64),
    s: sig.s.toString(16, 64),
    v: sig.recoveryParam,
  };
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
    const expectedH160 = decodeAddressToHash160(address);
    if (!expectedH160) return false;
    for (let recid = 0; recid <= 3; recid++) {
      try {
        const recovered = ec.recoverPubKey(hash32, sig, recid);
        const pubKey = Buffer.from(recovered.encode('hex', true), 'hex');
        if (hash160(pubKey).equals(expectedH160)) return true;
      } catch (_) { continue; }
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

// ── Bitcoin Signed Message verification ──────────────────────────────────────
function _encodeVarint(n) {
  if (n < 0xfd) return Buffer.from([n]);
  const b = Buffer.alloc(n <= 0xffff ? 3 : 5);
  if (n <= 0xffff) { b[0] = 0xfd; b.writeUInt16LE(n, 1); } else { b[0] = 0xfe; b.writeUInt32LE(n, 1); }
  return b;
}

function _msgHashForVerify(message) {
  const magic = 'Bitcoin Signed Message:\n';
  const msgBuf = Buffer.from(message, 'utf8');
  const full = Buffer.concat([Buffer.from([magic.length]), Buffer.from(magic), _encodeVarint(msgBuf.length), msgBuf]);
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(full).digest()).digest();
}

const _BASE58_ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function _base58Encode(bytes) {
  let n = BigInt('0x' + (bytes.length ? bytes.toString('hex') : '00'));
  let s = '';
  while (n > 0n) { s = _BASE58_ALPHA[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

/**
 * Verify a Bitcoin-style signed message against a base58 address.
 * Signature format: base64(flag[1] + r[32] + s[32]), flag ∈ {27..34}
 * Message magic: "Bitcoin Signed Message:\n"
 * Address prefixes: mainnet=0x00, testnet/regtest=0x6F
 */
function verifyWalletMessagePureJS(address, signature, message, network) {
  try {
    const sigBuf = Buffer.from(signature, 'base64');
    if (sigBuf.length !== 65) return false;
    const flag = sigBuf[0];
    if (flag < 27 || flag > 34) return false;
    const recid = (flag - 27) & 3;
    const msgHash = _msgHashForVerify(message);
    const sigObj = { r: sigBuf.slice(1, 33).toString('hex'), s: sigBuf.slice(33, 65).toString('hex') };
    const point = ec.recoverPubKey(msgHash, sigObj, recid);
    if (!point) return false;
    const pubkey = Buffer.from(point.encodeCompressed());
    const h160 = crypto.createHash('ripemd160').update(crypto.createHash('sha256').update(pubkey).digest()).digest();
    const vByte = ((network || 'wtc-mainnet') === 'mainnet') ? 0x00 : 0x6f;
    const versioned = Buffer.concat([Buffer.from([vByte]), h160]);
    const checksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(versioned).digest()).digest().slice(0, 4);
    return _base58Encode(Buffer.concat([versioned, checksum])) === address;
  } catch (_) {
    return false;
  }
}

module.exports = {
  generateKeypair,
  addressFromPrivateKey,
  addressFromPublicKey,
  encodeAddress,
  decodeAddressToHash160,
  isValidAddress,
  sign,
  verifySignature,
  txHash,
  privateKeyToPublicKey,
  hash160,
  verifyWalletMessagePureJS,
};
