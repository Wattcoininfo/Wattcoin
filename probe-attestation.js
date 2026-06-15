// SPDX-License-Identifier: MIT
'use strict';

const { txHash, verifySignature, isValidAddress } = require('./wtc-address');

const PROBE_RECEIPT_VERSION = 1;
const BLOCK_ATTESTATION_VERSION = 1;

function toSafeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeProbeReceiptSignature(signature) {
  if (typeof signature === 'string') {
    return signature.trim();
  }
  if (!signature || typeof signature !== 'object') {
    return '';
  }
  const r = String(signature.r || '').trim();
  const s = String(signature.s || '').trim();
  const v = String(signature.v ?? '').trim();
  return `${r}${s}${v}`;
}

function normalizeProbeReceipt(receipt, { includeSignature = true } = {}) {
  if (!receipt || typeof receipt !== 'object') return null;
  const normalized = {
    version: Math.max(PROBE_RECEIPT_VERSION, Math.floor(toSafeNumber(receipt.version) || PROBE_RECEIPT_VERSION)),
    probeId: String(receipt.probeId || '').trim(),
    verifierAddress: String(receipt.verifierAddress || '').trim(),
    workerId: String(receipt.workerId || '').trim(),
    type: String(receipt.type || '').trim(),
    ok: !!receipt.ok,
    wallClockMs: Math.max(0, Math.round(toSafeNumber(receipt.wallClockMs))),
    ts: Math.max(0, Math.round(toSafeNumber(receipt.ts))),
    roundId: Math.max(0, Math.round(toSafeNumber(receipt.roundId))),
    chainIndex: Math.max(0, Math.round(toSafeNumber(receipt.chainIndex))),
    chainHead: receipt.chainHead === null || receipt.chainHead === undefined ? null : String(receipt.chainHead).trim(),
    hwPowerW: Math.max(0, Math.round(toSafeNumber(receipt.hwPowerW))),
  };
  // Hardware model fields (optional — only included in the signed payload when
  // present, so old receipts without them remain verifiable by new code).
  const gpuModels = Array.isArray(receipt.gpuModels)
    ? receipt.gpuModels.map(m => String(m || '').trim()).filter(Boolean)
    : [];
  if (gpuModels.length > 0) normalized.gpuModels = gpuModels;
  if (receipt.cpuModel) normalized.cpuModel = String(receipt.cpuModel).trim();
  if (receipt.asicModel) normalized.asicModel = String(receipt.asicModel).trim();
  if (includeSignature) {
    normalized.signature = normalizeProbeReceiptSignature(receipt.signature || receipt.sig || '');
  }
  return normalized;
}

function getProbeReceiptSigningPayload(receipt) {
  const normalized = normalizeProbeReceipt(receipt, { includeSignature: false });
  return normalized ? JSON.stringify(normalized) : '';
}

function attachProbeReceiptSignature(receipt, signature) {
  const normalized = normalizeProbeReceipt(receipt, { includeSignature: false });
  if (!normalized) return null;
  return {
    ...normalized,
    signature: normalizeProbeReceiptSignature(signature),
  };
}

function parseSignatureHex(signatureHex) {
  const compact = String(signatureHex || '').trim();
  if (!/^[0-9a-fA-F]{130}$/.test(compact)) return null;
  return {
    r: compact.slice(0, 64),
    s: compact.slice(64, 128),
    v: parseInt(compact.slice(128), 10),
  };
}

function verifyProbeReceipt(receipt, { expectedWorkerId = '', requireSuccess = true, expectedRoundId } = {}) {
  const normalized = normalizeProbeReceipt(receipt);
  if (!normalized) return { ok: false, reason: 'missing probe receipt' };
  if (!normalized.probeId) return { ok: false, reason: 'missing probeId' };
  if (!normalized.verifierAddress || !isValidAddress(normalized.verifierAddress)) {
    return { ok: false, reason: 'invalid verifierAddress' };
  }
  if (!normalized.workerId || !isValidAddress(normalized.workerId)) {
    return { ok: false, reason: 'invalid workerId' };
  }
  if (expectedWorkerId && normalized.workerId !== String(expectedWorkerId).trim()) {
    return { ok: false, reason: 'workerId does not match proposer' };
  }
  if (requireSuccess && !normalized.ok) {
    return { ok: false, reason: 'probe receipt is not successful' };
  }
  // Round binding: the receipt must belong to the expected round.
  // This prevents replaying a receipt from a previous round across round boundaries.
  const expectedRound = Number.isFinite(expectedRoundId) ? Math.floor(expectedRoundId) : -1;
  if (expectedRound >= 0 && normalized.roundId !== expectedRound) {
    return {
      ok: false,
      reason: `receipt roundId ${normalized.roundId} does not match expected round ${expectedRound}`,
    };
  }
  const sig = parseSignatureHex(normalized.signature);
  if (!sig) return { ok: false, reason: 'missing or invalid receipt signature' };
  const payload = getProbeReceiptSigningPayload(normalized);
  if (!payload) return { ok: false, reason: 'invalid receipt payload' };
  const verified = verifySignature(txHash(payload), sig, normalized.verifierAddress);
  if (!verified) return { ok: false, reason: 'receipt signature verification failed' };
  return { ok: true, receipt: normalized };
}

function normalizeBlockProbeAttestation(block) {
  const attestationVersion = Math.max(0, Math.floor(toSafeNumber(block && block.attestationVersion)));
  if (attestationVersion < BLOCK_ATTESTATION_VERSION) {
    return {
      attestationVersion: 0,
      peerProbeVerified: false,
      probeReceipt: null,
    };
  }
  const peerProbeVerified = !!(block && block.peerProbeVerified);
  return {
    attestationVersion: BLOCK_ATTESTATION_VERSION,
    peerProbeVerified,
    probeReceipt: peerProbeVerified ? normalizeProbeReceipt(block && block.probeReceipt) : null,
  };
}

function validateBlockProbeAttestation(block, { expectedWorkerId = '', expectedRoundId } = {}) {
  const rawVersion = Math.max(0, Math.floor(toSafeNumber(block && block.attestationVersion)));
  const hasLegacySidecar = !!(block && (block.peerProbeVerified || block.probeReceipt));
  if (rawVersion < BLOCK_ATTESTATION_VERSION) {
    if (hasLegacySidecar) {
      return { ok: false, reason: 'attestation fields require attestationVersion >= 1' };
    }
    return { ok: true, attestation: normalizeBlockProbeAttestation(block) };
  }

  const attestation = normalizeBlockProbeAttestation(block);
  if (!attestation.peerProbeVerified) {
    if (block && block.probeReceipt) {
      return { ok: false, reason: 'probeReceipt present while peerProbeVerified is false' };
    }
    return { ok: true, attestation };
  }

  if (!attestation.probeReceipt) {
    return { ok: false, reason: 'missing probeReceipt for peer-verified block' };
  }

  const verified = verifyProbeReceipt(attestation.probeReceipt, {
    expectedWorkerId,
    requireSuccess: true,
    expectedRoundId,
  });
  if (!verified.ok) return verified;
  return {
    ok: true,
    attestation,
    receipt: verified.receipt,
  };
}

module.exports = {
  BLOCK_ATTESTATION_VERSION,
  PROBE_RECEIPT_VERSION,
  normalizeProbeReceipt,
  normalizeBlockProbeAttestation,
  getProbeReceiptSigningPayload,
  attachProbeReceiptSignature,
  verifyProbeReceipt,
  validateBlockProbeAttestation,
};
