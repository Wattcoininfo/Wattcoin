const { default: NatAPI } = require('@silentbot1/nat-api');
let client = null;

const UPNP_DESCRIPTION = 'Wattcoin Miner P2P';

async function setupUpnpPortMapping(listenPort, listenHost) {
  removeUpnpPortMapping();
  try {
    client = new NatAPI({ enableUPNP: true, enablePMP: false, autoUpdate: true });
    const publicIp = await client.externalIp();
    if (!publicIp) {
      console.log('[UPnP] No public IP returned from gateway; skipping port mapping.');
      removeUpnpPortMapping();
      return null;
    }
    const privateHost = getLanAddress(listenHost);
    const mapped = await client.map({
      publicPort: listenPort,
      privatePort: listenPort,
      protocol: 'TCP',
      description: UPNP_DESCRIPTION,
    });
    if (!mapped) {
      console.log('[UPnP] Port mapping failed on router; skipping.');
      removeUpnpPortMapping();
      return null;
    }
    console.log(
      `[UPnP] Port ${listenPort} forwarded to ${privateHost}:${listenPort} — public: ${publicIp}:${listenPort}`,
    );
    return { publicIp, publicPort: listenPort };
  } catch (err) {
    console.log(`[UPnP] Port mapping failed: ${err && err.message ? err.message : String(err)}`);
    removeUpnpPortMapping();
    return null;
  }
}

function removeUpnpPortMapping() {
  if (!client) return;
  const c = client;
  client = null;
  c.destroy().catch(() => {});
}

function getLanAddress(listenHost) {
  if (!listenHost || listenHost === '0.0.0.0' || listenHost === '::') {
    try {
      const interfaces = require('os').networkInterfaces();
      for (const entries of Object.values(interfaces)) {
        for (const entry of entries || []) {
          if (entry && entry.family === 'IPv4' && !entry.internal) return entry.address;
        }
      }
      return '127.0.0.1';
    } catch (_) {
      return '127.0.0.1';
    }
  }
  return listenHost;
}

module.exports = { setupUpnpPortMapping, removeUpnpPortMapping };
