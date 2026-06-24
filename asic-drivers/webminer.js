const name = 'webminer';
const probePorts = [80, 8080, 443];

const PRESETS = {
  elphapex: {
    manufacturer: 'Elphapex',
    detectPattern: /elphapex/i,
    detectUrl: '/',
    auth: { user: 'root', pass: 'root' },
    poolEndpoint: '/cgi-bin/pools.cgi',
    poolContentType: 'application/x-www-form-urlencoded',
    poolBody: (url, worker, pass) =>
      `pool1=${encodeURIComponent(url)}&worker1=${encodeURIComponent(worker)}&pass1=${encodeURIComponent(pass)}&pool2=&worker2=&pass2=&pool3=&worker3=&pass3=`,
    enableEndpoint: null,
    disableEndpoint: '/cgi-bin/pools.cgi',
    disableBody: () => `pool1=&worker1=&pass1=&pool2=&worker2=&pass2=&pool3=&worker3=&pass3=`,
    statusEndpoint: '/cgi-bin/miner_status.cgi',
    statusParser: parseElphapexStatus,
  },
  volcminer: {
    manufacturer: 'Volcminer',
    detectPattern: /volcminer|volcminer\s+d1|volc\s+d1/i,
    detectUrl: '/',
    auth: null,
    poolEndpoint: '/cgi-bin/set_pool.cgi',
    poolContentType: 'application/x-www-form-urlencoded',
    poolBody: (url, worker, pass) =>
      `pool1=${encodeURIComponent(url)}&worker=${encodeURIComponent(worker)}&password=${encodeURIComponent(pass)}`,
    enableEndpoint: null,
    disableEndpoint: '/cgi-bin/set_pool.cgi',
    disableBody: () => `pool1=&worker=&password=`,
    statusEndpoint: '/cgi-bin/get_status.cgi',
    statusParser: parseVolcminerStatus,
  },
  jasminer: {
    manufacturer: 'Jasminer',
    detectPattern: /jasminer|jas/i,
    detectUrl: '/',
    auth: null,
    poolEndpoint: '/api/miner/setting',
    poolContentType: 'application/json',
    poolBody: (url, worker, pass) => JSON.stringify({ pool1: url, worker, password: pass }),
    enableEndpoint: null,
    disableEndpoint: '/api/miner/setting',
    disableBody: () => JSON.stringify({ pool1: '', worker: '', password: '' }),
    statusEndpoint: '/api/miner/info',
    statusParser: parseJasminerStatus,
  },
};

async function apiRequest(ip, port, method, path, body, contentType, auth, timeoutMs = 5000) {
  try {
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    if (auth) {
      headers['Authorization'] = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
    }
    const opts = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body) opts.body = body;
    const res = await fetch(`http://${ip}:${port}${path}`, opts);
    const text = await res.text();
    return { ok: res.ok, text, status: res.status };
  } catch {
    return { ok: false, text: '', status: 0 };
  }
}

async function detect(ip, port) {
  const { ok, text } = await apiRequest(ip, port, 'GET', '/', null, null, null, 3000);
  if (!ok || !text) return null;

  for (const [key, preset] of Object.entries(PRESETS)) {
    if (preset.detectPattern.test(text)) {
      let model = key.charAt(0).toUpperCase() + key.slice(1);
      const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
      if (titleMatch) model = titleMatch[1].trim();
      return {
        isAsic: true,
        model,
        preset: key,
        driverName: name,
      };
    }
  }

  const tryJsonEndpoints = async () => {
    for (const [key, preset] of Object.entries(PRESETS)) {
      if (preset.statusEndpoint) {
        const { ok: jsonOk, text: jsonText } = await apiRequest(
          ip,
          port,
          'GET',
          preset.statusEndpoint,
          null,
          null,
          preset.auth,
          3000,
        ).catch(() => ({ ok: false, text: '' }));
        if (jsonOk && jsonText) {
          try {
            const parsed = JSON.parse(jsonText);
            if (parsed && (parsed.model || parsed.type)) {
              return {
                isAsic: true,
                model: String(parsed.model || parsed.type || preset.manufacturer).trim(),
                preset: key,
                driverName: name,
              };
            }
          } catch {
            /* json parse failed */
          }
        }
      }
    }
    return null;
  };

  return await tryJsonEndpoints();
}

async function _applyPresetAction(ip, port, presetKey, action) {
  const preset = PRESETS[presetKey];
  if (!preset) return false;

  const { ok } = await apiRequest(
    ip,
    port,
    'POST',
    preset[action + 'Endpoint'],
    preset[action + 'Body'](),
    preset.poolContentType,
    preset.auth,
    10000,
  );
  return ok;
}

async function configurePool(ip, port, poolUrl, driverConfig) {
  const presetKey = driverConfig && driverConfig.preset;
  if (!presetKey || !PRESETS[presetKey]) return false;

  const preset = PRESETS[presetKey];
  const body = preset.poolBody(poolUrl, 'wtc', 'x');
  const { ok: poolOk } = await apiRequest(
    ip,
    port,
    'POST',
    preset.poolEndpoint,
    body,
    preset.poolContentType,
    preset.auth,
    10000,
  );
  if (!poolOk) return false;

  if (preset.enableEndpoint) {
    const { ok: enableOk } = await apiRequest(
      ip,
      port,
      'POST',
      preset.enableEndpoint,
      '',
      preset.poolContentType,
      preset.auth,
      5000,
    );
    return enableOk;
  }

  return true;
}

async function disablePool(ip, port, driverConfig) {
  const presetKey = driverConfig && driverConfig.preset;
  if (!presetKey || !PRESETS[presetKey]) return false;

  const preset = PRESETS[presetKey];
  const body = preset.disableBody ? preset.disableBody() : '';
  const { ok } = await apiRequest(
    ip,
    port,
    'POST',
    preset.disableEndpoint,
    body,
    preset.poolContentType,
    preset.auth,
    5000,
  );
  return ok;
}

async function getTelemetry(ip, port, driverConfig) {
  const presetKey = driverConfig && driverConfig.preset;
  if (!presetKey || !PRESETS[presetKey]) return null;

  const preset = PRESETS[presetKey];
  const { ok, text } = await apiRequest(ip, port, 'GET', preset.statusEndpoint, null, null, preset.auth, 5000);
  if (!ok || !text) return null;

  return preset.statusParser(text);
}

async function getHashrate(ip, port, driverConfig) {
  const telemetry = await getTelemetry(ip, port, driverConfig);
  if (!telemetry) return 0;
  return telemetry.hashrateTHs || 0;
}

async function verifyLiveness(ip, port, stratumPort, stratumHandles, driverConfig) {
  const startShares =
    stratumPort && stratumHandles.has(stratumPort) ? stratumHandles.get(stratumPort).getShareCount() : null;
  const startMs = Date.now();

  const telemetry = await getTelemetry(ip, port, driverConfig);
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

function verifyFirmware(_ip, _port, _checkModel, _declaredModel, _driverConfig) {
  return { ok: true, identities: [], compileTimes: [], issues: [] };
}

function parseElphapexStatus(text) {
  const telemetry = {
    tempInlet: null,
    tempOutlet: null,
    tempChip: null,
    fanSpeedRpm: null,
    fanNum: null,
    chainNum: null,
    chipCount: null,
    voltage: null,
    frequency: null,
    hwErrors: null,
    acceptedShares: null,
    rejectedShares: null,
    uptimeSeconds: null,
    minerType: 'Elphapex',
    minerVersion: '',
    poolCount: null,
    devCount: null,
    devDetails: [],
    hashrateTHs: 0,
    signalScore: 0,
    maxSignals: 0,
    signalRatio: 0,
    isRealHardware: false,
  };

  const tempMatch = text.match(/temp(?:_inlet)?[:\s]+(\d+)/i);
  if (tempMatch) telemetry.tempInlet = parseInt(tempMatch[1], 10);
  const fanMatch = text.match(/fan(?:_speed)?[:\s]+(\d+)/i);
  if (fanMatch) telemetry.fanSpeedRpm = parseInt(fanMatch[1], 10);
  const chipMatch = text.match(/chip(?:_count)?[:\s]+(\d+)/i);
  if (chipMatch) telemetry.chipCount = parseInt(chipMatch[1], 10);
  const hrMatch = text.match(/hash(?:rate)?[:\s]+(\d+(?:\.\d+)?)\s*(?:th|gh)?/i);
  if (hrMatch) {
    const val = parseFloat(hrMatch[1]);
    const unit = (hrMatch[0].match(/(th|gh)/i) || [])[1];
    telemetry.hashrateTHs = unit && unit.toLowerCase() === 'gh' ? val / 1000 : val;
  }
  const versionMatch = text.match(/version[:\s]+([^\s<]+)/i);
  if (versionMatch) telemetry.minerVersion = versionMatch[1].trim();

  return telemetry;
}

function parseVolcminerStatus(text) {
  const telemetry = {
    tempInlet: null,
    tempOutlet: null,
    tempChip: null,
    fanSpeedRpm: null,
    fanNum: null,
    chainNum: null,
    chipCount: null,
    voltage: null,
    frequency: null,
    hwErrors: null,
    acceptedShares: null,
    rejectedShares: null,
    uptimeSeconds: null,
    minerType: 'Volcminer',
    minerVersion: '',
    poolCount: null,
    devCount: null,
    devDetails: [],
    hashrateTHs: 0,
    signalScore: 0,
    maxSignals: 0,
    signalRatio: 0,
    isRealHardware: false,
  };

  const tempMatch = text.match(/temp[:\s]+(\d+)/i);
  if (tempMatch) telemetry.tempInlet = parseInt(tempMatch[1], 10);
  const fanMatch = text.match(/fan[:\s]+(\d+)/i);
  if (fanMatch) telemetry.fanSpeedRpm = parseInt(fanMatch[1], 10);
  const hrMatch = text.match(/hash(?:rate)?[:\s]+(\d+(?:\.\d+)?)\s*(?:th|gh)?/i);
  if (hrMatch) {
    const val = parseFloat(hrMatch[1]);
    const unit = (hrMatch[0].match(/(th|gh)/i) || [])[1];
    telemetry.hashrateTHs = unit && unit.toLowerCase() === 'gh' ? val / 1000 : val;
  }

  return telemetry;
}

function parseJasminerStatus(text) {
  const telemetry = {
    tempInlet: null,
    tempOutlet: null,
    tempChip: null,
    fanSpeedRpm: null,
    fanNum: null,
    chainNum: null,
    chipCount: null,
    voltage: null,
    frequency: null,
    hwErrors: null,
    acceptedShares: null,
    rejectedShares: null,
    uptimeSeconds: null,
    minerType: 'Jasminer',
    minerVersion: '',
    poolCount: null,
    devCount: null,
    devDetails: [],
    hashrateTHs: 0,
    signalScore: 0,
    maxSignals: 0,
    signalRatio: 0,
    isRealHardware: false,
  };

  const tempMatch = text.match(/temperature[:\s]+(\d+)/i);
  if (tempMatch) telemetry.tempInlet = parseInt(tempMatch[1], 10);
  const fanMatch = text.match(/fan[:\s]+(\d+)/i);
  if (fanMatch) telemetry.fanSpeedRpm = parseInt(fanMatch[1], 10);
  const hrMatch = text.match(/hash(?:rate)?[:\s]+(\d+(?:\.\d+)?)\s*(?:th|gh)?/i);
  if (hrMatch) {
    const val = parseFloat(hrMatch[1]);
    const unit = (hrMatch[0].match(/(th|gh)/i) || [])[1];
    telemetry.hashrateTHs = unit && unit.toLowerCase() === 'gh' ? val / 1000 : val;
  }

  return telemetry;
}

module.exports = {
  name,
  probePorts,
  PRESETS,
  detect,
  getTelemetry,
  getHashrate,
  configurePool,
  disablePool,
  verifyLiveness,
  verifyFirmware,
};
