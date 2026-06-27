const fs = require('fs');
const path = require('path');
const os = require('os');

function parseNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseSeedNodes(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/[;,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function parseEnum(value, allowed, fallback) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  if (allowed.includes(normalized)) return normalized;
  return fallback;
}

// Per-machine local override file — lives in user data dir, never shipped.
// Takes priority over the bundled config so per-install values (e.g. RPC
// credentials) override the factory defaults without touching the ASAR.
function getLocalOverrideConfigPath() {
  return path.join(os.homedir(), 'WattcoinMinerUserData', 'wattcoin-local-config.json');
}

function getConfigCandidates() {
  const candidates = [];
  if (process.env.WATTCOIN_RUNTIME_CONFIG) {
    candidates.push(process.env.WATTCOIN_RUNTIME_CONFIG);
  }
  // Local override is checked first so per-machine settings win.
  candidates.push(getLocalOverrideConfigPath());
  candidates.push(
    path.join(process.cwd(), 'wattcoin-beta-config.json'),
    path.join(__dirname, 'wattcoin-beta-config.json'),
  );
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'wattcoin-beta-config.json'));
  }
  return Array.from(new Set(candidates));
}

function readConfigFile() {
  // Merge all config candidates from lowest to highest priority so that the
  // local-override file (wattcoin-local-config.json) only overrides the fields
  // it explicitly sets — it does not shadow settings like ledgerPeers or
  // autoLaunchNode that exist only in the shipped wattcoin-beta-config.json.
  const candidates = getConfigCandidates().slice().reverse(); // lowest priority first
  let merged = {};
  for (const candidate of candidates) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.assign(merged, parsed); // higher-priority files override lower ones
      }
    } catch (_) {
      // Ignore malformed config candidates and continue searching.
    }
  }
  return merged;
}

function getRuntimeConfig() {
  const fileConfig = readConfigFile();
  const antimalwareSafeMode = parseBoolean(
    process.env.WATTCOIN_ANTIMALWARE_SAFE_MODE,
    parseBoolean(fileConfig.antimalwareSafeMode, true),
  );
  // Security lock: the writable config files must never be able to move a client
  // off mainnet. This avoids stale local overrides (for example old testnet4
  // values) silently disabling seed-peer sync on upgraded clients.
  // Non-mainnet modes remain available via explicit environment override only.
  const envNetwork = String(process.env.WATTCOIN_NETWORK || '').trim();
  const network = envNetwork || 'wtc-mainnet';
  const autoLaunchNode = parseBoolean(
    process.env.WATTCOIN_AUTO_LAUNCH_NODE,
    parseBoolean(fileConfig.autoLaunchNode, !antimalwareSafeMode),
  );
  const autoLaunchNodeDelayMs = Math.max(
    0,
    parseNumber(process.env.WATTCOIN_AUTO_LAUNCH_NODE_DELAY_MS, parseNumber(fileConfig.autoLaunchNodeDelayMs, 0)),
  );
  const nodeStartupCliWarmupMs = Math.max(
    0,
    parseNumber(process.env.WATTCOIN_NODE_STARTUP_CLI_WARMUP_MS, parseNumber(fileConfig.nodeStartupCliWarmupMs, 25000)),
  );
  // The node starts offline (-connect=0 -dnsseed=0 -listen=0) when antimalwareSafeMode
  // is true.  This prevents AV burst-connection triggers at process launch — the node
  // process initialises quietly, then the app calls setnetworkactive=true via RPC after
  // the warmup period and injects peers one-at-a-time via the drip queue.
  const nodeStartupOfflineMode = parseBoolean(
    process.env.WATTCOIN_NODE_STARTUP_OFFLINE_MODE,
    parseBoolean(fileConfig.nodeStartupOfflineMode, antimalwareSafeMode),
  );
  const enableStartupTraceLogging = parseBoolean(
    process.env.WATTCOIN_ENABLE_STARTUP_TRACE_LOGGING,
    parseBoolean(fileConfig.enableStartupTraceLogging, true),
  );
  const startupTraceWindowMs = Math.max(
    10_000,
    parseNumber(process.env.WATTCOIN_STARTUP_TRACE_WINDOW_MS, parseNumber(fileConfig.startupTraceWindowMs, 180_000)),
  );
  // ── Security-locked fields ────────────────────────────────────────────────
  // These fields are intentionally NOT read from the config file.
  // wattcoin-beta-config.json is outside the ASAR and writable post-install;
  // an attacker who can edit it must NOT be able to:
  //   - redirect the attestation policy feed to a permissive server
  //   - replace the public key so their forged policy passes signature checks
  //   - switch the network to regtest to bypass the real blockchain
  // Overrides are only accepted via environment variables (dev/CI use only).
  // To deploy with a real policy feed, set WATTCOIN_ATTESTATION_POLICY_FEED_URL
  // and WATTCOIN_ATTESTATION_POLICY_FEED_PUBLIC_KEY in the build environment.
  const attestationPolicyFeedUrl = parseString(process.env.WATTCOIN_ATTESTATION_POLICY_FEED_URL, '');
  const attestationPolicyFeedPublicKey = parseString(process.env.WATTCOIN_ATTESTATION_POLICY_FEED_PUBLIC_KEY, '');
  const ledgerNetworkEnabled = parseBoolean(
    process.env.WATTCOIN_LEDGER_NETWORK_ENABLED,
    parseBoolean(fileConfig.ledgerNetworkEnabled, false),
  );
  const ledgerNetworkMode = parseEnum(
    process.env.WATTCOIN_LEDGER_NETWORK_MODE || fileConfig.ledgerNetworkMode,
    ['standalone', 'peer'],
    'standalone',
  );
  const ledgerPeers = parseSeedNodes(process.env.WATTCOIN_LEDGER_PEERS || fileConfig.ledgerPeers || []);
  const ledgerCoordinatorUrl = parseString(
    process.env.WATTCOIN_LEDGER_COORDINATOR_URL,
    parseString(fileConfig.ledgerCoordinatorUrl, ''),
  );
  const ledgerNetworkAuthToken = parseString(
    process.env.WATTCOIN_LEDGER_NETWORK_AUTH_TOKEN,
    parseString(fileConfig.ledgerNetworkAuthToken, ''),
  );
  const ledgerNetworkListenHost = parseString(
    process.env.WATTCOIN_LEDGER_NETWORK_LISTEN_HOST,
    parseString(fileConfig.ledgerNetworkListenHost, '0.0.0.0'),
  );
  const ledgerNetworkListenPort = Math.max(
    1,
    parseNumber(
      process.env.WATTCOIN_LEDGER_NETWORK_LISTEN_PORT,
      parseNumber(fileConfig.ledgerNetworkListenPort, 39310),
    ),
  );
  const ledgerNetworkPublicUrl = parseString(
    process.env.WATTCOIN_LEDGER_NETWORK_PUBLIC_URL,
    parseString(fileConfig.ledgerNetworkPublicUrl, ''),
  );
  const ledgerNetworkTunnelPublicUrl = parseString(
    process.env.WATTCOIN_LEDGER_NETWORK_TUNNEL_PUBLIC_URL,
    parseString(fileConfig.ledgerNetworkTunnelPublicUrl, ''),
  );
  const ledgerNetworkAdvertiseUrls = parseSeedNodes(
    process.env.WATTCOIN_LEDGER_NETWORK_ADVERTISE_URLS || fileConfig.ledgerNetworkAdvertiseUrls || [],
  );
  const ledgerSeedManifestUrls = parseSeedNodes(
    process.env.WATTCOIN_LEDGER_SEED_MANIFEST_URLS || fileConfig.ledgerSeedManifestUrls || [],
  );
  const seedRegistryHeartbeatEnabled = parseBoolean(
    process.env.WATTCOIN_SEED_REGISTRY_HEARTBEAT_ENABLED,
    parseBoolean(fileConfig.seedRegistryHeartbeatEnabled, true),
  );
  const ledgerNetworkRequestTimeoutMs = Math.max(
    1000,
    parseNumber(
      process.env.WATTCOIN_LEDGER_NETWORK_REQUEST_TIMEOUT_MS,
      parseNumber(fileConfig.ledgerNetworkRequestTimeoutMs, 7000),
    ),
  );
  return {
    network,
    antimalwareSafeMode,
    betaMode: parseBoolean(process.env.WATTCOIN_BETA_MODE, parseBoolean(fileConfig.betaMode, false)),
    minerPassword: String(
      process.env.WATTCOIN_MINER_PASSWORD || process.env.WATTCOIN_BETA_PASSWORD || fileConfig.minerPassword || '',
    ),
    // RPC credentials must never ship with a hardcoded fallback.
    // When absent, the main process generates per-install random values and
    // persists them to the local override config outside the packaged app.
    rpcUser: String(process.env.WATTCOIN_RPC_USER || fileConfig.rpcUser || ''),
    rpcPassword: String(process.env.WATTCOIN_RPC_PASSWORD || fileConfig.rpcPassword || ''),
    autoLaunchNode,
    autoLaunchNodeDelayMs,
    nodeStartupCliWarmupMs,
    nodeStartupOfflineMode,
    enableStartupTraceLogging,
    startupTraceWindowMs,
    enableTelemetryProbes: false,
    attestationPolicyFeedUrl,
    attestationPolicyFeedPublicKey,
    ledgerNetworkEnabled,
    ledgerNetworkMode,
    ledgerPeers,
    ledgerCoordinatorUrl,
    ledgerNetworkAuthToken,
    ledgerNetworkListenHost,
    ledgerNetworkListenPort,
    ledgerNetworkPublicUrl,
    ledgerNetworkTunnelPublicUrl,
    ledgerNetworkAdvertiseUrls,
    ledgerSeedManifestUrls,
    seedRegistryHeartbeatEnabled,
    ledgerNetworkRequestTimeoutMs,
  };
}

module.exports = {
  getLocalOverrideConfigPath,
  getRuntimeConfig,
};
