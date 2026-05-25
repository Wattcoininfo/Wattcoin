// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const {
  generateKeypair,
  addressFromPrivateKey,
  addressFromPublicKey,
  encodeAddress,
  decodeAddressToHash160,
  isValidAddress,
  sign,
  verifySignature,
  txHash,
  hash160,
  privateKeyToPublicKey,
} = require('../wtc-address');

const VALID_ADDRESS = generateKeypair().address;

function describe(name, fn) {
  fn();
}

function it(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => console.log(`  ✓ ${name}`),
        (e) => { console.error(`  ✗ ${name}: ${e.message}`); throw e; }
      );
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

describe('wtc-address — key generation', () => {

  it('generateKeypair returns a valid keypair', () => {
    const kp = generateKeypair();
    assert.ok(kp.privateKey, 'privateKey must be present');
    assert.ok(kp.publicKey, 'publicKey must be present');
    assert.ok(kp.address, 'address must be present');
    assert.strictEqual(kp.privateKey.length, 64, 'privateKey should be 64 hex chars (32 bytes)');
    assert.strictEqual(kp.publicKey.length, 66, 'publicKey should be 66 hex chars (33 bytes)');
    assert.ok(kp.address.startsWith('wtc1q'), 'address should start with wtc1q');
    assert.strictEqual(kp.address.length, 43, 'address should be 43 chars');
  });

  it('generateKeypair produces unique keys each time', () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    assert.notStrictEqual(kp1.privateKey, kp2.privateKey);
    assert.notStrictEqual(kp1.address, kp2.address);
  });

  it('addressFromPrivateKey derives correct address', () => {
    const kp = generateKeypair();
    const privBuf = Buffer.from(kp.privateKey, 'hex');
    const derivedAddr = addressFromPrivateKey(privBuf);
    assert.strictEqual(derivedAddr, kp.address);
  });

  it('addressFromPublicKey derives correct address', () => {
    const kp = generateKeypair();
    const pubBuf = Buffer.from(kp.publicKey, 'hex');
    const derivedAddr = addressFromPublicKey(pubBuf);
    assert.strictEqual(derivedAddr, kp.address);
  });

  it('addressFromPrivateKey and addressFromPublicKey produce the same address', () => {
    const privHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const privBuf = Buffer.from(privHex, 'hex');
    const pubBuf = privateKeyToPublicKey(privBuf);
    const addrFromPriv = addressFromPrivateKey(privBuf);
    const addrFromPub = addressFromPublicKey(pubBuf);
    assert.strictEqual(addrFromPriv, addrFromPub);
  });

  it('privateKeyToPublicKey returns 33-byte compressed key', () => {
    const privBuf = crypto.randomBytes(32);
    const pub = privateKeyToPublicKey(privBuf);
    assert.ok(Buffer.isBuffer(pub));
    assert.strictEqual(pub.length, 33);
    assert.ok(pub[0] === 0x02 || pub[0] === 0x03, 'compressed key should start with 0x02 or 0x03');
  });

});

describe('wtc-address — address encoding/decoding', () => {

  it('encodeAddress produces valid addresses', () => {
    const h160 = crypto.randomBytes(20);
    const addr = encodeAddress(h160);
    assert.ok(addr.startsWith('wtc1q'));
    assert.strictEqual(addr.length, 43);
  });

  it('encodeAddress throws on non-20-byte input', () => {
    assert.throws(() => encodeAddress(Buffer.alloc(19)), /20.*byte/);
    assert.throws(() => encodeAddress(Buffer.alloc(21)), /20.*byte/);
    assert.throws(() => encodeAddress('not-a-buffer'), /20.*byte/);
  });

  it('decodeAddressToHash160 round-trips correctly', () => {
    const original = crypto.randomBytes(20);
    const addr = encodeAddress(original);
    const decoded = decodeAddressToHash160(addr);
    assert.ok(Buffer.isBuffer(decoded));
    assert.strictEqual(decoded.length, 20);
    assert.ok(original.equals(decoded));
  });

  it('decodeAddressToHash160 returns null for invalid addresses', () => {
    assert.strictEqual(decodeAddressToHash160(''), null);
    assert.strictEqual(decodeAddressToHash160('not-an-address'), null);
    assert.strictEqual(decodeAddressToHash160('btc1q...'), null);
    assert.strictEqual(decodeAddressToHash160(123), null);
  });

  it('isValidAddress validates correctly', () => {
    assert.ok(isValidAddress(VALID_ADDRESS));
    const kp = generateKeypair();
    assert.ok(isValidAddress(kp.address));
    assert.ok(!isValidAddress(''));
    assert.ok(!isValidAddress('invalid'));
    assert.ok(!isValidAddress('btc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0'));
  });

});

describe('wtc-address — hash160', () => {

  it('hash160 returns 20-byte buffer', () => {
    const result = hash160(Buffer.from('hello', 'utf8'));
    assert.ok(Buffer.isBuffer(result));
    assert.strictEqual(result.length, 20);
  });

  it('hash160 is deterministic', () => {
    const input = Buffer.from('test data', 'utf8');
    assert.ok(hash160(input).equals(hash160(input)));
  });

  it('hash160 produces different output for different inputs', () => {
    const a = hash160(Buffer.from('input A', 'utf8'));
    const b = hash160(Buffer.from('input B', 'utf8'));
    assert.ok(!a.equals(b));
  });

});

describe('wtc-address — txHash (double-SHA256)', () => {

  it('txHash returns 32-byte buffer', () => {
    const h = txHash(Buffer.from('data', 'utf8'));
    assert.ok(Buffer.isBuffer(h));
    assert.strictEqual(h.length, 32);
  });

  it('txHash accepts both Buffer and string', () => {
    const fromBuf = txHash(Buffer.from('hello', 'utf8'));
    const fromStr = txHash('hello');
    assert.ok(fromBuf.equals(fromStr));
  });

  it('txHash is deterministic', () => {
    assert.ok(txHash('same').equals(txHash('same')));
  });

});

describe('wtc-address — ECDSA signing and verification', () => {

  it('sign produces valid signature structure', () => {
    const kp = generateKeypair();
    const msg = txHash('test message');
    const sig = sign(msg, Buffer.from(kp.privateKey, 'hex'));
    assert.ok(typeof sig.r === 'string', 'r should be hex string');
    assert.ok(typeof sig.s === 'string', 's should be hex string');
    assert.ok(typeof sig.v === 'number', 'v should be number');
    assert.strictEqual(sig.r.length, 64);
    assert.strictEqual(sig.s.length, 64);
    assert.ok(sig.v === 0 || sig.v === 1);
  });

  it('verifySignature succeeds for valid signature', () => {
    const kp = generateKeypair();
    const msg = txHash('message to sign');
    const sig = sign(msg, Buffer.from(kp.privateKey, 'hex'));
    const ok = verifySignature(msg, sig, kp.address);
    assert.ok(ok, 'should verify valid signature');
  });

  it('verifySignature fails for wrong message', () => {
    const kp = generateKeypair();
    const msg1 = txHash('message one');
    const msg2 = txHash('message two');
    const sig = sign(msg1, Buffer.from(kp.privateKey, 'hex'));
    const ok = verifySignature(msg2, sig, kp.address);
    assert.ok(!ok, 'should reject signature for wrong message');
  });

  it('verifySignature fails for wrong address', () => {
    const kp = generateKeypair();
    const kp2 = generateKeypair();
    const msg = txHash('test');
    const sig = sign(msg, Buffer.from(kp.privateKey, 'hex'));
    const ok = verifySignature(msg, sig, kp2.address);
    assert.ok(!ok, 'should reject signature from wrong key');
  });

  it('sign/verify round-trip with 32-byte hash', () => {
    const kp = generateKeypair();
    const hash32 = crypto.randomBytes(32);
    const sig = sign(hash32, Buffer.from(kp.privateKey, 'hex'));
    assert.ok(verifySignature(hash32, sig, kp.address));
  });

  it('sign throws on invalid inputs', () => {
    assert.throws(() => sign(Buffer.alloc(31), Buffer.alloc(32)), /32 bytes/);
    assert.throws(() => sign(Buffer.alloc(32), Buffer.alloc(31)), /32 bytes/);
  });

  it('verifySignature returns false for garbage inputs', () => {
    assert.ok(!verifySignature(Buffer.alloc(32), { r: '0', s: '0', v: 99 }, VALID_ADDRESS));
    assert.ok(!verifySignature('bad', { r: '0', s: '0', v: 0 }, VALID_ADDRESS));
  });

  it('verifySignature produces canonical low-s signatures', () => {
    // secp256k1 order
    const secp256k1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
    const halfOrder = secp256k1_N / 2n;
    for (let i = 0; i < 5; i++) {
      const kp = generateKeypair();
      const msg = txHash(`canonical test ${i}`);
      const sig = sign(msg, Buffer.from(kp.privateKey, 'hex'));
      const s = BigInt('0x' + sig.s);
      assert.ok(s <= halfOrder, `s value ${s} should be <= half order (low-s form)`);
    }
  });

});

describe('wtc-address — isValidAddress edge cases', () => {

  it('rejects addresses with wrong HRP', () => {
    assert.ok(!isValidAddress('btc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0'));
  });

  it('rejects empty strings', () => {
    assert.ok(!isValidAddress(''));
  });

  it('rejects null/undefined', () => {
    assert.ok(!isValidAddress(null));
    assert.ok(!isValidAddress(undefined));
  });

  it('rejects wrong-length addresses', () => {
    assert.ok(!isValidAddress('wtc1q'));
    assert.ok(!isValidAddress(VALID_ADDRESS + 'extra'));
  });

  it('rejects addresses with invalid checksum', () => {
    const addr = generateKeypair().address;
    const mangled = addr.slice(0, -1) + 'a';
    assert.ok(!isValidAddress(mangled));
  });

});

function run() {
  const tests = [
    describe,
  ];
  let passed = 0;
  let failed = 0;
  for (const [, fn] of Object.entries(tests)) {
    try { fn(); passed++; } catch (e) { failed++; }
  }
  if (failed > 0) process.exit(1);
}

if (require.main === module) run();
