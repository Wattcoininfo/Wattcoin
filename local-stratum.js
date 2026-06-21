'use strict';
const net = require('net');
const crypto = require('crypto');

const SERVERS = new Map();
const SERVER_STATS = new Map();
const SHARE_BUFFERS = new Map(); // port -> circular array of share entries
const SESSIONS = new Map(); // port -> Set<StratumSession>
const STRATUM_DIFFICULTY = 12;
let _x11Digest = null;

function bitsToTargetHex(nbits) {
  const mant = nbits & 0xffffff;
  const exp = (nbits >>> 24) - 3;
  return mant.toString(16).padStart(6, '0') + '00'.repeat(exp);
}

function targetFromNBits(nbitsHex) {
  return BigInt('0x' + bitsToTargetHex(parseInt(nbitsHex, 16)));
}

function hashLE(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[buf.length - 1 - i];
  return out;
}

// Pre-compute share-target nBits from stratum difficulty:
//   target = max_target / difficulty
//   nBits  = (exponent << 24) | mantissa  (3 most significant bytes of target)
const _computeNbits = (() => {
  const MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
  const target = MAX_TARGET / BigInt(STRATUM_DIFFICULTY);
  const hex = target.toString(16).padStart(2, '0');
  const byteLen = Math.ceil(hex.length / 2);
  return ((byteLen << 24) | parseInt(hex.slice(0, 6), 16)).toString(16).padStart(8, '0');
})();

function makeJob() {
  const prevHash = crypto.randomBytes(32);
  const extra = crypto.randomBytes(8);
  return {
    jobId: Date.now().toString(36) + crypto.randomBytes(2).toString('hex'),
    prevHashHex: hashLE(prevHash).toString('hex'),
    coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff' + crypto.randomBytes(4).toString('hex'),
    coinb2: 'ffffffff' + extra.toString('hex'),
    versionHex: '20000000',
    nbitsHex: _computeNbits,
    ntimeHex: Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
    cleanJobs: true,
  };
}

class StratumSession {
  constructor(socket, port) {
    this.socket = socket;
    this.port = port;
    this.extraNonce1 = crypto.randomBytes(4).toString('hex');
    this.extraNonce2Len = 8;
    this.buffer = '';
    this.connected = true;
    this.workerName = '';
    this.lastJob = null;
    this.subscribed = false;
    const sessions = SESSIONS.get(port);
    if (sessions) sessions.add(this);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => {
      this.connected = false;
      const s = SESSIONS.get(this.port);
      if (s) s.delete(this);
    });
    socket.on('error', () => {
      this.connected = false;
      const s = SESSIONS.get(this.port);
      if (s) s.delete(this);
    });
  }

  send(msg) {
    if (this.connected) this.socket.write(JSON.stringify(msg) + '\n');
  }

  _onData(data) {
    this.buffer += data.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) {
      const m = line.trim();
      if (!m) continue;
      try { this._handle(JSON.parse(m)); } catch (_) {}
    }
  }

  _handle(msg) {
    if (msg.method === 'mining.subscribe') {
      const subId = crypto.randomBytes(8).toString('hex');
      this.send({
        id: msg.id,
        result: [[['mining.notify', subId]], this.extraNonce1, this.extraNonce2Len],
        error: null,
      });
      this.send({ id: null, method: 'mining.set_difficulty', params: [1] });
      this.subscribed = true;
      this._pushJob();
    } else if (msg.method === 'mining.authorize') {
      this.workerName = String(msg.params && msg.params[0] || '');
      this.send({ id: msg.id, result: true, error: null });
    } else if (msg.method === 'mining.submit') {
      const [, jobId, extranonce2, ntime, nonce] = msg.params || [];
      const valid = this._validateShare(jobId, extranonce2, ntime, nonce);
      this.send({ id: msg.id, result: valid, error: valid ? null : [22, 'low difficulty share', null] });
      if (valid) {
        const stats = SERVER_STATS.get(this.port);
        if (stats) stats.validShares++;
      }
    }
  }

  _validateShare(jobId, extranonce2, ntime, nonce) {
    if (!jobId || !extranonce2 || !ntime || !nonce) return false;
    const job = this.lastJob;
    if (!job || job.jobId !== jobId) return false;

    if (!_x11Digest) return false;

    const coinbase = Buffer.concat([
      Buffer.from(job.coinb1, 'hex'),
      Buffer.from(this.extraNonce1, 'hex'),
      Buffer.from(extranonce2, 'hex'),
      Buffer.from(job.coinb2, 'hex'),
    ]);
    const coinbaseHash = crypto.createHash('sha256').update(
      crypto.createHash('sha256').update(coinbase).digest()
    ).digest();

    const header = Buffer.concat([
      Buffer.from(job.versionHex, 'hex').reverse(),
      Buffer.from(job.prevHashHex, 'hex').reverse(),
      coinbaseHash,
      Buffer.from(ntime.padStart(8, '0'), 'hex').reverse(),
      Buffer.from(job.nbitsHex, 'hex').reverse(),
      Buffer.from(nonce.padStart(8, '0'), 'hex').reverse(),
    ]);
    if (header.length !== 80) return false;

    const hash = Buffer.from(_x11Digest(header));
    const hashVal = BigInt('0x' + hash.reverse().toString('hex'));
    const targetVal = targetFromNBits(job.nbitsHex);
    const valid = hashVal > 0n && hashVal <= targetVal;
    if (valid) {
      const buf = SHARE_BUFFERS.get(this.port);
      if (buf) {
        buf.push({
          headerHex: header.toString('hex'),
          hashHex: hash.toString('hex'),
          nbitsHex: job.nbitsHex,
          timestamp: Date.now(),
          extranonce2,
          nonce,
          ntime,
          jobId,
        });
        if (buf.length > 50) buf.splice(0, buf.length - 50);
      }
    }
    return valid;
  }

  _pushJob() {
    if (!this.connected || !this.subscribed) return;
    const job = makeJob();
    this.lastJob = job;
    this.send({
      id: null, method: 'mining.notify',
      params: [
        job.jobId, job.prevHashHex, job.coinb1, job.coinb2,
        [], job.versionHex, job.nbitsHex, job.ntimeHex, job.cleanJobs,
      ],
    });
  }
}

/**
 * Push a custom mining.notify to all sessions on a stratum port.
 * The ASIC must hash a header built from prevHashHex and produce
 * a valid X11 share — used for peer-verifiable ASIC liveness challenges.
 * Returns the jobId or null if no sessions exist.
 */
function injectCustomJob(port, prevHashHex) {
  const sessions = SESSIONS.get(port);
  if (!sessions || sessions.size === 0) return null;
  const jobId = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  for (const session of sessions) {
    if (!session.connected || !session.subscribed) continue;
    const job = {
      jobId,
      prevHashHex,
      coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff' + crypto.randomBytes(4).toString('hex'),
      coinb2: 'ffffffff' + crypto.randomBytes(8).toString('hex'),
      versionHex: '20000000',
      nbitsHex: _computeNbits,
      ntimeHex: Math.floor(Date.now() / 1000).toString(16).padStart(8, '0'),
      cleanJobs: true,
    };
    session.lastJob = job;
    session.send({
      id: null, method: 'mining.notify',
      params: [
        job.jobId, job.prevHashHex, job.coinb1, job.coinb2,
        [], job.versionHex, job.nbitsHex, job.ntimeHex, job.cleanJobs,
      ],
    });
  }
  return jobId;
}

async function startStratumServer(port) {
  if (SERVERS.has(port)) return null;
  if (!_x11Digest) {
    const loadX11 = require('wasm-x11-hash');
    const mod = await loadX11();
    _x11Digest = mod.digest;
  }
  SERVER_STATS.set(port, { validShares: 0 });
  SHARE_BUFFERS.set(port, []);
  SESSIONS.set(port, new Set());
  const server = net.createServer((socket) => {
    new StratumSession(socket, port);
  });
  server.listen(port, '0.0.0.0');
  SERVERS.set(port, server);
  return {
    getShareCount: () => { const s = SERVER_STATS.get(port); return s ? s.validShares : 0; },
  };
}

function stopStratumServer(port) {
  const server = SERVERS.get(port);
  if (!server) return;
  try { server.close(); } catch (_) {}
  SERVERS.delete(port);
  SERVER_STATS.delete(port);
  SHARE_BUFFERS.delete(port);
}

function stopAll() {
  for (const [port] of SERVERS) stopStratumServer(port);
}

function getTotalValidShares() {
  let total = 0;
  for (const [, stats] of SERVER_STATS) total += stats.validShares;
  return total;
}

/**
 * Wait until at least `count` new shares arrive with timestamps > sinceMs.
 * Returns { shares, shareCount } where shares is up to `count` entries
 * and shareCount is the total valid shares across all stratum ports.
 */
async function waitForFreshShares(count, sinceMs) {
  const deadline = Date.now() + 12000;
  const collected = [];
  while (collected.length < count && Date.now() < deadline) {
    for (const [, buf] of SHARE_BUFFERS) {
      for (const entry of buf) {
        if (entry.timestamp > sinceMs && !entry._consumed) {
          entry._consumed = true;
          collected.push(entry);
          if (collected.length >= count) break;
        }
      }
      if (collected.length >= count) break;
    }
    if (collected.length < count) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return { shares: collected.slice(0, count), shareCount: getTotalValidShares() };
}

/**
 * Verify an X11 share independently:
 *   headerHex — 160 hex chars (80-byte block header)
 *   hashHex   — 64 hex chars (32-byte claimed X11 hash)
 *   nbitsHex  — 8 hex chars (difficulty target encoded in nBits format)
 * Returns true if X11(header) === hashHex and hash meets difficulty target.
 */
async function verifyX11Share(headerHex, hashHex, nbitsHex) {
  if (!_x11Digest) {
    const loadX11 = require('wasm-x11-hash');
    const mod = await loadX11();
    _x11Digest = mod.digest;
  }
  const header = Buffer.from(headerHex, 'hex');
  if (header.length !== 80) return false;
  const computed = Buffer.from(_x11Digest(header));
  const expected = Buffer.from(hashHex, 'hex');
  if (!computed.equals(expected)) return false;
  const hashVal = BigInt('0x' + computed.reverse().toString('hex'));
  const targetVal = targetFromNBits(parseInt(nbitsHex, 16));
  return hashVal > 0n && hashVal <= targetVal;
}

module.exports = { startStratumServer, stopStratumServer, stopAll, getTotalValidShares, waitForFreshShares, verifyX11Share, injectCustomJob, STRATUM_DIFFICULTY };
