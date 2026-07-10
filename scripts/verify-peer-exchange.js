'use strict';

const http = require('http');

function normalizePeerUrl(peerUrl) {
  try {
    const parsed = new URL(String(peerUrl || '').trim());
    const port = Number(parsed.port || 80);
    if (!Number.isFinite(port) || port <= 1023) return '';
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch (_) {
    return '';
  }
}

class TestPeerNode {
  constructor(name, port, { configuredPeers = [], seedPeers = [], discoveredPeers = [] } = {}) {
    this.name = name;
    this.port = port;
    this.configuredPeers = configuredPeers.map(normalizePeerUrl).filter(Boolean);
    this.seedPeers = seedPeers.map(normalizePeerUrl).filter(Boolean);
    this.discoveredPeers = new Map();
    for (const peerUrl of discoveredPeers) {
      const normalized = normalizePeerUrl(peerUrl);
      if (normalized) this.discoveredPeers.set(normalized, { lastSeenMs: Date.now(), source: 'peer-exchange' });
    }
    this.server = null;
  }

  get selfUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  buildPeerList() {
    const seen = new Set();
    const rows = [];
    const push = (url, source) => {
      const normalized = normalizePeerUrl(url);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      rows.push({ url: normalized, source, lastSeenMs: Date.now() });
    };
    for (const peerUrl of this.configuredPeers) push(peerUrl, 'configured');
    for (const peerUrl of this.seedPeers) push(peerUrl, 'seed');
    for (const [peerUrl, info] of this.discoveredPeers.entries()) {
      push(peerUrl, info.source || 'peer-exchange');
    }
    return rows;
  }

  rememberPeer(peerUrl, source = 'peer-exchange') {
    const normalized = normalizePeerUrl(peerUrl);
    if (!normalized || normalized === this.selfUrl) return false;
    const existing = this.discoveredPeers.get(normalized);
    this.discoveredPeers.set(normalized, {
      lastSeenMs: Date.now(),
      source: String(source || (existing && existing.source) || 'peer-exchange'),
    });
    return !existing;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v1/network/peers') {
        const payload = JSON.stringify({ ok: true, network: 'wtc-mainnet', peers: this.buildPeerList() });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
        res.end(payload);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', resolve);
    });
  }

  async refreshPeerDirectory() {
    const targets = Array.from(new Set([...this.configuredPeers, ...this.seedPeers]));
    for (const peerUrl of targets) {
      await new Promise((resolve, reject) => {
        const req = http.request(new URL('/api/v1/network/peers', peerUrl), { method: 'GET', timeout: 5000 }, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const peers = Array.isArray(parsed.peers) ? parsed.peers : [];
              this.rememberPeer(peerUrl, 'peer-contact');
              for (const peer of peers) {
                this.rememberPeer(peer && peer.url, peer && peer.source ? `peer-${peer.source}` : 'peer-exchange');
              }
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.end();
      });
    }
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
  }
}

async function main() {
  const nodeB = new TestPeerNode('node-b', 39410, {
    seedPeers: ['http://127.0.0.1:39410'],
    discoveredPeers: ['http://127.0.0.1:39411'],
  });
  const nodeC = new TestPeerNode('node-c', 39411, {
    seedPeers: ['http://127.0.0.1:39411'],
  });
  const nodeA = new TestPeerNode('node-a', 39409, {
    seedPeers: ['http://127.0.0.1:39410'],
  });

  await Promise.all([nodeA.start(), nodeB.start(), nodeC.start()]);
  try {
    const before = nodeA
      .buildPeerList()
      .map((peer) => peer.url)
      .sort();
    console.log('Before peer exchange:', before.join(', '));

    await nodeA.refreshPeerDirectory();

    const after = nodeA
      .buildPeerList()
      .map((peer) => peer.url)
      .sort();
    console.log('After peer exchange:', after.join(', '));

    const grew = after.length > before.length && after.includes('http://127.0.0.1:39411');
    if (!grew) {
      throw new Error('Peer exchange did not grow beyond the bundled seed list.');
    }

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        new URL('/api/v1/network/peers', nodeA.selfUrl),
        { method: 'GET', timeout: 5000 },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    });

    console.log('GET /api/v1/network/peers on node-a:');
    console.log(JSON.stringify(res, null, 2));
    console.log('[peer-exchange] PASS');
  } finally {
    await Promise.all([nodeA.stop(), nodeB.stop(), nodeC.stop()]);
  }
}

main().catch((error) => {
  console.error('[peer-exchange] FAIL', error && error.message ? error.message : error);
  process.exitCode = 1;
});
