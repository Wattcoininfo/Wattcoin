'use strict';

const http = require('http');
const https = require('https');

function usage() {
  console.log('Usage: node scripts/verify-seed-endpoint.js <base-url> [expectedGenesisHash] [expectedNetworkId]');
  console.log('Example: node scripts/verify-seed-endpoint.js https://seed.wattcoin.ee 07165... wtc-mainnet');
}

function getJson(urlText) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch (_) {
      reject(new Error(`Invalid URL: ${urlText}`));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(parsed, { method: 'GET', timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(`${urlText} returned HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error(`${urlText} did not return valid JSON`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${urlText} timed out`)));
    req.end();
  });
}

async function main() {
  const baseUrl = String(process.argv[2] || '').trim();
  const expectedGenesisHash = String(process.argv[3] || '').trim();
  const expectedNetworkId = String(process.argv[4] || 'wtc-mainnet').trim();

  if (!baseUrl) {
    usage();
    process.exitCode = 1;
    return;
  }

  const normalizedBase = baseUrl.replace(/\/$/, '');
  const tipUrl = `${normalizedBase}/api/v1/chain/tip`;
  const peersUrl = `${normalizedBase}/api/v1/network/peers`;

  const peers = await getJson(peersUrl);
  let tip = null;
  try {
    tip = await getJson(tipUrl);
  } catch (_) {
    tip = null;
  }

  if (!peers || peers.ok !== true || !Array.isArray(peers.peers)) {
    throw new Error('peer exchange endpoint did not return ok=true with peers[]');
  }

  if (peers.directory === true) {
    if (expectedNetworkId && String(peers.networkId || '') !== expectedNetworkId) {
      throw new Error(`networkId mismatch: expected ${expectedNetworkId}, got ${peers.networkId}`);
    }
    if (expectedGenesisHash) {
      console.log(
        '[seed-endpoint] NOTE directory-only endpoint does not expose genesisHash; validate advertised peers separately if needed',
      );
    }

    console.log('[seed-endpoint] PASS');
    console.log(` baseUrl: ${normalizedBase}`);
    console.log(' mode: directory-only');
    console.log(` networkId: ${peers.networkId}`);
    console.log(` peerCountAdvertised: ${peers.peers.length}`);
    return;
  }

  if (!tip || tip.ok !== true) {
    throw new Error('chain tip endpoint did not return ok=true');
  }
  if (expectedNetworkId && String(tip.networkId || '') !== expectedNetworkId) {
    throw new Error(`networkId mismatch: expected ${expectedNetworkId}, got ${tip.networkId}`);
  }
  if (expectedGenesisHash && String(tip.genesisHash || '') !== expectedGenesisHash) {
    throw new Error(`genesisHash mismatch: expected ${expectedGenesisHash}, got ${tip.genesisHash}`);
  }

  console.log('[seed-endpoint] PASS');
  console.log(` baseUrl: ${normalizedBase}`);
  console.log(` networkId: ${tip.networkId}`);
  console.log(` protocolVersion: ${tip.protocolVersion}`);
  console.log(` genesisHash: ${tip.genesisHash}`);
  console.log(` peerCountAdvertised: ${peers.peers.length}`);
}

main().catch((error) => {
  console.error('[seed-endpoint] FAIL', error && error.message ? error.message : error);
  process.exitCode = 1;
});
