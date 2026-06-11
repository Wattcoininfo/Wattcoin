'use strict';

const dgram = require('dgram');
const crypto = require('crypto');

const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_RESPONSE = 0x0101;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;
const ATTR_MAPPED_ADDRESS = 0x0004;
const STUN_DEFAULT_PORT = 19302;
const STUN_TIMEOUT_MS = 3000;
const STUN_RETRIES = 2;

const NAT_TYPE = {
  UNKNOWN: 'unknown',
  PUBLIC: 'public',
  FULL_CONE: 'full-cone',
  RESTRICTED_CONE: 'restricted-cone',
  PORT_RESTRICTED_CONE: 'port-restricted-cone',
  SYMMETRIC: 'symmetric',
  TIMEOUT: 'timeout',
};

function serializeStunMessage(messageType, transactionId) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(messageType, 0);
  header.writeUInt16BE(0, 2); // length placeholder
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8, 0, 12);
  return header;
}

function parseStunResponse(msg) {
  if (msg.length < 20) return null;
  const messageType = msg.readUInt16BE(0);
  const length = msg.readUInt16BE(2);
  const magicCookie = msg.readUInt32BE(4);
  if (magicCookie !== STUN_MAGIC_COOKIE) return null;
  if (messageType !== STUN_BINDING_RESPONSE) return null;
  const transactionId = Buffer.alloc(12);
  msg.copy(transactionId, 0, 8, 20);

  let offset = 20;
  const end = 20 + length;
  let mappedAddress = null;
  let xorMappedAddress = null;

  while (offset + 4 <= end) {
    const attrType = msg.readUInt16BE(offset);
    const attrLength = msg.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + attrLength > end) break;

    if (attrType === ATTR_XOR_MAPPED_ADDRESS && attrLength >= 8) {
      xorMappedAddress = parseXorMappedAddress(msg, offset, transactionId);
    } else if (attrType === ATTR_MAPPED_ADDRESS && attrLength >= 8) {
      mappedAddress = parseMappedAddress(msg, offset);
    }
    offset += attrLength;
    if (attrLength % 4 !== 0) offset += 4 - (attrLength % 4);
  }

  return { xorMappedAddress: xorMappedAddress || mappedAddress, mappedAddress, transactionId };
}

function parseXorMappedAddress(msg, offset, _transactionId) {
  const family = msg.readUInt8(offset + 1);
  if (family !== 0x01) return null;
  const xorPort = msg.readUInt16BE(offset + 2);
  const port = xorPort ^ (STUN_MAGIC_COOKIE >>> 16);
  const ipBytes = [];
  for (let i = 0; i < 4; i++) {
    const cookieByte = (STUN_MAGIC_COOKIE >>> ((3 - i) * 8)) & 0xff;
    ipBytes.push(msg.readUInt8(offset + 4 + i) ^ cookieByte);
  }
  return { ip: ipBytes.join('.'), port };
}

function parseMappedAddress(msg, offset) {
  const family = msg.readUInt8(offset + 1);
  if (family !== 0x01) return null;
  const port = msg.readUInt16BE(offset + 2);
  const ip = [];
  for (let i = 0; i < 4; i++) ip.push(msg.readUInt8(offset + 4 + i));
  return { ip: ip.join('.'), port };
}

function queryStunServer(host, port = STUN_DEFAULT_PORT, timeoutMs = STUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const transactionId = crypto.randomBytes(12);
    const request = serializeStunMessage(STUN_BINDING_REQUEST, transactionId);
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('STUN timeout'));
    }, timeoutMs);

    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      const result = parseStunResponse(msg);
      if (!result) {
        reject(new Error('Invalid STUN response'));
        return;
      }
      resolve(result);
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });

    sock.send(request, 0, request.length, port, host, (err) => {
      if (err) {
        clearTimeout(timer);
        sock.close();
        reject(err);
      }
    });
  });
}

async function queryStunWithRetry(host, port = STUN_DEFAULT_PORT, timeoutMs = STUN_TIMEOUT_MS) {
  for (let attempt = 0; attempt <= STUN_RETRIES; attempt++) {
    try {
      return await queryStunServer(host, port, timeoutMs);
    } catch (_) {
      if (attempt === STUN_RETRIES) throw _;
    }
  }
}

async function getMappedAddress(
  stunServers = ['stun.l.google.com', 'stun1.l.google.com'],
  timeoutMs = STUN_TIMEOUT_MS,
) {
  for (const host of stunServers) {
    try {
      const result = await queryStunWithRetry(host, STUN_DEFAULT_PORT, timeoutMs);
      if (result && result.xorMappedAddress) {
        return { ip: result.xorMappedAddress.ip, port: result.xorMappedAddress.port, host };
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}

function parseIpv4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return parts;
}

function isPrivateIpv4(ip) {
  const parts = parseIpv4(ip);
  if (!parts) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 127) return true;
  return false;
}

async function detectNatType(options = {}) {
  const {
    stunServers = ['stun.l.google.com', 'stun1.l.google.com', 'stun2.l.google.com'],
    timeoutMs = STUN_TIMEOUT_MS,
    localIp = '',
  } = options;

  const result1 = await getMappedAddress(stunServers.slice(0, 2), timeoutMs);
  if (!result1) {
    return { natType: NAT_TYPE.TIMEOUT, mappedIp: '', mappedPort: 0, error: 'Could not reach any STUN server' };
  }

  if (localIp && result1.ip === localIp && !isPrivateIpv4(result1.ip)) {
    return { natType: NAT_TYPE.PUBLIC, mappedIp: result1.ip, mappedPort: result1.port, stunHost: result1.host };
  }

  if (stunServers.length < 2) {
    return { natType: NAT_TYPE.UNKNOWN, mappedIp: result1.ip, mappedPort: result1.port, stunHost: result1.host };
  }

  const result2 = await getMappedAddress(stunServers.slice(1, 3), timeoutMs);
  if (!result2) {
    return { natType: NAT_TYPE.CONE, mappedIp: result1.ip, mappedPort: result1.port, stunHost: result1.host };
  }

  if (result1.ip !== result2.ip || result1.port !== result2.port) {
    return { natType: NAT_TYPE.SYMMETRIC, mappedIp: result1.ip, mappedPort: result1.port, stunHost: result1.host };
  }

  if (isPrivateIpv4(localIp)) {
    return { natType: NAT_TYPE.CONE, mappedIp: result1.ip, mappedPort: result1.port, stunHost: result1.host };
  }

  return { natType: NAT_TYPE.PUBLIC, mappedIp: result1.ip, mappedPort: result1.port, stunHost: result1.host };
}

const DEFAULT_STUN_SERVERS = ['stun.l.google.com', 'stun1.l.google.com', 'stun2.l.google.com'];

module.exports = {
  NAT_TYPE,
  DEFAULT_STUN_SERVERS,
  getMappedAddress,
  detectNatType,
  queryStunServer,
};
