// SPDX-License-Identifier: MIT
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = parseInt(process.env.SEED_REGISTRY_PORT || '', 10) || 4901;
const DATA_DIR = path.resolve(process.env.SEED_REGISTRY_DATA_DIR || 'htdocs');
const DATA_FILE = process.env.SEED_REGISTRY_DATA_FILE || path.join(DATA_DIR, 'seed-registry.json');
const PEER_TTL_MS = parseInt(process.env.SEED_REGISTRY_PEER_TTL_MS || '', 10) || 7200_000; // 2h
const CLEANUP_INTERVAL_MS = 600_000; // 10min

function readPeers() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed && parsed.seedPeers)) return parsed.seedPeers;
    if (Array.isArray(parsed && parsed.peers)) return parsed.peers;
    return [];
  } catch (_) {
    return [];
  }
}

function writePeers(peers) {
  const data = JSON.stringify({ seedPeers: peers, updatedAt: new Date().toISOString() }, null, 2);
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, data, 'utf8');
}

function normalizeUrl(raw) {
  try {
    const p = new URL(String(raw || '').trim());
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return '';
    const port = Number(p.port || (p.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 1023) return '';
    const pathname = p.pathname && p.pathname !== '/' ? p.pathname.replace(/\/+$/, '') : '';
    return `${p.protocol}//${p.hostname}:${port}${pathname}`;
  } catch (_) {
    return '';
  }
}

function addPeer(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return false;
  const peers = readPeers();
  const nowMs = Date.now();
  const existing = peers.find((p) => p.url === url);
  if (existing) {
    existing.lastSeenMs = nowMs;
  } else {
    peers.push({ url, firstSeenMs: nowMs, lastSeenMs: nowMs });
  }
  writePeers(peers);
  return true;
}

function prunePeers() {
  const peers = readPeers();
  const nowMs = Date.now();
  const before = peers.length;
  const filtered = peers.filter((p) => nowMs - (p.lastSeenMs || 0) < PEER_TTL_MS);
  if (filtered.length !== before) writePeers(filtered);
  return filtered;
}

function handleGet(res) {
  const peers = readPeers();
  const nowMs = Date.now();
  const valid = peers.filter((p) => nowMs - (p.lastSeenMs || 0) < PEER_TTL_MS);
  const urls = valid.map((p) => ({ url: p.url }));
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'https://wattcoin.ee',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify({ seedPeers: urls, updatedAt: new Date().toISOString() }) + '\n');
}

function handlePost(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      const rawUrl = String((parsed && parsed.url) || '').trim();
      if (!rawUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'missing url' }) + '\n');
        return;
      }
      const ok = addPeer(rawUrl);
      const count = readPeers().length;
      res.writeHead(ok ? 200 : 400, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://wattcoin.ee',
      });
      res.end(JSON.stringify({ ok, peerCount: count }) + '\n');
    } catch (e) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: 'invalid json' }) + '\n');
    }
  });
}

function handleOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': 'https://wattcoin.ee',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const method = req.method.toUpperCase();
  if (method === 'OPTIONS') return handleOptions(res);
  if (method === 'GET' && (parsed.pathname === '/' || parsed.pathname === '')) return handleGet(res);
  if (method === 'POST' && (parsed.pathname === '/' || parsed.pathname === '')) return handlePost(req, res);
  res.writeHead(404);
  res.end('not found\n');
});

prunePeers();
setInterval(prunePeers, CLEANUP_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`[SeedRegistry] Listening on port ${PORT}, data file: ${DATA_FILE}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
