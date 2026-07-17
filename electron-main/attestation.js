const crypto = require('crypto');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

function createAttestation(deps) {
  const {
    getWalletDataDir,
    safeStorage,
    getDeviceIdentitySecret,
    persistence,
    hwProf,
    verifyPolicyFeedEnvelope,
    sha256Hex,
    secureStringEquals,
    computeNextReattestDueAt,
    normalizeHardwareDescriptor,
    normalizeMinerIdentity,
    defaultAttestationState,
    getRuntimeConfig,
    getConsumedProofsFilePath,
    hwAuthority,
    getWtcNode,
    computeHwAuthSig,
    activeAttestationChallengesRef,
    attestationStateRef,
    LOCAL_HARDWARE_PROFILE_DB,
    POLICY_FEED_REFRESH_MS,
    ATTESTATION_REPLAY_WINDOW_MS,
    ATTESTATION_SPOTCHECK_MIN_GAP_MS,
    ATTESTATION_SPOTCHECK_DURATION_MS,
    ATTESTATION_MAX_LEVEL,
    ATTESTATION_REATTEST_MIN_MS,
    ATTESTATION_REATTEST_MAX_MS,
    ATTESTATION_CHALLENGE_TTL_MS,
    ENABLE_NODE_ATTESTATION,
  } = deps;

  const consumedBenchmarkProofs = new Map();
  let remoteProfileFeed = {
    profiles: null,
    rawProfiles: null,
    source: 'local',
    fetchedAtMs: 0,
    expiresAtMs: 0,
    version: 0,
  };
  let remoteProfileFeedRefreshTimer = null;
  let policyAnchorState = { latestAnchor: null, lastScannedHeight: -1, scannedAtMs: 0 };

  function getAttestationDbFilePath() {
    return path.join(getWalletDataDir(), 'attestation-state.json');
  }

  function loadPolicyAnchorState() {
    const loaded = persistence.loadPolicyAnchorState();
    if (loaded) policyAnchorState = loaded;
  }

  function scanChainForPolicyAnchor() {
    loadPolicyAnchorState();
    return policyAnchorState.latestAnchor
      ? { ok: true, cached: true, ...policyAnchorState.latestAnchor }
      : { ok: false, code: 'POLICY_ANCHOR_NOT_FOUND' };
  }

  function loadConsumedProofs() {
    try {
      const raw = fs.readFileSync(getConsumedProofsFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const { _sig, ...data } = parsed;
      if (_sig) {
        const expected = computeHwAuthSig(data);
        if (!crypto.timingSafeEqual(Buffer.from(String(_sig), 'utf8'), Buffer.from(expected, 'utf8'))) {
          console.warn('[ConsumedProofs] Tampered consumed-proofs.json detected - resetting replay cache.');
          return;
        }
      }
      const cutoff = Date.now() - ATTESTATION_REPLAY_WINDOW_MS;
      for (const [key, atMs] of Object.entries(data)) {
        if (typeof atMs === 'number' && atMs > cutoff) {
          consumedBenchmarkProofs.set(key, atMs);
        }
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function saveConsumedProofs() {
    try {
      const filePath = getConsumedProofsFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const obj = {};
      for (const [key, atMs] of consumedBenchmarkProofs.entries()) {
        obj[key] = atMs;
      }
      const sig = computeHwAuthSig(obj);
      fs.writeFileSync(filePath, JSON.stringify({ ...obj, _sig: sig }), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function getEffectiveHardwareProfiles() {
    return Array.isArray(remoteProfileFeed.profiles) && remoteProfileFeed.profiles.length > 0
      ? remoteProfileFeed.profiles
      : LOCAL_HARDWARE_PROFILE_DB;
  }

  function fetchTextWithTimeout(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      try {
        const client = String(url).toLowerCase().startsWith('https:') ? https : http;
        const req = client.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
          const chunks = [];
          let totalBytes = 0;
          const FETCH_MAX_BYTES = 1 * 1024 * 1024;
          res.on('data', (chunk) => {
            totalBytes += chunk.length;
            if (totalBytes > FETCH_MAX_BYTES) {
              req.destroy(new Error('policy feed response exceeded 1 MB size limit'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const status = Number(res.statusCode) || 0;
              const raw = Buffer.concat(chunks).toString('utf8');
              if (status < 200 || status >= 300) {
                reject(new Error(`policy feed HTTP ${status}`));
                return;
              }
              resolve(raw);
            } catch (e) {
              reject(e);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('policy feed timeout'));
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function loadCachedRemoteProfiles() {
    const cached = persistence.loadCachedRemoteProfiles();
    if (cached) remoteProfileFeed = cached;
  }

  function saveRemoteProfilesToCache(state) {
    persistence.saveRemoteProfilesToCache(state);
  }

  async function refreshRemoteProfilesFromPolicyFeed() {
    const runtime = getRuntimeConfig();
    const url = String(runtime.attestationPolicyFeedUrl || '').trim();
    const publicKeyPem = String(runtime.attestationPolicyFeedPublicKey || '').trim();
    if (!url) return { ok: false, code: 'POLICY_FEED_DISABLED' };

    try {
      const policyText = await fetchTextWithTimeout(url, 6000);
      let policyObj;
      try {
        policyObj = JSON.parse(policyText);
      } catch (_) {
        return { ok: false, code: 'POLICY_FEED_INVALID_JSON' };
      }

      const isEnvelope = policyObj && typeof policyObj.policy === 'object' && !Array.isArray(policyObj.policy);
      const policy = isEnvelope ? policyObj.policy : policyObj;
      if (!policy || !Array.isArray(policy.profiles)) {
        return { ok: false, code: 'POLICY_FEED_INVALID_JSON' };
      }

      const hashTarget = isEnvelope ? JSON.stringify(policy) : policyText;
      const downloadedHash = crypto.createHash('sha256').update(hashTarget, 'utf8').digest('hex');
      const anchor = await scanChainForPolicyAnchor();
      if (anchor.ok) {
        if (anchor.hash !== downloadedHash) {
          console.warn(
            `[PolicyFeed] On-chain hash mismatch! Chain: ${anchor.hash.slice(0, 12)}... Downloaded: ${downloadedHash.slice(0, 12)}...`,
          );
          return { ok: false, code: 'POLICY_FEED_CHAIN_HASH_MISMATCH' };
        }
        console.log(`[PolicyFeed] Policy verified against on-chain anchor (block ${anchor.blockHeight}).`);
      } else {
        if (publicKeyPem) {
          if (!isEnvelope || !verifyPolicyFeedEnvelope(policyObj, publicKeyPem)) {
            return { ok: false, code: 'POLICY_FEED_SIGNATURE_INVALID' };
          }
          console.log('[PolicyFeed] Policy verified via RSA signature (no chain anchor found).');
        } else {
          console.warn('[PolicyFeed] No on-chain anchor and no RSA public key configured - using local profile DB.');
          return { ok: false, code: 'POLICY_FEED_UNVERIFIABLE' };
        }
      }

      const expiresAtMs = Math.max(Date.now() + 30 * 60_000, Number(policy.expiresAtMs) || 0);
      const normalizedProfiles = policy.profiles.map(hwProf.normalizeRemoteProfile).filter(Boolean);
      if (normalizedProfiles.length === 0) {
        return { ok: false, code: 'POLICY_FEED_EMPTY' };
      }

      remoteProfileFeed = {
        profiles: normalizedProfiles,
        rawProfiles: Array.isArray(policy.profiles) ? policy.profiles : [],
        source: 'remote',
        fetchedAtMs: Date.now(),
        expiresAtMs,
        version: Number(policy.version) || 0,
      };
      saveRemoteProfilesToCache(remoteProfileFeed);
      return { ok: true, source: 'remote', count: normalizedProfiles.length };
    } catch (e) {
      return { ok: false, code: 'POLICY_FEED_FETCH_FAILED', message: e && e.message ? e.message : String(e) };
    }
  }

  function ensurePolicyFeedRefreshLoop() {
    if (remoteProfileFeedRefreshTimer) return;
    loadCachedRemoteProfiles();
    loadPolicyAnchorState();
    refreshRemoteProfilesFromPolicyFeed().catch(() => {});
    remoteProfileFeedRefreshTimer = setInterval(() => {
      refreshRemoteProfilesFromPolicyFeed().catch(() => {});
    }, POLICY_FEED_REFRESH_MS);
  }

  function loadAttestationState() {
    const filePath = getAttestationDbFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const parsed = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
      let secret;
      if (parsed && typeof parsed.encryptedSecret === 'string' && parsed.encryptedSecret.length > 0) {
        try {
          secret = safeStorage.decryptString(Buffer.from(parsed.encryptedSecret, 'base64'));
          if (!secret || secret.length < 32) throw new Error('decrypted secret too short');
        } catch (_) {
          let recovered = false;
          if (parsed && typeof parsed.fallbackEncryptedSecret === 'string') {
            try {
              const deviceSecret = getDeviceIdentitySecret();
              if (!deviceSecret || deviceSecret.length < 32) throw new Error('no device secret');
              const fbKey = crypto
                .createHash('sha256')
                .update(deviceSecret + ':attestation-fallback')
                .digest();
              const fbBuf = Buffer.from(parsed.fallbackEncryptedSecret, 'base64');
              const fbIv = fbBuf.slice(0, 12);
              const fbTag = fbBuf.slice(12, 28);
              const fbEnc = fbBuf.slice(28);
              const decipher = crypto.createDecipheriv('aes-256-gcm', fbKey, fbIv);
              decipher.setAuthTag(fbTag);
              secret = decipher.update(fbEnc).toString('utf8') + decipher.final('utf8');
              if (!secret || secret.length < 32) throw new Error('fallback secret too short');
              recovered = true;
            } catch (_fb) {
              console.warn('[AttestationState] Fallback decryption failed - generating new secret.');
            }
          }
          if (!recovered) {
            console.warn('[AttestationState] safeStorage decryption failed - generating new secret.');
            secret = crypto.randomBytes(32).toString('hex');
          }
        }
      } else if (parsed && typeof parsed.secret === 'string' && parsed.secret.length >= 32) {
        secret = parsed.secret;
      } else {
        secret = crypto.randomBytes(32).toString('hex');
      }
      return {
        version: 1,
        secret,
        miners: parsed && parsed.miners && typeof parsed.miners === 'object' ? parsed.miners : {},
      };
    } catch (_) {
      return defaultAttestationState();
    }
  }

  function saveAttestationState() {
    const filePath = getAttestationDbFilePath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const payload = { version: attestationStateRef.current.version, miners: attestationStateRef.current.miners };
      if (safeStorage.isEncryptionAvailable()) {
        payload.encryptedSecret = safeStorage.encryptString(attestationStateRef.current.secret).toString('base64');
      }
      try {
        const deviceSecret = getDeviceIdentitySecret();
        if (deviceSecret && deviceSecret.length >= 32) {
          const fbKey = crypto
            .createHash('sha256')
            .update(deviceSecret + ':attestation-fallback')
            .digest();
          const fbIv = crypto.randomBytes(12);
          const cipher = crypto.createCipheriv('aes-256-gcm', fbKey, fbIv);
          const fbEnc = Buffer.concat([cipher.update(attestationStateRef.current.secret, 'utf8'), cipher.final()]);
          const fbTag = cipher.getAuthTag();
          payload.fallbackEncryptedSecret = Buffer.concat([fbIv, fbTag, fbEnc]).toString('base64');
        }
      } catch (_fb) {
        /* non-fatal */
      }
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function resolveHardwareProfile(summary = {}) {
    const descriptor = normalizeHardwareDescriptor(summary);
    const profiles = getEffectiveHardwareProfiles();
    return profiles.find((profile) => profile.match(descriptor)) || profiles[profiles.length - 1];
  }

  function cleanupReplayCache() {
    const cutoff = Date.now() - ATTESTATION_REPLAY_WINDOW_MS;
    let changed = false;
    for (const [key, atMs] of consumedBenchmarkProofs.entries()) {
      if (atMs < cutoff) {
        consumedBenchmarkProofs.delete(key);
        changed = true;
      }
    }
    if (changed) saveConsumedProofs();
  }

  function cleanupExpiredChallenges() {
    const nowMs = Date.now();
    for (const [challengeId, challenge] of activeAttestationChallengesRef.current.entries()) {
      if (!challenge || challenge.expiresAtMs < nowMs) activeAttestationChallengesRef.current.delete(challengeId);
    }
  }

  function getMinerRecord(minerId) {
    const key = normalizeMinerIdentity(minerId);
    if (!attestationStateRef.current.miners[key]) {
      attestationStateRef.current.miners[key] = {
        level: 0,
        goodStreak: 0,
        badStreak: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        lastSeenAtMs: 0,
        lastProfileId: 'fallback',
        lastAcceptedAtMs: 0,
        nextRequiredAtMs: 0,
        forcedReattestUntilMs: 0,
        lastSpotCheckEvalAtMs: 0,
        lastIdentityAddress: '',
      };
    }
    return attestationStateRef.current.miners[key];
  }

  function buildChallengeSignature(challengePayload) {
    const hmac = crypto.createHmac('sha256', Buffer.from(attestationStateRef.current.secret, 'utf8'));
    hmac.update(JSON.stringify(challengePayload));
    return hmac.digest('hex');
  }

  function evaluateReattestationNeed(record, profile, options = {}) {
    const nowMs = Date.now();
    const reasons = [];
    const allowSpotCheck = !!(options && options.allowSpotCheck);
    const requiredBySchedule =
      (Number(record.nextRequiredAtMs) || 0) > 0 && nowMs >= Number(record.nextRequiredAtMs || 0);
    const requiredByForcedWindow = (Number(record.forcedReattestUntilMs) || 0) > nowMs;
    const hasAcceptedAttestation = (Number(record.lastAcceptedAtMs) || 0) > 0;

    if (!hasAcceptedAttestation) reasons.push('initial-attestation-required');
    if (requiredBySchedule) reasons.push('periodic-reattest-window');
    if (requiredByForcedWindow) reasons.push('spot-check-required');

    if (allowSpotCheck && hasAcceptedAttestation && !requiredBySchedule && !requiredByForcedWindow) {
      const lastEval = Number(record.lastSpotCheckEvalAtMs) || 0;
      if (nowMs - lastEval >= ATTESTATION_SPOTCHECK_MIN_GAP_MS) {
        record.lastSpotCheckEvalAtMs = nowMs;
        const probability = Math.min(0.5, Math.max(0, Number(profile.spotCheckProbability) || 0.05));
        if (Math.random() < probability) {
          record.forcedReattestUntilMs = nowMs + ATTESTATION_SPOTCHECK_DURATION_MS;
          reasons.push('spot-check-required');
          saveAttestationState();
        }
      }
    }

    return {
      requiredNow: reasons.length > 0,
      reasons,
      nextRequiredAtMs: Number(record.nextRequiredAtMs) || 0,
      forcedReattestUntilMs: Number(record.forcedReattestUntilMs) || 0,
    };
  }

  function computePolicyForMiner(minerId, summary = {}, options = {}) {
    const profile = resolveHardwareProfile(summary);
    const _allowGpuWorkloads = hwProf.shouldAllowGpuWorkloadsForSummary(summary);
    const record = getMinerRecord(minerId);
    const level = Math.max(0, Math.min(ATTESTATION_MAX_LEVEL, Number(record.level) || 0));
    const capW = Math.min(profile.maxCapW, profile.conservativeCapW + profile.stepW * level);
    const reattestation = evaluateReattestationNeed(record, profile, {
      allowSpotCheck: !!(options && options.allowSpotCheck),
    });
    return {
      profileId: profile.id,
      profileSource: remoteProfileFeed.source || 'local',
      conservativeCapW: profile.conservativeCapW,
      maxCapW: profile.maxCapW,
      currentCapW: capW,
      level,
      nextLevelCapW: Math.min(
        profile.maxCapW,
        profile.conservativeCapW + profile.stepW * Math.min(ATTESTATION_MAX_LEVEL, level + 1),
      ),
      minimums: {
        cpuOpsPerSec: profile.minCpuOpsPerSec,
        jitterRatioMax: 0.45,
      },
      reattestation: {
        requiredNow: reattestation.requiredNow,
        reasons: reattestation.reasons,
        nextRequiredAtMs: reattestation.nextRequiredAtMs,
        forcedReattestUntilMs: reattestation.forcedReattestUntilMs,
        minWindowMs: ATTESTATION_REATTEST_MIN_MS,
        maxWindowMs: ATTESTATION_REATTEST_MAX_MS,
        spotCheckProbability: Math.min(0.5, Math.max(0, Number(profile.spotCheckProbability) || 0.05)),
      },
    };
  }

  function verifyIdentityWithWalletSignature(identity = {}, expectedMessage = '') {
    const address = String(identity.address || '').trim();
    const signature = String(identity.signature || '').trim();
    const message = String(identity.message || '').trim();
    if (!address || !signature || !message) {
      return { ok: false, code: 'IDENTITY_SIGNATURE_MISSING', reason: 'address/signature/message missing' };
    }
    if (message !== expectedMessage) {
      return {
        ok: false,
        code: 'IDENTITY_MESSAGE_MISMATCH',
        reason: 'signed message does not match challenge message',
      };
    }
    const wtcNode = getWtcNode();
    const isOwned = !!(wtcNode && wtcNode.getAddresses().includes(address));
    if (!isOwned) {
      return { ok: false, code: 'IDENTITY_ADDRESS_NOT_OWNED', reason: 'address is not owned by local wallet' };
    }
    const verified = wtcNode ? wtcNode.verifyMessage(address, signature, message) : false;
    if (verified) return { ok: true, address };
    return { ok: false, code: 'IDENTITY_SIGNATURE_INVALID', reason: 'wallet signature verification failed' };
  }

  function issueBenchmarkChallenge(minerId, hardwareSummary = {}, identityAddress = '') {
    if (!ENABLE_NODE_ATTESTATION) {
      return { ok: false, code: 'ATTESTATION_DISABLED', message: 'Node attestation is disabled.' };
    }
    cleanupReplayCache();
    cleanupExpiredChallenges();
    if (remoteProfileFeed.expiresAtMs > 0 && remoteProfileFeed.expiresAtMs <= Date.now()) {
      refreshRemoteProfilesFromPolicyFeed().catch(() => {});
    }
    const identity = normalizeMinerIdentity(minerId);
    const policy = computePolicyForMiner(identity, hardwareSummary);
    const issuedAtMs = Date.now();
    const challengePayload = {
      id: crypto.randomBytes(16).toString('hex'),
      minerId: identity,
      issuedAtMs,
      expiresAtMs: issuedAtMs + ATTESTATION_CHALLENGE_TTL_MS,
      challengeSeed: crypto.randomInt(1, 2_147_483_647),
      workloadProfile: {
        phaseCount: 4,
        phaseDurationMs: 120,
        allowGpuWorkloads: policy.profileId === 'desktop-high' || policy.profileId === 'desktop-mid',
      },
      minimums: policy.minimums,
      profileId: policy.profileId,
      identityAddress: String(identityAddress || '').trim(),
    };
    challengePayload.attestationMessage = hwProf.buildAttestationMessage(challengePayload);
    const signature = buildChallengeSignature(challengePayload);
    const challenge = { ...challengePayload, signature };
    activeAttestationChallengesRef.current.set(challenge.id, challenge);
    return {
      ok: true,
      challenge,
      policy,
    };
  }

  function rejectAttestation(minerId, summary, code, message, reasons = []) {
    const identity = normalizeMinerIdentity(minerId);
    const record = getMinerRecord(identity);
    record.level = Math.max(0, (Number(record.level) || 0) - 1);
    record.badStreak = Math.max(1, (Number(record.badStreak) || 0) + 1);
    record.goodStreak = 0;
    record.rejectedCount = (Number(record.rejectedCount) || 0) + 1;
    record.lastSeenAtMs = Date.now();
    const profile = resolveHardwareProfile(summary);
    record.lastProfileId = profile.id;
    saveAttestationState();
    return {
      ok: false,
      code,
      message,
      reasons,
      policy: computePolicyForMiner(identity, summary),
    };
  }

  function enforceReattestationGateForMiner(minerId, hardwareSummary = {}, options = {}) {
    if (!ENABLE_NODE_ATTESTATION) {
      return {
        ok: true,
        policy: {
          currentCapW: 0,
          reattestation: { requiredNow: false, reasons: [] },
        },
      };
    }
    const identity = normalizeMinerIdentity(minerId);
    const record = getMinerRecord(identity);
    const profile = resolveHardwareProfile(hardwareSummary);
    const check = evaluateReattestationNeed(record, profile, { allowSpotCheck: !!(options && options.allowSpotCheck) });
    if (!check.requiredNow) {
      return {
        ok: true,
        policy: computePolicyForMiner(identity, hardwareSummary),
      };
    }
    saveAttestationState();
    return {
      ok: false,
      code: 'ATTESTATION_REQUIRED',
      message: 'Re-attestation required by node policy before mining can continue.',
      reasons: check.reasons,
      policy: computePolicyForMiner(identity, hardwareSummary),
    };
  }

  async function submitBenchmarkProof(payload = {}) {
    if (!ENABLE_NODE_ATTESTATION) {
      return { ok: false, code: 'ATTESTATION_DISABLED', message: 'Node attestation is disabled.', reasons: [] };
    }
    cleanupReplayCache();
    cleanupExpiredChallenges();

    const minerId = normalizeMinerIdentity(payload.minerId);
    const challenge = payload && payload.challenge && typeof payload.challenge === 'object' ? payload.challenge : null;
    const proof = payload && payload.proof && typeof payload.proof === 'object' ? payload.proof : null;
    const summary =
      payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
    const identity = payload && payload.identity && typeof payload.identity === 'object' ? payload.identity : {};

    if (!challenge || !proof || !challenge.id) {
      return rejectAttestation(
        minerId,
        summary,
        'ATTESTATION_PAYLOAD_INVALID',
        'Attestation payload missing challenge or proof.',
        ['missing challenge/proof payload'],
      );
    }

    const expected = activeAttestationChallengesRef.current.get(String(challenge.id));
    if (!expected) {
      return rejectAttestation(
        minerId,
        summary,
        'ATTESTATION_CHALLENGE_UNKNOWN',
        'Challenge not active or already consumed.',
        ['challenge unknown or already used'],
      );
    }

    if (expected.minerId !== minerId) {
      activeAttestationChallengesRef.current.delete(expected.id);
      return rejectAttestation(minerId, summary, 'ATTESTATION_MINER_MISMATCH', 'Challenge miner identity mismatch.', [
        'challenge miner mismatch',
      ]);
    }

    const nowMs = Date.now();
    if (expected.expiresAtMs < nowMs) {
      activeAttestationChallengesRef.current.delete(expected.id);
      return rejectAttestation(minerId, summary, 'ATTESTATION_CHALLENGE_EXPIRED', 'Challenge expired.', [
        'challenge expired',
      ]);
    }

    const signedPayload = {
      id: expected.id,
      minerId: expected.minerId,
      issuedAtMs: expected.issuedAtMs,
      expiresAtMs: expected.expiresAtMs,
      challengeSeed: expected.challengeSeed,
      workloadProfile: expected.workloadProfile,
      minimums: expected.minimums,
      profileId: expected.profileId,
      identityAddress: expected.identityAddress,
      attestationMessage: expected.attestationMessage,
    };
    const expectedSignature = buildChallengeSignature(signedPayload);
    if (!secureStringEquals(expectedSignature, String(challenge.signature || ''))) {
      activeAttestationChallengesRef.current.delete(expected.id);
      return rejectAttestation(
        minerId,
        summary,
        'ATTESTATION_SIGNATURE_INVALID',
        'Challenge signature verification failed.',
        ['challenge signature invalid'],
      );
    }

    const challengeSeed = Math.max(0, Math.floor(Number(proof.challengeSeed) || 0));
    if (challengeSeed !== expected.challengeSeed) {
      activeAttestationChallengesRef.current.delete(expected.id);
      return rejectAttestation(minerId, summary, 'ATTESTATION_SEED_MISMATCH', 'Proof challenge seed mismatch.', [
        'proof challenge seed mismatch',
      ]);
    }

    if (expected.measuredCpuOpsPerSec == null) {
      activeAttestationChallengesRef.current.delete(expected.id);
      return rejectAttestation(
        minerId,
        summary,
        'ATTESTATION_PROOF_REJECTED',
        'Backend benchmark was not run before submitting this proof.',
        ['main-process benchmark missing for this challenge'],
      );
    }
    const cpuOpsPerSec = expected.measuredCpuOpsPerSec;
    const jitterRatio = Math.max(0, Number(proof.jitterRatio) || 0);

    const failures = [];

    const identityCheck = await verifyIdentityWithWalletSignature(identity, expected.attestationMessage || '');
    if (!identityCheck.ok) {
      failures.push(`identity check failed: ${identityCheck.code || identityCheck.reason || 'unknown'}`);
    } else if (expected.identityAddress && expected.identityAddress !== identityCheck.address) {
      failures.push('identity address mismatch against challenge envelope');
    }

    if (cpuOpsPerSec < Number((expected.minimums && expected.minimums.cpuOpsPerSec) || 0)) {
      failures.push('cpu throughput below node minimum');
    }
    if (jitterRatio > Number((expected.minimums && expected.minimums.jitterRatioMax) || 0.45)) {
      const adaptiveMax =
        hwAuthority.rollingJitterMean > 0 ? Math.min(0.7, Math.max(0.45, hwAuthority.rollingJitterMean * 2.0)) : 0.45;
      if (jitterRatio > adaptiveMax) {
        failures.push('benchmark jitter above node maximum');
      }
    }

    const replayKey = sha256Hex(
      JSON.stringify({
        minerId,
        challengeId: expected.id,
        challengeSeed,
        cpuOpsPerSec: Math.round(cpuOpsPerSec),
      }),
    );
    if (consumedBenchmarkProofs.has(replayKey)) {
      failures.push('replay detected for benchmark proof');
    }

    activeAttestationChallengesRef.current.delete(expected.id);
    consumedBenchmarkProofs.set(replayKey, nowMs);
    saveConsumedProofs();

    if (failures.length > 0) {
      return rejectAttestation(
        minerId,
        summary,
        'ATTESTATION_PROOF_REJECTED',
        'Benchmark proof rejected by node policy.',
        failures,
      );
    }

    const profile = resolveHardwareProfile(summary);
    const record = getMinerRecord(minerId);
    record.level = Math.min(ATTESTATION_MAX_LEVEL, (Number(record.level) || 0) + 1);
    record.goodStreak = (Number(record.goodStreak) || 0) + 1;
    record.badStreak = 0;
    record.acceptedCount = (Number(record.acceptedCount) || 0) + 1;
    record.lastSeenAtMs = nowMs;
    record.lastProfileId = profile.id;
    record.lastAcceptedAtMs = nowMs;
    record.nextRequiredAtMs = computeNextReattestDueAt(nowMs);
    record.forcedReattestUntilMs = 0;
    record.lastIdentityAddress = identityCheck.ok ? identityCheck.address : String(identity.address || '').trim();
    saveAttestationState();

    return {
      ok: true,
      accepted: true,
      message: 'Benchmark proof accepted by node attestation policy.',
      policy: computePolicyForMiner(minerId, summary),
      reasons: [],
    };
  }

  return {
    loadAttestationState,
    saveAttestationState,
    loadConsumedProofs,
    issueBenchmarkChallenge,
    submitBenchmarkProof,
    enforceReattestationGateForMiner,
    computePolicyForMiner,
    resolveHardwareProfile,
    getEffectiveHardwareProfiles,
    getMinerRecord,
    cleanupExpiredChallenges,
    cleanupReplayCache,
    refreshRemoteProfilesFromPolicyFeed,
    ensurePolicyFeedRefreshLoop,
    loadCachedRemoteProfiles,
    loadPolicyAnchorState,
    scanChainForPolicyAnchor,
    verifyIdentityWithWalletSignature,
    rejectAttestation,
    evaluateReattestationNeed,
    buildChallengeSignature,
  };
}

function registerAttestationIpcHandlers(ipcMain, deps) {
  const { issueBenchmarkChallenge, submitBenchmarkProof, computePolicyForMiner, getWtcNode } = deps;

  ipcMain.handle('wattcoin-attestation-issue-challenge', (_event, payload = {}) => {
    const minerId = payload && payload.minerId ? String(payload.minerId) : 'local-client';
    const hardwareSummary =
      payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
    const identityAddress = payload && payload.identityAddress ? String(payload.identityAddress) : '';
    return issueBenchmarkChallenge(minerId, hardwareSummary, identityAddress);
  });

  ipcMain.handle('wattcoin-attestation-submit-proof', async (_event, payload = {}) => {
    return await submitBenchmarkProof(payload || {});
  });

  ipcMain.handle('wattcoin-attestation-get-policy', (_event, payload = {}) => {
    const minerId = payload && payload.minerId ? String(payload.minerId) : 'local-client';
    const hardwareSummary =
      payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
    return {
      ok: true,
      policy: computePolicyForMiner(minerId, hardwareSummary, { allowSpotCheck: true }),
    };
  });

  ipcMain.handle('wattcoin-sign-attestation-message', (_event, payload = {}) => {
    const _walletName = 'wattminer';
    const address = String(payload && payload.address ? payload.address : '').trim();
    const message = String(payload && payload.message ? payload.message : '').trim();
    if (!address || !message) {
      return { ok: false, code: 'SIGN_INPUT_INVALID', message: 'Address and message are required.' };
    }
    const wtcNode = getWtcNode();
    if (wtcNode) {
      const isOwned = wtcNode.getAddresses().includes(address);
      if (!isOwned) {
        return { ok: false, code: 'ADDRESS_NOT_OWNED', message: 'Selected address is not owned by wallet.' };
      }
      try {
        const result = wtcNode.signMessage(address, message);
        return { ok: true, address, message, signature: result.signature };
      } catch (e) {
        return {
          ok: false,
          code: 'SIGN_FAILED',
          message: e && e.message ? e.message : 'Failed to sign attestation message.',
        };
      }
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
  });
}

module.exports = { createAttestation, registerAttestationIpcHandlers };
