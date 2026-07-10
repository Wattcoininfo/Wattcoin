const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadBundledSeedPeers } = require('./bundled-seed-peers');

function setupRpcCredentials({ getRuntimeConfig, normalizePeerUrl }) {
  try {
    const { getLocalOverrideConfigPath } = require('./runtime-config');
    const localPath = getLocalOverrideConfigPath();
    let localCfg = {};
    try {
      localCfg = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    const currentUser = String(localCfg.rpcUser || getRuntimeConfig().rpcUser || '');
    const currentPass = String(localCfg.rpcPassword || getRuntimeConfig().rpcPassword || '');
    const currentToken = String(localCfg.ledgerNetworkAuthToken || getRuntimeConfig().ledgerNetworkAuthToken || '');
    const DEFAULT_TOKEN = '218d99ff7cdd8c67f38a983e00e0850e5b0821b42ee57b0c';
    const runtime = getRuntimeConfig();
    const shouldUseSharedPeerToken = runtime.ledgerNetworkEnabled && runtime.ledgerNetworkMode === 'peer';
    let dirty = false;
    if (currentUser === 'user' || currentPass === 'pass' || !currentUser || !currentPass) {
      localCfg.rpcUser = 'wtc_' + crypto.randomBytes(8).toString('hex');
      localCfg.rpcPassword = crypto.randomBytes(24).toString('hex');
      dirty = true;
    }
    if (shouldUseSharedPeerToken) {
      if (currentToken !== DEFAULT_TOKEN) {
        localCfg.ledgerNetworkAuthToken = DEFAULT_TOKEN;
        dirty = true;
      }
    } else if (!currentToken || currentToken === DEFAULT_TOKEN) {
      localCfg.ledgerNetworkAuthToken = crypto.randomBytes(24).toString('hex');
      dirty = true;
    }
    const shippedPublicUrl = normalizePeerUrl(runtime.ledgerNetworkPublicUrl);
    const bundledPeerUrls = Array.from(
      new Set(
        [...(Array.isArray(runtime.ledgerPeers) ? runtime.ledgerPeers : []), ...loadBundledSeedPeers()]
          .map(normalizePeerUrl)
          .filter(Boolean),
      ),
    );
    if (
      !Object.prototype.hasOwnProperty.call(localCfg, 'ledgerNetworkPublicUrl') &&
      shippedPublicUrl &&
      bundledPeerUrls.includes(shippedPublicUrl)
    ) {
      localCfg.ledgerNetworkPublicUrl = '';
      dirty = true;
    }
    if (dirty) {
      const dir = path.dirname(localPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(localPath, JSON.stringify(localCfg, null, 2), 'utf8');
      console.log(
        shouldUseSharedPeerToken
          ? '[startup] Normalized peer-network credentials.'
          : '[startup] Generated unique per-machine credentials.',
      );
    }
  } catch (e) {
    console.error('[startup] Failed to generate RPC credentials:', e);
  }
}

module.exports = { setupRpcCredentials };
