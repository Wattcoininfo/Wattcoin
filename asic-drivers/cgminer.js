const crypto = require('crypto');

const name = 'cgminer';
const probePorts = [4028, 4029, 4030];

function doubleSha256(buf) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest('hex');
}

async function apiFetch(ip, port, command, parameter, timeoutMs = 8000) {
  const body = parameter != null ? { command, parameter } : { command };
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${ip}:${port}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

async function detect(ip, port) {
  const json = await apiFetch(ip, port, 'version', null, 3000);
  const ver = json && json.VERSION && json.VERSION[0];
  if (ver && (ver.Type || ver.Miner)) {
    return {
      isAsic: true,
      model: String(ver.Type || ver.Miner || '').trim(),
      version: String(ver.Version || '').trim(),
      driverName: name,
    };
  }
  return null;
}

async function getTelemetry(ip, port) {
  const [statsJson, devsJson, versionJson, poolsJson] = await Promise.all([
    apiFetch(ip, port, 'stats'),
    apiFetch(ip, port, 'devs'),
    apiFetch(ip, port, 'version'),
    apiFetch(ip, port, 'pools'),
  ]);

  const stats = statsJson && (statsJson.STATS || [])[0];
  const devs = devsJson && devsJson.DEVS;
  const ver = versionJson && (versionJson.VERSION || [])[0];
  const pools = poolsJson && poolsJson.POOLS;

  const telemetry = {
    tempInlet: stats ? parseFloat(stats['temp1'] || stats['temp_inlet'] || 0) : null,
    tempOutlet: stats ? parseFloat(stats['temp2'] || stats['temp_outlet'] || 0) : null,
    tempChip: stats ? parseFloat(stats['temp3'] || stats['temp_chip'] || stats['temp'] || 0) : null,
    fanSpeedRpm: stats ? parseInt(stats['fan1'] || stats['fan_speed'] || 0, 10) : null,
    fanNum: stats ? parseInt(stats['fan_num'] || 0, 10) : null,
    chainNum: stats ? parseInt(stats['chain_num'] || stats['ChainNum'] || 0, 10) : null,
    chipCount: stats ? parseInt(stats['ChipCount'] || stats['chip_count'] || stats['TotalASC'] || 0, 10) : null,
    voltage: stats ? parseFloat(stats['voltage'] || stats['Voltage'] || 0) : null,
    frequency: stats ? parseInt(stats['frequency'] || stats['Frequency'] || stats['clock'] || 0, 10) : null,
    hwErrors: stats ? parseInt(stats['Hardware Errors'] || stats['hw_errors'] || 0, 10) : null,
    acceptedShares: stats ? parseInt(stats['Accepted'] || stats['accepted'] || 0, 10) : null,
    rejectedShares: stats ? parseInt(stats['Rejected'] || stats['rejected'] || 0, 10) : null,
    uptimeSeconds: stats ? parseInt(stats['Elapsed'] || stats['uptime'] || 0, 10) : null,
    minerType: ver ? String(ver['Type'] || ver['Miner'] || '').trim() : '',
    minerVersion: ver ? String(ver['Version'] || ver['API'] || '').trim() : '',
    poolCount: Array.isArray(pools) ? pools.length : null,
    devCount: Array.isArray(devs) ? devs.length : null,
    devDetails: Array.isArray(devs)
      ? devs.slice(0, 6).map((d) => ({
          name: d['Name'] || '',
          temp: parseFloat(d['Temperature'] || 0),
          freq: parseInt(d['Frequency'] || 0, 10),
          hashrate: parseFloat(d['MHS 5s'] || d['MHS av'] || d['GHS 5s'] || d['GHS av'] || 0),
          status: String(d['Status'] || '').trim(),
          hw: parseFloat(d['Hardware Errors'] || 0),
        }))
      : [],
  };

  computeSignalScore(telemetry);
  return telemetry;
}

async function getHashrate(ip, port) {
  const json = await apiFetch(ip, port, 'summary', null, 5000);
  const sum = json && json.SUMMARY && json.SUMMARY[0];
  if (sum) {
    const ghsAv = parseFloat(sum['GHS av'] || 0);
    const ghs5s = parseFloat(sum['GHS 5s'] || 0);
    const mhsAv = parseFloat(sum['MHS av'] || 0);
    const mhs5s = parseFloat(sum['MHS 5s'] || 0);
    return Math.max(ghsAv, ghs5s) / 1000 || Math.max(mhsAv, mhs5s) / 1_000_000 || 0;
  }
  return 0;
}

async function configurePool(ip, port, poolUrl) {
  try {
    const res = await apiFetch(ip, port, 'addpool', poolUrl, 10000);
    if (res && (res.addpool === true || Array.isArray(res.addpool))) {
      await apiFetch(ip, port, 'enablepool', '0', 5000);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function disablePool(ip, port) {
  try {
    const json = await apiFetch(ip, port, 'disablepool', '0', 5000);
    return !!(json && json.disablepool === true);
  } catch {
    return false;
  }
}

async function verifyLiveness(ip, port, stratumPort, stratumHandles) {
  const ROUNDS = 8;
  const CHUNK_BYTES = 1024;

  const startShares =
    stratumPort && stratumHandles.has(stratumPort) ? stratumHandles.get(stratumPort).getShareCount() : null;
  const startMs = Date.now();
  let asicType = '';

  for (let i = 0; i < ROUNDS; i++) {
    const data = crypto.randomBytes(CHUNK_BYTES);
    const expected = doubleSha256(data);
    const hex = data.toString('hex');

    const json = await apiFetch(ip, port, 'check', hex, 15000);
    const record = json && json.check && json.check[0];
    const actual = record && record.Hash;
    if (!actual || String(actual).toLowerCase() !== expected) {
      throw new Error(`hash mismatch at round ${i}`);
    }
    if (i === 0) {
      asicType = String(record.Type || record.Miner || record.Description || '').trim();
    }
  }

  const elapsedMs = Date.now() - startMs;
  const telemetry = await getTelemetry(ip, port);
  const endShares =
    stratumPort && stratumHandles.has(stratumPort) ? stratumHandles.get(stratumPort).getShareCount() : null;
  const shareDelta = startShares !== null && endShares !== null ? endShares - startShares : null;
  const shareRatePerSec = shareDelta !== null && elapsedMs > 0 ? (shareDelta / elapsedMs) * 1000 : null;

  return {
    ok: true,
    elapsedMs,
    rounds: ROUNDS,
    bytesTotal: ROUNDS * CHUNK_BYTES,
    port,
    asicType,
    ip,
    telemetry,
    shareDelta,
    shareRatePerSec,
  };
}

async function verifyFirmware(ip, port, checkModel, _declaredModel) {
  const result = {
    ok: true,
    identities: [],
    compileTimes: [],
    issues: [],
  };

  ip = ip || '127.0.0.1';

  if (checkModel) {
    result.identities.push({ source: 'check.Type', value: checkModel });
  }

  const versionJson = await apiFetch(ip, port, 'version', null, 10000);
  const versionRecord = versionJson && versionJson.VERSION && versionJson.VERSION[0];
  if (versionRecord) {
    const type = String(versionRecord.Type || '').trim();
    const miner = String(versionRecord.Miner || '').trim();
    const compileTime = String(versionRecord.CompileTime || '').trim();
    if (type) result.identities.push({ source: 'version.Type', value: type });
    if (miner) result.identities.push({ source: 'version.Miner', value: miner });
    if (compileTime) result.compileTimes.push(compileTime);
  } else {
    result.issues.push('version command failed');
  }

  const statsJson = await apiFetch(ip, port, 'stats', null, 10000);
  const statsRecords = statsJson && statsJson.STATS;
  if (Array.isArray(statsRecords) && statsRecords.length > 0) {
    for (const rec of statsRecords) {
      if (rec && rec.id !== 0) {
        const type = String(rec.Type || '').trim();
        const miner = String(rec.Miner || '').trim();
        const compileTime = String(rec.CompileTime || '').trim();
        if (type) result.identities.push({ source: 'stats.Type', value: type });
        if (miner) result.identities.push({ source: 'stats.Miner', value: miner });
        if (compileTime) result.compileTimes.push(compileTime);
      }
    }
  } else {
    result.issues.push('stats command failed');
  }

  const identityValues = result.identities.map((i) => i.value);
  const uniqueIdentities = new Set(identityValues.map((v) => v.toLowerCase().replace(/\s+/g, ' ').trim()));
  if (identityValues.length >= 2 && uniqueIdentities.size > 1) {
    result.issues.push(
      `firmware model mismatch: conflicting identities [${[...new Set(identityValues)].join(', ')}]` +
        ` across check/version/stats API commands`,
    );
  }

  if (result.compileTimes.length === 0) {
    result.issues.push('no compile time reported');
  }

  result.ok = result.issues.length === 0;
  return result;
}

function computeSignalScore(telemetry) {
  let signalScore = 0;
  let maxSignals = 0;

  if (telemetry.tempInlet !== null && telemetry.tempInlet > 15 && telemetry.tempInlet < 60) signalScore++;
  maxSignals++;
  if (telemetry.tempOutlet !== null && telemetry.tempOutlet > telemetry.tempInlet && telemetry.tempOutlet < 90)
    signalScore++;
  maxSignals++;
  if (telemetry.tempChip !== null && telemetry.tempChip >= telemetry.tempOutlet && telemetry.tempChip < 110)
    signalScore++;
  maxSignals++;

  if (telemetry.fanSpeedRpm !== null && telemetry.fanSpeedRpm >= 1500 && telemetry.fanSpeedRpm <= 8000) signalScore++;
  maxSignals++;
  if (telemetry.fanNum !== null && telemetry.fanNum >= 1) signalScore++;
  maxSignals++;

  if (telemetry.chainNum !== null && telemetry.chainNum >= 1) signalScore++;
  maxSignals++;
  if (telemetry.chipCount !== null && telemetry.chipCount > 0) signalScore++;
  maxSignals++;

  if (telemetry.voltage !== null && telemetry.voltage > 5 && telemetry.voltage < 25) signalScore++;
  maxSignals++;
  if (telemetry.frequency !== null && telemetry.frequency >= 100 && telemetry.frequency <= 1500) signalScore++;
  maxSignals++;

  if (telemetry.hwErrors !== null) signalScore++;
  maxSignals++;
  if (telemetry.uptimeSeconds !== null && telemetry.uptimeSeconds > 0) signalScore++;
  maxSignals++;

  if (telemetry.devCount !== null && telemetry.devCount >= 1) signalScore++;
  maxSignals++;
  if (telemetry.minerType.length > 0) signalScore++;
  maxSignals++;

  telemetry.signalScore = signalScore;
  telemetry.maxSignals = maxSignals;
  telemetry.signalRatio = maxSignals > 0 ? signalScore / maxSignals : 0;
  telemetry.isRealHardware = telemetry.signalRatio >= 0.6;
}

module.exports = {
  name,
  probePorts,
  detect,
  getTelemetry,
  getHashrate,
  configurePool,
  disablePool,
  verifyLiveness,
  verifyFirmware,
  computeSignalScore,
};
