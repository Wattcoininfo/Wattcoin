// SPDX-License-Identifier: MIT
'use strict';

async function maybeRegisterReachableRequester(
  req,
  settings,
  source = 'peer-contact',
  {
    isReverseTunnelForwardedRequest,
    rememberObservedRequester,
    extractReachablePeerCandidates,
    isPublicPeerHost,
    verifyReachablePeerCandidate,
  } = {},
) {
  if (isReverseTunnelForwardedRequest(req)) {
    rememberObservedRequester(req, settings, `${source}-tunnel`);
    return { ok: true, source, skippedReachability: true, reason: 'reverse-tunnel-forwarded' };
  }

  const candidates = extractReachablePeerCandidates(req, settings);
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      const explicitlyAnnounced = String(req.headers['x-wtc-peer-urls'] || '').includes(candidate);
      if (!explicitlyAnnounced && isPublicPeerHost(parsed.hostname)) continue;
    } catch (_) {
      continue;
    }

    const result = await verifyReachablePeerCandidate(candidate, source);
    if (result && result.ok) return result;
  }

  return { ok: false, source, reason: 'no-reachable-candidate' };
}

module.exports = {
  maybeRegisterReachableRequester,
};
