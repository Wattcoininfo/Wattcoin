'use strict';
/**
 * Risk: if the on-disk remote seed cache file contains corrupt JSON (e.g.
 * truncated by a crash, AV quarantine, or disk error) AND the remote manifest
 * fetch also fails, loadCachedRemoteSeedPeers() silently returns [] and the
 * node starts completely isolated — with no bundled peers to fall back to.
 *
 * The existing integration test covers malformed *manifest responses* (remote
 * returns bad JSON while the cache is intact).  This test covers the
 * complementary case: the cache itself is corrupt.
 *
 * Expected outcome: the test PASSES by confirming the silent-empty-return
 * behaviour.  If a stale-cache fallback is added later, update Case 2.
 */

'use strict';

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createRemoteSeedManifestManager } = require('../remote-seed-manifest');

function rmrf(t) {
  try { fs.rmSync(t, { recursive: true, force: true }); } catch (_) {}
}

function normalizePeerUrl(candidate) {
  try {
    const parsed = new URL(String(candidate || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 1023) return '';
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch (_) {
    return '';
  }
}

function createManager(baseDir, opts = {}) {
  return createRemoteSeedManifestManager({
    fs,
    getRuntimeConfig: () => ({
      network:                  'wtc-mainnet',
      ledgerSeedManifestUrls:   ['https://manifest.example/seeds.json'],
      ...(opts.runtimeConfig || {}),
    }),
    getCachePath:              () => path.join(baseDir, 'remote-seed-peers-cache.json'),
    normalizePeerUrl,
    isDeprecatedPeerUrl:       () => false,
    requestExternalResponse:   opts.requestExternalResponse ||
      (async () => { throw new Error('manifest server unreachable'); }),
    fetchTimeoutMs:            1000,
    defaultRemoteSeedManifestUrls: [],
    schedulePeerSync:          () => {},
    logger:                    { log() {}, warn() {} },
  });
}

async function run() {
  const baseDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-seed-cache-corruption-'));
  const cacheFile = path.join(baseDir, 'remote-seed-peers-cache.json');

  try {
    // ── Case 1 (baseline): valid cache + failed remote → cached peers returned ──
    fs.writeFileSync(cacheFile, JSON.stringify({
      peers: ['http://198.51.100.10:39310'],
    }), 'utf8');

    const peers1 = await createManager(baseDir).refreshRemoteSeedPeers({ enabled: true });
    assert.deepStrictEqual(peers1, ['http://198.51.100.10:39310'],
      'valid cache + failed remote fetch should still return the cached peers');

    // ── Case 2: corrupt cache + failed remote → zero seeds (isolation risk) ───
    fs.writeFileSync(cacheFile, 'CORRUPT\x00\xFF_NOT_JSON', 'utf8');

    const peers2 = await createManager(baseDir).refreshRemoteSeedPeers({ enabled: true });
    assert.deepStrictEqual(peers2, [],
      'RISK CONFIRMED: corrupt cache + unreachable manifest = zero seed peers returned; ' +
      'node would start with no bootstrap peers and be isolated');

    // ── Case 3: loadCachedRemoteSeedPeers() does not throw on corrupt cache ───
    // (The catch(_) in loadCachedRemoteSeedPeers silently swallows the parse error.)
    const mgr3  = createManager(baseDir);
    let thrownInLoad = null;
    try {
      mgr3.loadCachedRemoteSeedPeers();
    } catch (e) {
      thrownInLoad = e;
    }
    assert.strictEqual(thrownInLoad, null,
      'loadCachedRemoteSeedPeers() must not throw on a corrupt cache file');
    const cached3 = mgr3.loadCachedRemoteSeedPeers();
    assert.deepStrictEqual(cached3, [],
      'corrupt cache should yield [] from loadCachedRemoteSeedPeers');

    // ── Case 4: corrupt cache + successful remote → recovers ─────────────────
    // The only recovery path is a successful remote manifest fetch.
    const peers4 = await createManager(baseDir, {
      requestExternalResponse: async () => ({
        statusCode:   200,
        contentType:  'application/json',
        body:         JSON.stringify({ seedPeers: [{ url: 'http://198.51.100.20:39310' }] }),
      }),
    }).refreshRemoteSeedPeers({ enabled: true });
    assert.deepStrictEqual(peers4, ['http://198.51.100.20:39310'],
      'corrupt cache should recover when the remote manifest fetch succeeds');

    console.log(
      '[PASS] remote-seed-cache-corruption: corrupt cache + failed remote = zero seeds confirmed; ' +
      'recovery via successful remote fetch works'
    );
  } finally {
    rmrf(baseDir);
  }
}

run().catch((err) => {
  console.error('[FAIL] wtc-remote-seed-cache-corruption:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
