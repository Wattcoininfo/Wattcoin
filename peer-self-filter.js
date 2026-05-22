'use strict';

function isSelfPeerUrlCandidate(candidate, { selfAdvertisedUrls = [], listenPort = 0, localHosts = [] } = {}) {
  if (!candidate) return false;

  const selfUrls = new Set(
    (Array.isArray(selfAdvertisedUrls) ? selfAdvertisedUrls : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );
  if (selfUrls.has(candidate)) return true;

  try {
    const parsed = new URL(candidate);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    const pathname = String(parsed.pathname || '/').replace(/\/+$/, '') || '/';
    if (pathname !== '/') {
      if (!pathname.startsWith('/api/v1/tunnel/')) {
        return false;
      }
      const segments = pathname.split('/').filter(Boolean);
      if (segments.length < 4) {
        return false;
      }
      return false;
    }
    return port === listenPort && new Set(localHosts || []).has(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function filterExternalPeerUrls(candidates, selfOptions = {}) {
  const urls = Array.isArray(candidates) ? candidates : [];
  return Array.from(new Set(
    urls
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .filter((value) => !isSelfPeerUrlCandidate(value, selfOptions))
  ));
}

module.exports = {
  isSelfPeerUrlCandidate,
  filterExternalPeerUrls,
};