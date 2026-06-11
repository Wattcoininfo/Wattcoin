const { client: createUpnpClient } = require('nat-upnp');
let upnpClient = null;
let activeMapping = null; // { publicIp, publicPort, privatePort, ttl, description }

const UPNP_TIMEOUT_MS = 10000;
const UPNP_TTL = 0; // 0 = permanent (until removed or router restart)
const UPNP_DESCRIPTION = 'Wattcoin Miner P2P';

async function setupUpnpPortMapping(listenPort, listenHost) {
  removeUpnpPortMapping();
  try {
    upnpClient = createUpnpClient({ timeout: UPNP_TIMEOUT_MS });
    const publicIp = await new Promise((resolve, reject) => {
      upnpClient.externalIp((err, ip) => {
        if (err) reject(err);
        else resolve(ip);
      });
    });
    if (!publicIp) {
      console.log('[UPnP] No public IP returned from gateway; skipping port mapping.');
      return null;
    }
    const privateHost = getLanAddress(listenHost);
    await new Promise((resolve, reject) => {
      upnpClient.portMapping(
        {
          public: listenPort,
          private: listenPort,
          local: privateHost,
          ttl: UPNP_TTL,
          description: UPNP_DESCRIPTION,
          protocol: 'TCP',
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });
    activeMapping = { publicIp, publicPort: listenPort, privatePort: listenPort, privateHost };
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
  if (!upnpClient || !activeMapping) return;
  try {
    upnpClient.portUnmapping(
      {
        public: activeMapping.publicPort,
        protocol: 'TCP',
      },
      () => {},
    );
  } catch (_) {}
  try {
    upnpClient.close();
  } catch (_) {}
  upnpClient = null;
  activeMapping = null;
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
