'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeBlockHash } = require('../wtc-chain');
const { createWtcNode } = require('../wtc-node');
const { generateKeypair, sign, txHash } = require('../wtc-address');
const {
  attachProbeReceiptSignature,
  getProbeReceiptSigningPayload,
  PROBE_RECEIPT_VERSION,
} = require('../probe-attestation');

const ENERGY_WH_PER_BLOCK = 10_000_000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeCanonicalGenesis(dirPath, teamAddress) {
  const genesisPath = path.join(dirPath, 'wtc-genesis.json');
  const genesis = {
    timestamp: 1710000000000,
    teamWallets: [{ address: teamAddress, amount: 1_000_000 }],
  };
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2), 'utf8');
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best effort cleanup.
  }
}

function createStandaloneNode(id, dataDir) {
  return createWtcNode({
    dataDir,
    signingSecret: `probe-attestation-${id}`,
    allowPartialQuorumCommit: false,
    getActivePeers: () => [],
    requestPeerJson: () => {
      throw new Error('unexpected peer RPC in standalone test');
    },
  });
}

function buildSignedReceipt(node, workerId) {
  const kp = generateKeypair();
  const unsigned = {
    version: PROBE_RECEIPT_VERSION,
    probeId: 'probe-attestation-test',
    verifierAddress: kp.address,
    workerId,
    type: 'cpu',
    ok: true,
    wallClockMs: 1337,
    ts: 1711111111111,
    chainIndex: 4,
    chainHead: 'abcd1234deadbeef',
  };
  const payload = getProbeReceiptSigningPayload(unsigned);
  const sig = sign(txHash(payload), Buffer.from(kp.privateKey, 'hex'));
  return attachProbeReceiptSignature(unsigned, `${sig.r}${sig.s}${String(sig.v).padStart(2, '0')}`);
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-probe-attestation-'));
  try {
    const teamAddress = generateKeypair().address;
    const minerDir = path.join(baseDir, 'miner');
    const validatorDir = path.join(baseDir, 'validator');
    const rejectorDir = path.join(baseDir, 'rejector');
    ensureDir(minerDir);
    ensureDir(validatorDir);
    ensureDir(rejectorDir);
    writeCanonicalGenesis(minerDir, teamAddress);
    writeCanonicalGenesis(validatorDir, teamAddress);
    writeCanonicalGenesis(rejectorDir, teamAddress);

    const miner = createStandaloneNode('miner', minerDir);
    const validator = createStandaloneNode('validator', validatorDir);
    const rejector = createStandaloneNode('rejector', rejectorDir);

    const proposer = miner.getPrimaryAddress();
    const probeReceipt = buildSignedReceipt(miner, proposer);

    await miner.mineBlock(proposer, {
      energyWh: ENERGY_WH_PER_BLOCK,
      proofCommitment: 'probe-attestation-test',
      peerProbeVerified: true,
      probeReceipt,
    });

    const minedBlock = JSON.parse(JSON.stringify(miner.getBlock(1)));
    assert.strictEqual(minedBlock.attestationVersion, 1, 'new blocks should carry attestationVersion');
    assert.strictEqual(minedBlock.peerProbeVerified, true, 'mined block should store peerProbeVerified');
    assert.strictEqual(minedBlock.probeReceipt.workerId, proposer, 'stored receipt should bind to proposer address');
    assert.strictEqual(typeof minedBlock.probeReceipt.signature, 'string', 'stored receipt should include a signature');

    const accepted = await validator.handleProposal(minedBlock, 'miner-peer');
    assert.strictEqual(
      Boolean(accepted && accepted.ok),
      true,
      'validator should accept a block with a valid signed probe receipt',
    );

    const tampered = JSON.parse(JSON.stringify(minedBlock));
    // Corrupt the signature with a 130-char hex string that won't verify
    tampered.probeReceipt.signature = 'a'.repeat(128) + '00';
    tampered.hash = computeBlockHash(tampered);

    const rejected = await rejector.handleProposal(tampered, 'tampered-peer');
    assert.strictEqual(
      Boolean(rejected && rejected.ok),
      false,
      'validator should reject a block with a tampered signed probe receipt',
    );
    assert.match(
      String((rejected && rejected.reason) || ''),
      /(receipt signature verification failed|invalid receipt signature)/i,
    );

    console.log('wtc probe attestation tests passed');
  } finally {
    rmrf(baseDir);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
