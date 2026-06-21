const name = 'nmminer';
const probePorts = [80, 8080];

async function apiGetJson(ip, port, path, timeoutMs = 5000) {
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function apiPostJson(ip, port, path, body, timeoutMs = 5000) {
  try {
    const res = await fetch(`http://${ip}:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function detect(ip, port) {
  const probe = await apiGetJson(ip, port, '/probe', 3000);
  if (probe && (probe.type || probe.model || probe.family)) {
    return {
      isAsic: true,
      model: String(probe.model || probe.type || probe.family || '').trim(),
      version: String(probe.version || probe.firmware || '').trim(),
      driverName: name,
    };
  }

  const info = await apiGetJson(ip, port, '/api/system/info', 3000);
  if (info && (info.model || info.type || info.minerType)) {
    return {
      isAsic: true,
      model: String(info.model || info.type || info.minerType || '').trim(),
      version: String(info.version || info.firmware || '').trim(),
      driverName: name,
    };
  }
  return null;
}

async function getTelemetry(ip, port) {
  const info = await apiGetJson(ip, port, '/api/system/info', 5000);
  if (!info) return null;

  const telemetry = {
    tempInlet:
      info.temp1 != null ? parseFloat(info.temp1) : info.temp_inlet != null ? parseFloat(info.temp_inlet) : null,
    tempOutlet:
      info.temp2 != null ? parseFloat(info.temp2) : info.temp_outlet != null ? parseFloat(info.temp_outlet) : null,
    tempChip: info.temp3 != null ? parseFloat(info.temp3) : info.temp_chip != null ? parseFloat(info.temp_chip) : null,
    fanSpeedRpm:
      info.fan != null ? parseInt(info.fan, 10) : info.fan_speed != null ? parseInt(info.fan_speed, 10) : null,
    fanNum: info.fan_num != null ? parseInt(info.fan_num, 10) : null,
    chainNum: info.chain_num != null ? parseInt(info.chain_num, 10) : null,
    chipCount: info.chip_count != null ? parseInt(info.chip_count, 10) : null,
    voltage: info.voltage != null ? parseFloat(info.voltage) : null,
    frequency: info.frequency != null ? parseInt(info.frequency, 10) : null,
    hwErrors: info.hw_errors != null ? parseInt(info.hw_errors, 10) : null,
    acceptedShares: info.accepted != null ? parseInt(info.accepted, 10) : null,
    rejectedShares: info.rejected != null ? parseInt(info.rejected, 10) : null,
    uptimeSeconds: info.uptime != null ? parseInt(info.uptime, 10) : null,
    minerType: String(info.model || info.type || info.minerType || '').trim(),
    minerVersion: String(info.version || info.firmware || '').trim(),
    poolCount: info.pool_count != null ? parseInt(info.pool_count, 10) : null,
    devCount: info.hashboard_count != null ? parseInt(info.hashboard_count, 10) : null,
    devDetails: [],
  };

  if (Array.isArray(info.hashboards)) {
    telemetry.devDetails = info.hashboards.slice(0, 6).map((hb) => ({
      name: String(hb.name || hb.id || ''),
      temp: parseFloat(hb.temp || 0),
      freq: parseInt(hb.frequency || 0, 10),
      hashrate: parseFloat(hb.hashrate || 0),
      status: String(hb.status || '').trim(),
      hw: parseFloat(hb.hw_errors || 0),
    }));
  }

  return telemetry;
}

async function getHashrate(ip, port) {
  const info = await apiGetJson(ip, port, '/api/system/info', 5000);
  if (!info) return 0;

  const raw = parseFloat(info.hashrate || info.hash_rate || info.ghs_av || info.ghs_5s || 0);
  if (!raw) return 0;

  return raw > 1_000_000 ? raw / 1_000_000 : raw > 1000 ? raw / 1000 : raw;
}

async function configurePool(ip, port, poolUrl) {
  const body = {
    url: poolUrl,
    worker: 'wtc',
    password: 'x',
  };
  const res = await apiPostJson(ip, port, '/api/setting/mining', body, 10000);
  return !!(res && (res.ok === true || res.success === true || res.error === undefined));
}

async function disablePool(ip, port) {
  const res = await apiPostJson(ip, port, '/api/setting/mining', { url: '', worker: '', password: '' }, 5000);
  return !!(res && (res.ok === true || res.success === true));
}

async function verifyLiveness(ip, port, stratumPort, stratumHandles) {
  const startShares =
    stratumPort && stratumHandles.has(stratumPort) ? stratumHandles.get(stratumPort).getShareCount() : null;
  const startMs = Date.now();

  const telemetry = await getTelemetry(ip, port);
  if (!telemetry) {
    return {
      ok: false,
      elapsedMs: Date.now() - startMs,
      rounds: 0,
      bytesTotal: 0,
      port,
      asicType: '',
      ip,
      telemetry: null,
      shareDelta: null,
      shareRatePerSec: null,
    };
  }

  const elapsedMs = Date.now() - startMs;
  const endShares =
    stratumPort && stratumHandles.has(stratumPort) ? stratumHandles.get(stratumPort).getShareCount() : null;
  const shareDelta = startShares !== null && endShares !== null ? endShares - startShares : null;
  const shareRatePerSec = shareDelta !== null && elapsedMs > 0 ? (shareDelta / elapsedMs) * 1000 : null;

  return {
    ok: true,
    elapsedMs,
    rounds: 0,
    bytesTotal: 0,
    port,
    asicType: telemetry.minerType,
    ip,
    telemetry,
    shareDelta,
    shareRatePerSec,
  };
}

async function verifyFirmware(_ip, _port, _checkModel, _declaredModel) {
  return { ok: true, identities: [], compileTimes: [], issues: [] };
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
};
