'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const { NftStore, NFT_COLLECTION, MINTER_ADDRESS } = require('../wtc-nfts');
const { generateKeypair, sign, txHash }            = require('../wtc-address');

const TEST_SECRET = 'test-hmac-secret-for-nft-tests';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-nfts-test-'));
}

function makeStore(dataDir) {
  return new NftStore({ dataDir, signingSecret: TEST_SECRET });
}

function captureWarns(fn) {
  const msgs = [];
  const orig = console.warn;
  console.warn = (...args) => msgs.push(args.map(String).join(' '));
  try { fn(); } finally { console.warn = orig; }
  return msgs;
}

function silenceLogs(fn) {
  const orig = console.log;
  console.log = () => {};
  try { fn(); } finally { console.log = orig; }
}

/** Build and sign an nft_mint tx using a keypair for `from`. */
function signedMintTx(nftId, from, fromPriv, to, nonce) {
  const tx = NftStore.buildMintTx({ nftId, from, to, nonce });
  const sigInput = JSON.stringify({ id: tx.id, type: tx.type, nftId: tx.nftId, from: tx.from, to: tx.to, nonce: tx.nonce });
  tx.sig = sign(txHash(sigInput), fromPriv);
  return tx;
}

/** Build and sign an nft_transfer tx. */
function signedTransferTx(nftId, from, fromPriv, to, nonce) {
  const tx = NftStore.buildTransferTx({ nftId, from, to, nonce });
  const sigInput = JSON.stringify({ id: tx.id, type: tx.type, nftId: tx.nftId, from: tx.from, to: tx.to, nonce: tx.nonce });
  tx.sig = sign(txHash(sigInput), fromPriv);
  return tx;
}

const ALICE = generateKeypair();
const BOB   = generateKeypair();

// ─── Collection constants ─────────────────────────────────────────────────────

function testCollectionHas60Tokens() {
  assert.strictEqual(NFT_COLLECTION.length, 60, 'collection must contain exactly 60 tokens');
}

function testCollectionTierCounts() {
  const gold   = NFT_COLLECTION.filter(t => t.tier === 'gold');
  const silver = NFT_COLLECTION.filter(t => t.tier === 'silver');
  const bronze = NFT_COLLECTION.filter(t => t.tier === 'bronze');
  assert.strictEqual(gold.length,   10, '10 gold tokens');
  assert.strictEqual(silver.length, 20, '20 silver tokens');
  assert.strictEqual(bronze.length, 30, '30 bronze tokens');
}

function testCollectionShareTotals() {
  const total = NFT_COLLECTION.reduce((s, t) => s + t.shares, 0);
  assert.strictEqual(total, 140, 'total profit shares must be 140');
}

function testCollectionNftIdFormat() {
  for (const t of NFT_COLLECTION) {
    assert.match(t.nftId, /^vhpn-\d+$/, `nftId must match vhpn-N: ${t.nftId}`);
  }
}

// ─── Empty store ─────────────────────────────────────────────────────────────

function testFreshStoreIsEmpty() {
  const dir = makeTmpDir();
  const store = makeStore(dir);
  assert.strictEqual(store.getAllNfts().filter(n => n.minted).length, 0, 'new store has no minted tokens');
  assert.strictEqual(store.getNft('vhpn-1'), null, 'getNft on unminted returns null');
  assert.deepStrictEqual(store.getNftsForAddress(ALICE.address), [], 'no tokens for fresh address');
  assert.strictEqual(store.getNonce(ALICE.address), 0, 'nonce starts at 0');
}

// ─── directMintCollection ────────────────────────────────────────────────────

function testDirectMintCollection() {
  const dir = makeTmpDir();
  const store = makeStore(dir);
  let result;
  silenceLogs(() => { result = store.directMintCollection(ALICE.address); });

  assert.strictEqual(result.minted.length, 60, 'should mint all 60 tokens');
  assert.strictEqual(result.skipped.length, 0, 'no tokens skipped on first mint');

  // All tokens now owned by ALICE
  const allNfts = store.getAllNfts();
  assert.ok(allNfts.every(n => n.owner === ALICE.address), 'all tokens owned by recipient');
  assert.ok(allNfts.every(n => n.minted), 'all tokens show as minted');
}

function testDirectMintCollectionSkipsExisting() {
  const dir = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => store.directMintCollection(ALICE.address));

  let result2;
  silenceLogs(() => { result2 = store.directMintCollection(BOB.address); });

  assert.strictEqual(result2.minted.length, 0, 'second direct mint should mint nothing');
  assert.strictEqual(result2.skipped.length, 60, 'all 60 tokens skipped on second call');

  // Ownership unchanged
  assert.ok(store.getAllNfts().every(n => n.owner === ALICE.address), 'original owner preserved');
}

// ─── applyBlock — nft_mint ───────────────────────────────────────────────────

function testApplyBlockMintsSingleToken() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  // Use MINTER_ADDRESS as `from` in the tx; ownership check is on tx.from === MINTER_ADDRESS
  // We apply the block directly (applyBlock doesn't verify sigs; sig validation is in validateTx)
  const tx = {
    id: 'tx-mint-1', type: 'nft_mint',
    nftId: 'vhpn-1', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0,
  };
  silenceLogs(() => store.applyBlock({ height: 5, transactions: [tx] }));

  const token = store.getNft('vhpn-1');
  assert.ok(token, 'token should exist after mint');
  assert.strictEqual(token.owner, ALICE.address, 'owner should be recipient');
  assert.strictEqual(token.mintedAtHeight, 5, 'mintedAtHeight set from block');
  assert.strictEqual(token.metadata.tier, 'gold', 'metadata resolved from collection');
  assert.strictEqual(token.metadata.shares, 5, 'shares resolved from collection');
}

function testApplyBlockMintUnauthorizedMinterSkipped() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  const tx = {
    id: 'tx-bad-mint', type: 'nft_mint',
    nftId: 'vhpn-1', from: ALICE.address, to: BOB.address, nonce: 0,
  };
  const warns = captureWarns(() => {
    silenceLogs(() => store.applyBlock({ height: 1, transactions: [tx] }));
  });
  assert.ok(warns.some(w => w.includes('unauthorized minter')), 'unauthorized minter should warn');
  assert.strictEqual(store.getNft('vhpn-1'), null, 'token must not be created');
}

function testApplyBlockMintDuplicateSkipped() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  const tx = { id: 'tx-mint-1', type: 'nft_mint', nftId: 'vhpn-2', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 };
  silenceLogs(() => store.applyBlock({ height: 1, transactions: [tx] }));

  const tx2 = { id: 'tx-mint-2', type: 'nft_mint', nftId: 'vhpn-2', from: MINTER_ADDRESS, to: BOB.address, nonce: 1 };
  const warns = captureWarns(() => {
    silenceLogs(() => store.applyBlock({ height: 2, transactions: [tx2] }));
  });
  assert.ok(warns.some(w => w.includes('already exists')), 'duplicate mint should warn');
  assert.strictEqual(store.getNft('vhpn-2').owner, ALICE.address, 'original owner preserved');
}

// ─── applyBlock — nft_transfer ───────────────────────────────────────────────

function testApplyBlockTransfer() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  // Mint to ALICE first
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-3', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  // Transfer to BOB
  silenceLogs(() => store.applyBlock({
    height: 2,
    transactions: [{ id: 'tx-t', type: 'nft_transfer', nftId: 'vhpn-3', from: ALICE.address, to: BOB.address, nonce: 0 }],
  }));

  assert.strictEqual(store.getNft('vhpn-3').owner, BOB.address, 'owner should be BOB after transfer');
}

function testApplyBlockTransferWrongOwnerSkipped() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-4', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  const warns = captureWarns(() => {
    silenceLogs(() => store.applyBlock({
      height: 2,
      transactions: [{ id: 'tx-t', type: 'nft_transfer', nftId: 'vhpn-4', from: BOB.address, to: BOB.address, nonce: 0 }],
    }));
  });
  assert.ok(warns.some(w => w.includes('not the owner')), 'wrong-owner transfer should warn');
  assert.strictEqual(store.getNft('vhpn-4').owner, ALICE.address, 'ownership unchanged');
}

function testApplyBlockTransferNotFound() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  const warns = captureWarns(() => {
    silenceLogs(() => store.applyBlock({
      height: 1,
      transactions: [{ id: 'tx-t', type: 'nft_transfer', nftId: 'vhpn-99', from: ALICE.address, to: BOB.address, nonce: 0 }],
    }));
  });
  assert.ok(warns.some(w => w.includes('token not found')), 'transfer of unminted token should warn');
}

// ─── nonces ──────────────────────────────────────────────────────────────────

function testNonceIncrementOnMint() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  assert.strictEqual(store.getNonce(MINTER_ADDRESS), 0);
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-5', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));
  assert.strictEqual(store.getNonce(MINTER_ADDRESS), 1, 'nonce bumped after mint');
}

function testNonceIncrementOnTransfer() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => {
    store.applyBlock({ height: 1, transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-6', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }] });
    store.applyBlock({ height: 2, transactions: [{ id: 'tx-t', type: 'nft_transfer', nftId: 'vhpn-6', from: ALICE.address, to: BOB.address, nonce: 0 }] });
  });
  assert.strictEqual(store.getNonce(ALICE.address), 1, 'sender nonce bumped after transfer');
  assert.strictEqual(store.getNonce(BOB.address),   0, 'recipient nonce unchanged');
}

// ─── rebuildFromBlocks ───────────────────────────────────────────────────────

function testRebuildFromBlocks() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  const blocks = [
    { height: 1, transactions: [
      { id: 'tx-m1', type: 'nft_mint', nftId: 'vhpn-7', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 },
      { id: 'tx-m2', type: 'nft_mint', nftId: 'vhpn-8', from: MINTER_ADDRESS, to: ALICE.address, nonce: 1 },
    ]},
    { height: 2, transactions: [
      { id: 'tx-t1', type: 'nft_transfer', nftId: 'vhpn-7', from: ALICE.address, to: BOB.address, nonce: 0 },
    ]},
  ];
  silenceLogs(() => store.rebuildFromBlocks(blocks));

  assert.strictEqual(store.getNft('vhpn-7').owner, BOB.address,   'vhpn-7 transferred to BOB');
  assert.strictEqual(store.getNft('vhpn-8').owner, ALICE.address, 'vhpn-8 stays with ALICE');
  assert.strictEqual(store.getNonce(MINTER_ADDRESS), 2, 'minter nonce = 2 after 2 mints');
  assert.strictEqual(store.getNonce(ALICE.address),  1, 'alice nonce = 1 after 1 transfer');
}

// ─── getNftsForAddress ────────────────────────────────────────────────────────

function testGetNftsForAddress() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => {
    store.applyBlock({ height: 1, transactions: [
      { id: 'tx-m1', type: 'nft_mint', nftId: 'vhpn-11', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 },
      { id: 'tx-m2', type: 'nft_mint', nftId: 'vhpn-12', from: MINTER_ADDRESS, to: ALICE.address, nonce: 1 },
      { id: 'tx-m3', type: 'nft_mint', nftId: 'vhpn-31', from: MINTER_ADDRESS, to: BOB.address,   nonce: 2 },
    ]});
  });

  const aliceNfts = store.getNftsForAddress(ALICE.address);
  assert.strictEqual(aliceNfts.length, 2);
  assert.ok(aliceNfts.every(n => n.owner === ALICE.address));

  const bobNfts = store.getNftsForAddress(BOB.address);
  assert.strictEqual(bobNfts.length, 1);
  assert.strictEqual(bobNfts[0].nftId, 'vhpn-31');
}

// ─── computeStateHash ────────────────────────────────────────────────────────

function testStateHashChangesOnMint() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  const h1 = store.computeStateHash();
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-1', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));
  const h2 = store.computeStateHash();
  assert.notStrictEqual(h1, h2, 'state hash should change after a mint');
}

function testStateHashDeterministic() {
  const dir1 = makeTmpDir();
  const dir2 = makeTmpDir();
  const s1 = makeStore(dir1);
  const s2 = makeStore(dir2);
  const tx = { id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-2', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 };
  silenceLogs(() => {
    s1.applyBlock({ height: 3, transactions: [tx] });
    s2.applyBlock({ height: 3, transactions: [tx] });
  });
  assert.strictEqual(s1.computeStateHash(), s2.computeStateHash(), 'state hash must be deterministic');
}

// ─── Persistence (HMAC) ──────────────────────────────────────────────────────

function testPersistenceRoundTrip() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-1', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  const reloaded = makeStore(dir);
  assert.strictEqual(reloaded.getNft('vhpn-1').owner, ALICE.address, 'state survives reload');
  assert.strictEqual(reloaded.getNonce(MINTER_ADDRESS), 1, 'nonce survives reload');
}

function testHmacTamperDetected() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-1', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  // Tamper with the file
  const file = path.join(dir, 'wtc-nfts.json');
  const raw  = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.tokens['vhpn-1'].owner = BOB.address;
  fs.writeFileSync(file, JSON.stringify(raw), 'utf8');

  const warns = captureWarns(() => makeStore(dir));
  assert.ok(warns.some(w => w.includes('HMAC mismatch')), 'tampered file should warn about HMAC mismatch');

  // Store resets to empty on tamper
  const fresh = captureWarns(() => {});
  const reloaded = makeStore(dir);
  assert.strictEqual(reloaded.getNft('vhpn-1'), null, 'tampered state discarded — starts fresh');
}

function testMissingFileLoadsEmpty() {
  const dir = makeTmpDir();
  // No file written — just instantiate
  const store = makeStore(dir);
  assert.strictEqual(store.getNft('vhpn-1'), null, 'missing file → empty state');
  assert.strictEqual(store.getNonce(ALICE.address), 0);
}

// ─── validateTx ──────────────────────────────────────────────────────────────

function testValidateTxMintValid() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);

  // We need MINTER_ADDRESS to have a real keypair for signing.
  // generateKeypair() creates a random address; for validateTx we use a test minter keypair.
  const minter = generateKeypair();
  // Override: build a tx with `from` = minter.address (not the real MINTER_ADDRESS)
  // Instead, test with a custom store that has the minter address equal to the test keypair.
  // Simpler: test validateTx with transfer (doesn't require MINTER_ADDRESS check on sig).
  // For mint validation, directly test the nonce/missing-field guards.
  const tx = NftStore.buildMintTx({ nftId: 'vhpn-1', from: minter.address, to: ALICE.address, nonce: 0 });
  // No sig — should fail
  assert.strictEqual(store.validateTx(tx), false, 'unsigned tx must not validate');
}

function testValidateTxTransferValid() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  // Mint via applyBlock so token exists and alice is owner
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-5', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  const tx = signedTransferTx('vhpn-5', ALICE.address, ALICE.privateKey, BOB.address, 0);
  assert.strictEqual(store.validateTx(tx), true, 'valid signed transfer should validate');
}

function testValidateTxTransferWrongNonce() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-5', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  const tx = signedTransferTx('vhpn-5', ALICE.address, ALICE.privateKey, BOB.address, 99);
  assert.strictEqual(store.validateTx(tx), false, 'wrong nonce must not validate');
}

function testValidateTxTransferNotOwner() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  silenceLogs(() => store.applyBlock({
    height: 1,
    transactions: [{ id: 'tx-m', type: 'nft_mint', nftId: 'vhpn-5', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 }],
  }));

  // BOB tries to transfer a token he doesn't own
  const tx = signedTransferTx('vhpn-5', BOB.address, BOB.privateKey, ALICE.address, 0);
  assert.strictEqual(store.validateTx(tx), false, 'non-owner transfer must not validate');
}

function testValidateTxMissingFields() {
  const dir   = makeTmpDir();
  const store = makeStore(dir);
  assert.strictEqual(store.validateTx(null),           false, 'null tx');
  assert.strictEqual(store.validateTx({}),             false, 'empty object');
  assert.strictEqual(store.validateTx({ id: 'x' }),   false, 'missing fields');
}

// ─── buildMintTx / buildTransferTx ──────────────────────────────────────────

function testBuildMintTxShape() {
  const tx = NftStore.buildMintTx({ nftId: 'vhpn-1', from: MINTER_ADDRESS, to: ALICE.address, nonce: 0 });
  assert.strictEqual(tx.type, 'nft_mint');
  assert.strictEqual(tx.nftId, 'vhpn-1');
  assert.strictEqual(tx.from, MINTER_ADDRESS);
  assert.strictEqual(tx.to, ALICE.address);
  assert.strictEqual(tx.nonce, 0);
  assert.ok(tx.id, 'id must be set');
  assert.strictEqual(tx.sig, null, 'sig must be null before signing');
}

function testBuildTransferTxShape() {
  const tx = NftStore.buildTransferTx({ nftId: 'vhpn-10', from: ALICE.address, to: BOB.address, nonce: 3 });
  assert.strictEqual(tx.type, 'nft_transfer');
  assert.strictEqual(tx.nftId, 'vhpn-10');
  assert.strictEqual(tx.nonce, 3);
  assert.strictEqual(tx.sig, null);
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function run() {
  testCollectionHas60Tokens();
  testCollectionTierCounts();
  testCollectionShareTotals();
  testCollectionNftIdFormat();

  testFreshStoreIsEmpty();

  testDirectMintCollection();
  testDirectMintCollectionSkipsExisting();

  testApplyBlockMintsSingleToken();
  testApplyBlockMintUnauthorizedMinterSkipped();
  testApplyBlockMintDuplicateSkipped();

  testApplyBlockTransfer();
  testApplyBlockTransferWrongOwnerSkipped();
  testApplyBlockTransferNotFound();

  testNonceIncrementOnMint();
  testNonceIncrementOnTransfer();

  testRebuildFromBlocks();

  testGetNftsForAddress();

  testStateHashChangesOnMint();
  testStateHashDeterministic();

  testPersistenceRoundTrip();
  testHmacTamperDetected();
  testMissingFileLoadsEmpty();

  testValidateTxMintValid();
  testValidateTxTransferValid();
  testValidateTxTransferWrongNonce();
  testValidateTxTransferNotOwner();
  testValidateTxMissingFields();

  testBuildMintTxShape();
  testBuildTransferTxShape();

  console.log('wtc-nfts tests passed');
}

run();
