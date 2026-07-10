'use strict';

const fs = require('fs');
const path = require('path');
const { getRuntimeConfig } = require('../electron-main/runtime-config');

function loadSeedPeers() {
  const filePath = path.join(__dirname, '..', 'docs', 'seed-peers.mainnet.json');
  if (!fs.existsSync(filePath)) return { filePath, seedPeers: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const seedPeers = Array.isArray(parsed.seedPeers)
    ? parsed.seedPeers
    : Array.isArray(parsed.peers)
      ? parsed.peers
      : [];
  return { filePath, seedPeers };
}

function main() {
  const runtime = getRuntimeConfig();
  const { filePath, seedPeers } = loadSeedPeers();
  const configuredPeers = Array.isArray(runtime.ledgerPeers) ? runtime.ledgerPeers : [];

  console.log('Wattcoin peer system');
  console.log('');
  console.log(`Network: ${runtime.network}`);
  console.log(`Peer mode enabled: ${runtime.ledgerNetworkEnabled}`);
  console.log(`Ledger mode: ${runtime.ledgerNetworkMode}`);
  console.log(`Configured peers: ${configuredPeers.length}`);
  console.log(`Bundled seed peers: ${seedPeers.length}`);
  console.log(`Seed peer file: ${filePath}`);
  console.log('');
  console.log('Discovery flow:');
  console.log('1. Start with local configured peers and bundled seed peers.');
  console.log('2. Restore recently discovered peers from userData/seed-peer-cache.json.');
  console.log('3. Announce on LAN via UDP multicast beacon at port 39311.');
  console.log('4. Query reachable peers at GET /api/v1/network/peers.');
  console.log('5. Merge learned peers into the discovered-peer set and cache them.');
  console.log('6. Validate actual chain state through chain tip, headers, blocks, and consensus votes.');
  console.log('');
  console.log('Decentralization model:');
  console.log('- Seed peers are first-contact hints only.');
  console.log('- Configured peers form the static active peer list.');
  console.log('- Bundled seeds are used as directory/bootstrap targets, not default sync peers.');
  console.log('- Any reachable peer can advertise other peers.');
  console.log('- No single host is trusted to define the chain.');
  console.log('- Chain truth comes from protocol validation, not peer-list origin.');
  console.log('');
  if (seedPeers.length > 0) {
    console.log('Bundled seed peers:');
    for (const peer of seedPeers) {
      console.log(`- ${peer.url} (${peer.provider || 'unknown-provider'} / ${peer.region || 'unknown-region'})`);
    }
  }
}

main();
