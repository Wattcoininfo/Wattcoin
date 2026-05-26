'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { Chain, computeBlockHash: _computeBlockHash, GENESIS_PREMINE } = require('../wtc-chain');

const TEST_SECRET = 'test-hmac-secret-for-chain-corruption-tests';
const TEAM_WALLET = 'wtc1q-test-team-wallet';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-chain-test-'));
}

function makeChain(dataDir) {
  return new Chain({ dataDir, signingSecret: TEST_SECRET });
}

/** Capture console.warn calls while fn() runs.  Restores original after. */
function captureWarns(fn) {
  const msgs = [];
  const orig = console.warn;
  console.warn = (...args) => msgs.push(args.map(String).join(' '));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return msgs;
}

function seedGenesisChain(dataDir) {
  const chain = makeChain(dataDir);
  chain.genesis({ teamWallets: [{ address: TEAM_WALLET, amount: GENESIS_PREMINE }] });
  return chain;
}

function chainFilePath(dataDir) {
  return path.join(dataDir, 'wtc-chain.ndjson');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function testCleanChainLoadsWithNoWarnings() {
  const dir = makeTmpDir();
  seedGenesisChain(dir);

  const warns = captureWarns(() => makeChain(dir));
  assert.strictEqual(warns.length, 0, 'clean chain reload should produce no warnings');

  const reloaded = makeChain(dir);
  assert.strictEqual(reloaded.getHeight(), 0, 'clean reload should restore genesis (height 0)');
}

function testCorruptJsonLineTruncatesChain() {
  const dir = makeTmpDir();
  seedGenesisChain(dir);
  fs.appendFileSync(chainFilePath(dir), 'NOT_VALID_JSON\n', 'utf8');

  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.ok(
    warns.some((m) => m.includes('Corrupt line')),
    'corrupt JSON should produce a "Corrupt line" warning',
  );
  assert.strictEqual(chain.getHeight(), 0, 'blocks before corrupt line should be preserved');
}

function testHmacTamperDetectedTruncatesChain() {
  const dir = makeTmpDir();
  seedGenesisChain(dir);

  const file = chainFilePath(dir);
  const rawLines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const stored = JSON.parse(rawLines[0]);
  const { _sig, ...block } = stored;

  // Modify a non-canonical field (votes) so the block hash remains valid
  // but the HMAC of the modified block no longer matches the stored _sig.
  block.votes = { 'tampered-key': 'injected-vote' };
  fs.writeFileSync(file, JSON.stringify({ ...block, _sig }) + '\n', 'utf8');

  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.ok(
    warns.some((m) => m.includes('HMAC tamper')),
    'HMAC mismatch should produce an "HMAC tamper" warning',
  );
  assert.strictEqual(chain.getHeight(), -1, 'chain should be empty after full-genesis HMAC tamper');
}

function testHashMismatchTruncatesChain() {
  const dir = makeTmpDir();
  seedGenesisChain(dir);

  const file = chainFilePath(dir);
  const rawLines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  const stored = JSON.parse(rawLines[0]);
  const { _sig, ...block } = stored;

  // Set the stored hash to something wrong, then re-sign with the test secret
  // so the HMAC check passes but the hash check fires.
  block.hash = 'a'.repeat(64);
  const newSig = crypto.createHmac('sha256', TEST_SECRET).update(JSON.stringify(block)).digest('hex');
  fs.writeFileSync(file, JSON.stringify({ ...block, _sig: newSig }) + '\n', 'utf8');

  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.ok(
    warns.some((m) => m.includes('Hash mismatch')),
    'stored-hash mismatch should produce a "Hash mismatch" warning',
  );
  assert.strictEqual(chain.getHeight(), -1, 'chain should be empty after hash mismatch on genesis');
}

function testLegacyBlockWithoutSigMigratesAndGainsSig() {
  const dir = makeTmpDir();
  const c1 = seedGenesisChain(dir);
  const genesisBlock = c1.getBlock(0);

  // Rewrite file without _sig to simulate legacy format.
  fs.writeFileSync(chainFilePath(dir), JSON.stringify(genesisBlock) + '\n', 'utf8');

  // Load — should succeed without warnings and trigger migration.
  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.strictEqual(warns.length, 0, 'legacy unsigned block should load without warnings');
  assert.strictEqual(chain.getHeight(), 0, 'legacy block should still be available after migration');

  // Confirm migration wrote _sig back to disk.
  const migratedLine = fs.readFileSync(chainFilePath(dir), 'utf8').trim().split('\n')[0];
  const migratedStored = JSON.parse(migratedLine);
  assert.ok(migratedStored._sig, 'migrated file should contain _sig on every line');
}

function testCorruptSecondBlockPreservesGenesis() {
  const dir = makeTmpDir();
  const c1 = seedGenesisChain(dir);

  // Build and append a valid block 1.
  const block1 = c1.buildBlock({
    proposer: 'wtc1q-test-proposer',
    energyWh: 10_000,
    proofCommitment: 'test-commit-1',
  });
  c1.append(block1);
  assert.strictEqual(c1.getHeight(), 1);

  // Corrupt the second line in the chain file.
  const file = chainFilePath(dir);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  lines[1] = 'GARBAGE_LINE';
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.ok(warns.length > 0, 'corruption on block 1 should produce at least one warning');
  assert.strictEqual(chain.getHeight(), 0, 'genesis should survive when block 1 is corrupt');
  assert.ok(chain.getBlock(0) !== null, 'genesis block should be retrievable');
}

function testEmptyChainFileLoadsAsEmptyChain() {
  const dir = makeTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(chainFilePath(dir), '', 'utf8');

  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.strictEqual(warns.length, 0, 'empty chain file should produce no warnings');
  assert.strictEqual(chain.getHeight(), -1, 'empty file should produce empty chain (height -1)');
}

function testMissingChainFileLoadsAsEmptyChain() {
  const dir = makeTmpDir();
  // Do NOT create the file.

  const warns = captureWarns(() => makeChain(dir));
  const chain = makeChain(dir);

  assert.strictEqual(warns.length, 0, 'missing chain file should produce no warnings');
  assert.strictEqual(chain.getHeight(), -1, 'missing file should produce empty chain (height -1)');
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function run() {
  testCleanChainLoadsWithNoWarnings();
  testCorruptJsonLineTruncatesChain();
  testHmacTamperDetectedTruncatesChain();
  testHashMismatchTruncatesChain();
  testLegacyBlockWithoutSigMigratesAndGainsSig();
  testCorruptSecondBlockPreservesGenesis();
  testEmptyChainFileLoadsAsEmptyChain();
  testMissingChainFileLoadsAsEmptyChain();
  console.log('chain corruption tests passed');
}

run();
