const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const tls = require('tls');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Client } = require('ssh2');

const DEFAULT_CONFIG_PATH = path.join(__dirname, 'nodes.json');
const DEFAULT_LISTEN_HOST = '0.0.0.0';
const DEFAULT_LISTEN_PORT = 9464;
const DEFAULT_HEALTH_POLL_MS = 30_000;
const DEFAULT_METRICS_POLL_MS = 60_000;
const DEFAULT_ARCHIVE_POLL_MS = 5 * 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_SCRAPE_RETENTION_DAYS = 30;
const DEFAULT_ABUSE_HOT_RETENTION_DAYS = 30;
const DEFAULT_ABUSE_COLD_RETENTION_DAYS = 90;

const state = {
  startedAt: new Date().toISOString(),
  nodes: new Map(),
};

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const args = { validateConfig: false };
  for (let index = 2; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim();
    if (!token) continue;
    if (token === '--validate-config') {
      args.validateConfig = true;
      continue;
    }
    if (token.startsWith('--config=')) {
      args.configPath = token.slice('--config='.length);
      continue;
    }
    if (token === '--config' && argv[index + 1]) {
      args.configPath = String(argv[index + 1]);
      index += 1;
    }
  }
  return args;
}

function sanitizeNodeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
}

function resolvePath(baseDir, value) {
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.join(baseDir, value);
}

function readJsonFile(filePath) {
  return fsp.readFile(filePath, 'utf8').then((raw) => JSON.parse(raw));
}

function getEnvRequired(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parseSshTunnelConfig(rawTunnel) {
  if (!rawTunnel) return null;
  const targetHost = String(rawTunnel.targetHost || '127.0.0.1').trim() || '127.0.0.1';
  const targetPort = Number(rawTunnel.targetPort || 0);
  if (targetPort < 0) {
    throw new Error('SSH tunnel targetPort must be >= 0.');
  }
  return {
    enabled: rawTunnel.enabled !== false,
    targetHost,
    targetPort,
  };
}

function buildNodeRuntimeConfig(baseDir, rawNode) {
  const nodeId = sanitizeNodeId(rawNode.id || rawNode.name);
  if (!nodeId) throw new Error('Each node requires id or name.');
  const opsBaseUrl = String(rawNode.opsBaseUrl || '').replace(/\/$/, '');
  if (!opsBaseUrl) throw new Error(`Node ${nodeId} missing opsBaseUrl.`);
  const token = rawNode.ledgerTokenEnv ? getEnvRequired(String(rawNode.ledgerTokenEnv)) : String(rawNode.ledgerToken || '');
  if (!token) throw new Error(`Node ${nodeId} missing ledger token configuration.`);

  const ssh = rawNode.ssh
    ? {
        host: String(rawNode.ssh.host || ''),
        port: Number(rawNode.ssh.port || 22),
        username: String(rawNode.ssh.username || ''),
        password: rawNode.ssh.passwordEnv ? getEnvRequired(String(rawNode.ssh.passwordEnv)) : undefined,
        privateKeyPath: rawNode.ssh.privateKeyPath ? resolvePath(baseDir, String(rawNode.ssh.privateKeyPath)) : '',
        remoteUserDataDir: String(rawNode.ssh.remoteUserDataDir || ''),
        tunnel: parseSshTunnelConfig(rawNode.ssh.tunnel),
      }
    : null;

  if (ssh && (!ssh.host || !ssh.username || !ssh.remoteUserDataDir || (!ssh.password && !ssh.privateKeyPath))) {
    throw new Error(`Node ${nodeId} SSH config requires host, username, remoteUserDataDir, and password or privateKeyPath.`);
  }

  return {
    id: nodeId,
    name: String(rawNode.name || nodeId),
    opsBaseUrl,
    token,
    ssh,
  };
}

function getTunnelTargetPort(parsedUrl, tunnelConfig) {
  if (tunnelConfig && tunnelConfig.targetPort > 0) return tunnelConfig.targetPort;
  if (parsedUrl.port) return Number(parsedUrl.port);
  return parsedUrl.protocol === 'https:' ? 443 : 80;
}

async function loadConfig(configPath) {
  const resolvedPath = path.resolve(configPath || process.env.WATTCOIN_MONITORING_CONFIG || DEFAULT_CONFIG_PATH);
  const baseDir = path.dirname(resolvedPath);
  const raw = await readJsonFile(resolvedPath);
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map((node) => buildNodeRuntimeConfig(baseDir, node)) : [];
  if (nodes.length === 0) throw new Error('Monitoring config requires at least one node.');

  const dataDir = resolvePath(baseDir, raw.dataDir || './data');
  const incidentsDir = path.join(dataDir, 'incidents');
  const archivesDir = path.join(dataDir, 'archive');
  const coldDir = path.join(dataDir, 'cold');

  return {
    configPath: resolvedPath,
    dataDir,
    incidentsDir,
    archivesDir,
    coldDir,
    listenHost: String(raw.listenHost || DEFAULT_LISTEN_HOST),
    listenPort: Number(raw.listenPort || DEFAULT_LISTEN_PORT),
    pollIntervals: {
      healthMs: Number(raw.pollIntervals && raw.pollIntervals.healthMs) || DEFAULT_HEALTH_POLL_MS,
      metricsMs: Number(raw.pollIntervals && raw.pollIntervals.metricsMs) || DEFAULT_METRICS_POLL_MS,
      archiveMs: Number(raw.pollIntervals && raw.pollIntervals.archiveMs) || DEFAULT_ARCHIVE_POLL_MS,
    },
    requestTimeoutMs: Number(raw.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS),
    retention: {
      scrapeDays: Number(raw.retention && raw.retention.scrapeDays) || DEFAULT_SCRAPE_RETENTION_DAYS,
      abuseHotDays: Number(raw.retention && raw.retention.abuseHotDays) || DEFAULT_ABUSE_HOT_RETENTION_DAYS,
      abuseColdDays: Number(raw.retention && raw.retention.abuseColdDays) || DEFAULT_ABUSE_COLD_RETENTION_DAYS,
    },
    nodes,
  };
}

function ensureNodeState(node) {
  if (!state.nodes.has(node.id)) {
    state.nodes.set(node.id, {
      config: node,
      health: null,
      metrics: null,
      lastHealthAt: 0,
      lastMetricsAt: 0,
      lastArchiveAt: 0,
      lastArchiveOkAt: 0,
      lastError: '',
      lastHttpStatus: 0,
      lastAuthFailureAt: 0,
      up: 0,
      statusCode: 0,
      incidentFingerprint: '',
    });
  }
  return state.nodes.get(node.id);
}

async function appendJsonLine(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function mapStatusCode(status) {
  if (status === 'healthy') return 2;
  if (status === 'degraded') return 1;
  if (status === 'critical') return 0;
  return -1;
}

async function fetchJson(url, token, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'x-wattcoin-ledger-token': token,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_) {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function fetchJsonViaSshTunnel(urlText, token, timeoutMs, sshConfig) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch (_) {
      reject(new Error(`Invalid URL: ${urlText}`));
      return;
    }

    if (!sshConfig || !sshConfig.tunnel || !sshConfig.tunnel.enabled) {
      reject(new Error('SSH tunnel requested without ssh.tunnel.enabled configuration.'));
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const targetPort = getTunnelTargetPort(parsed, sshConfig.tunnel);
    let client;
    let settled = false;

    const settle = (error, payload) => {
      if (settled) return;
      settled = true;
      if (client) client.end();
      if (error) reject(error);
      else resolve(payload);
    };

    try {
      client = await connectSsh(sshConfig);
    } catch (error) {
      settle(error);
      return;
    }

    client.forwardOut('127.0.0.1', 0, sshConfig.tunnel.targetHost, targetPort, (forwardError, stream) => {
      if (forwardError) {
        settle(forwardError);
        return;
      }

      const requestOptions = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        method: 'GET',
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        headers: {
          'x-wattcoin-ledger-token': token,
        },
        createConnection: (_options, callback) => {
          const socket = parsed.protocol === 'https:'
            ? tls.connect({ socket: stream, servername: parsed.hostname })
            : stream;
          if (typeof callback === 'function') callback(null, socket);
          return socket;
        },
      };

      const req = transport.request(requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try {
            body = text ? JSON.parse(text) : null;
          } catch (_) {
            body = null;
          }
          settle(null, {
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: Number(res.statusCode || 0),
            body,
            text,
          });
        });
      });

      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout fetching ${urlText} via SSH tunnel`)));
      req.on('error', (error) => settle(error));
      req.end();
    });
  });
}

function fetchNodeJson(config, node, suffix) {
  const url = `${node.opsBaseUrl}${suffix}`;
  if (node.ssh && node.ssh.tunnel && node.ssh.tunnel.enabled) {
    return fetchJsonViaSshTunnel(url, node.token, config.requestTimeoutMs, node.ssh);
  }
  return fetchJson(url, node.token, config.requestTimeoutMs);
}

async function recordIncident(config, nodeState, type, payload) {
  const fingerprint = `${type}:${JSON.stringify(payload)}`;
  if (nodeState.incidentFingerprint === fingerprint) return;
  nodeState.incidentFingerprint = fingerprint;
  await appendJsonLine(path.join(config.incidentsDir, 'incident-timeline.jsonl'), {
    ts: nowIso(),
    nodeId: nodeState.config.id,
    nodeName: nodeState.config.name,
    type,
    ...payload,
  });
}

async function pollHealth(config, node) {
  const nodeState = ensureNodeState(node);
  try {
    const response = await fetchNodeJson(config, node, '/api/v1/ops/health');
    nodeState.lastHttpStatus = response.status;
    if (!response.ok || !response.body || response.body.ok !== true) {
      nodeState.up = 0;
      nodeState.lastError = response.text || `HTTP ${response.status}`;
      if (response.status === 401) nodeState.lastAuthFailureAt = Date.now();
      await recordIncident(config, nodeState, 'health-poll-failed', {
        severity: response.status === 401 ? 'critical' : 'warn',
        httpStatus: response.status,
        message: nodeState.lastError.slice(0, 400),
      });
      return;
    }
    nodeState.health = response.body;
    nodeState.lastHealthAt = Date.now();
    nodeState.up = 1;
    nodeState.statusCode = mapStatusCode(response.body.status);
    nodeState.lastError = '';
  } catch (error) {
    nodeState.up = 0;
    nodeState.lastError = String(error && error.message ? error.message : error);
    await recordIncident(config, nodeState, 'health-poll-exception', {
      severity: 'warn',
      message: nodeState.lastError.slice(0, 400),
    });
  }
}

async function archiveHttpSnapshot(config, node, nodeState) {
  if (!nodeState.metrics || !nodeState.metrics.snapshot) return;
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const filePath = path.join(config.archivesDir, node.id, 'ops-metrics', `${stamp}.json`);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(nodeState.metrics.snapshot, null, 2), 'utf8');
}

function connectSsh(sshConfig) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const connectOptions = {
      host: sshConfig.host,
      port: sshConfig.port,
      username: sshConfig.username,
      password: sshConfig.password,
      readyTimeout: 15_000,
    };

    if (sshConfig.privateKeyPath) {
      connectOptions.privateKey = fs.readFileSync(sshConfig.privateKeyPath);
    }

    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect(connectOptions);
  });
}

function sftpReadFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = sftp.createReadStream(remotePath);
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function archiveRemoteFiles(config, node, nodeState) {
  if (!node.ssh) return;
  const client = await connectSsh(node.ssh);
  try {
    const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => (error ? reject(error) : resolve(value))));
    const stamp = new Date().toISOString().replace(/[.:]/g, '-');
    const remoteOpsPath = path.posix.join(node.ssh.remoteUserDataDir.replace(/\\/g, '/'), 'ops-metrics.json');
    const remoteAbusePath = path.posix.join(node.ssh.remoteUserDataDir.replace(/\\/g, '/'), 'abuse-events.jsonl');
    const opsBuffer = await sftpReadFile(sftp, remoteOpsPath);
    const abuseBuffer = await sftpReadFile(sftp, remoteAbusePath);

    const opsArchivePath = path.join(config.archivesDir, node.id, 'ops-metrics-remote', `${stamp}.json`);
    const abuseArchivePath = path.join(config.archivesDir, node.id, 'abuse-events', `${stamp}.jsonl`);
    await fsp.mkdir(path.dirname(opsArchivePath), { recursive: true });
    await fsp.mkdir(path.dirname(abuseArchivePath), { recursive: true });
    await fsp.writeFile(opsArchivePath, opsBuffer);
    await fsp.writeFile(abuseArchivePath, abuseBuffer);
    nodeState.lastArchiveOkAt = Date.now();
  } finally {
    client.end();
  }
}

async function pollMetrics(config, node) {
  const nodeState = ensureNodeState(node);
  try {
    const response = await fetchNodeJson(config, node, '/api/v1/ops/metrics');
    nodeState.lastHttpStatus = response.status;
    if (!response.ok || !response.body || response.body.ok !== true) {
      nodeState.up = 0;
      nodeState.lastError = response.text || `HTTP ${response.status}`;
      if (response.status === 401) nodeState.lastAuthFailureAt = Date.now();
      await recordIncident(config, nodeState, 'metrics-poll-failed', {
        severity: response.status === 401 ? 'critical' : 'warn',
        httpStatus: response.status,
        message: nodeState.lastError.slice(0, 400),
      });
      return;
    }
    nodeState.metrics = response.body;
    nodeState.lastMetricsAt = Date.now();
    nodeState.up = 1;
    nodeState.lastError = '';

    await archiveHttpSnapshot(config, node, nodeState);

    const snapshot = response.body.snapshot || {};
    const peerTotal = Number(snapshot.peers && snapshot.peers.total) || 0;
    const segments = Number(snapshot.peers && snapshot.peers.uniqueNetworkSegments) || 0;
    const forkRatePerHour = Number(snapshot.chain && snapshot.chain.forkRatePerHour) || 0;
    const rollbackMedianDepth = Number(snapshot.chain && snapshot.chain.rollbackMedianDepth) || 0;
    const mempoolPressure = Number(snapshot.mempool && snapshot.mempool.pressure) || 0;
    const latestBlockAgeMs = Number(snapshot.chain && snapshot.chain.latestBlockAgeMs) || 0;
    const lag = Number(snapshot.chain && snapshot.chain.nodeLagBlocks) || 0;

    if (latestBlockAgeMs >= 20 * 60_000) {
      await recordIncident(config, nodeState, 'chain-stall', {
        severity: 'critical',
        latestBlockAgeMs,
      });
    }
    if (peerTotal >= 3 && segments < 3) {
      await recordIncident(config, nodeState, 'peer-diversity-low', {
        severity: 'warn',
        peerTotal,
        uniqueNetworkSegments: segments,
      });
    }
    if (mempoolPressure >= 0.85) {
      await recordIncident(config, nodeState, 'mempool-pressure-high', {
        severity: 'warn',
        mempoolPressure,
      });
    }
    if (rollbackMedianDepth >= 3) {
      await recordIncident(config, nodeState, 'rollback-depth-high', {
        severity: 'warn',
        rollbackMedianDepth,
      });
    }
    if (forkRatePerHour > 3) {
      await recordIncident(config, nodeState, 'fork-pressure-high', {
        severity: 'critical',
        forkRatePerHour,
      });
    }
    if (lag > 0) {
      await recordIncident(config, nodeState, 'node-lag-detected', {
        severity: 'warn',
        nodeLagBlocks: lag,
      });
    }
  } catch (error) {
    nodeState.up = 0;
    nodeState.lastError = String(error && error.message ? error.message : error);
    await recordIncident(config, nodeState, 'metrics-poll-exception', {
      severity: 'warn',
      message: nodeState.lastError.slice(0, 400),
    });
  }
}

async function archiveNode(config, node) {
  const nodeState = ensureNodeState(node);
  try {
    await archiveRemoteFiles(config, node, nodeState);
    nodeState.lastArchiveAt = Date.now();
  } catch (error) {
    await recordIncident(config, nodeState, 'archive-failed', {
      severity: 'warn',
      message: String(error && error.message ? error.message : error).slice(0, 400),
    });
  }
}

function metricLine(name, help, type, rows) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const row of rows) lines.push(row);
  return lines.join('\n');
}

function labelsForNode(node) {
  return `node_id="${node.id}",node_name="${node.name.replace(/"/g, '\\"')}"`;
}

function numeric(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function renderMetrics() {
  const nowSeconds = Date.now() / 1000;
  const metricBlocks = [];
  const rows = {
    up: [],
    healthStatus: [],
    scrapeAge: [],
    authFailures: [],
    httpStatus: [],
    localHeight: [],
    bestPeerHeight: [],
    nodeLag: [],
    latestBlockAge: [],
    blockIntervalMedian: [],
    forkRate: [],
    rollbackMedian: [],
    peerHealthy: [],
    peerTotal: [],
    peerSegments: [],
    peerConfigured: [],
    peerSeed: [],
    peerDiscovered: [],
    peerDiscoverySource: [],
    bannedUrls: [],
    bannedIdentities: [],
    mempoolPressure: [],
    mempoolSize: [],
    incidentFreshness: [],
    archiveAge: [],
  };

  for (const nodeState of state.nodes.values()) {
    const node = nodeState.config;
    const labels = labelsForNode(node);
    const snapshot = nodeState.metrics && nodeState.metrics.snapshot ? nodeState.metrics.snapshot : null;
    rows.up.push(`wattcoin_node_up{${labels}} ${numeric(nodeState.up)}`);
    rows.healthStatus.push(`wattcoin_node_health_status_code{${labels}} ${numeric(nodeState.statusCode, -1)}`);
    rows.scrapeAge.push(`wattcoin_node_scrape_age_seconds{${labels},source="metrics"} ${nodeState.lastMetricsAt ? numeric(nowSeconds - (nodeState.lastMetricsAt / 1000)) : -1}`);
    rows.scrapeAge.push(`wattcoin_node_scrape_age_seconds{${labels},source="health"} ${nodeState.lastHealthAt ? numeric(nowSeconds - (nodeState.lastHealthAt / 1000)) : -1}`);
    rows.authFailures.push(`wattcoin_node_last_auth_failure_timestamp_seconds{${labels}} ${nodeState.lastAuthFailureAt ? numeric(nodeState.lastAuthFailureAt / 1000) : 0}`);
    rows.httpStatus.push(`wattcoin_node_last_http_status{${labels}} ${numeric(nodeState.lastHttpStatus)}`);
    rows.archiveAge.push(`wattcoin_node_archive_age_seconds{${labels}} ${nodeState.lastArchiveOkAt ? numeric(nowSeconds - (nodeState.lastArchiveOkAt / 1000)) : -1}`);

    if (!snapshot) continue;
    rows.localHeight.push(`wattcoin_chain_local_height{${labels}} ${numeric(snapshot.chain && snapshot.chain.localHeight, -1)}`);
    rows.bestPeerHeight.push(`wattcoin_chain_best_peer_height{${labels}} ${numeric(snapshot.chain && snapshot.chain.bestPeerHeight, -1)}`);
    rows.nodeLag.push(`wattcoin_chain_node_lag_blocks{${labels}} ${numeric(snapshot.chain && snapshot.chain.nodeLagBlocks)}`);
    rows.latestBlockAge.push(`wattcoin_chain_latest_block_age_seconds{${labels}} ${numeric(snapshot.chain && snapshot.chain.latestBlockAgeMs) / 1000}`);
    rows.blockIntervalMedian.push(`wattcoin_chain_block_interval_median_seconds{${labels}} ${numeric(snapshot.chain && snapshot.chain.blockIntervalMedianSec)}`);
    rows.forkRate.push(`wattcoin_chain_fork_rate_per_hour{${labels}} ${numeric(snapshot.chain && snapshot.chain.forkRatePerHour)}`);
    rows.rollbackMedian.push(`wattcoin_chain_rollback_median_depth{${labels}} ${numeric(snapshot.chain && snapshot.chain.rollbackMedianDepth)}`);
    rows.peerHealthy.push(`wattcoin_peers_healthy{${labels}} ${numeric(snapshot.peers && snapshot.peers.healthy)}`);
    rows.peerTotal.push(`wattcoin_peers_total{${labels}} ${numeric(snapshot.peers && snapshot.peers.total)}`);
    rows.peerSegments.push(`wattcoin_peers_unique_segments{${labels}} ${numeric(snapshot.peers && snapshot.peers.uniqueNetworkSegments)}`);
    rows.peerConfigured.push(`wattcoin_peers_configured{${labels}} ${numeric(snapshot.peers && snapshot.peers.discovery && snapshot.peers.discovery.configuredPeers)}`);
    rows.peerSeed.push(`wattcoin_peers_seed{${labels}} ${numeric(snapshot.peers && snapshot.peers.discovery && snapshot.peers.discovery.seedPeers)}`);
    rows.peerDiscovered.push(`wattcoin_peers_discovered{${labels}} ${numeric(snapshot.peers && snapshot.peers.discovery && snapshot.peers.discovery.discoveredPeers)}`);
    const discoveredBySource = snapshot.peers && snapshot.peers.discovery && snapshot.peers.discovery.discoveredBySource
      ? snapshot.peers.discovery.discoveredBySource
      : {};
    for (const [source, count] of Object.entries(discoveredBySource)) {
      const sourceLabel = String(source || 'unknown').replace(/"/g, '\\"');
      rows.peerDiscoverySource.push(`wattcoin_peers_discovered_by_source{${labels},source="${sourceLabel}"} ${numeric(count)}`);
    }
    rows.bannedUrls.push(`wattcoin_peers_banned_urls{${labels}} ${numeric(snapshot.peers && snapshot.peers.bannedUrls)}`);
    rows.bannedIdentities.push(`wattcoin_peers_banned_identities{${labels}} ${numeric(snapshot.peers && snapshot.peers.bannedIdentities)}`);
    rows.mempoolPressure.push(`wattcoin_mempool_pressure{${labels}} ${numeric(snapshot.mempool && snapshot.mempool.pressure)}`);
    rows.mempoolSize.push(`wattcoin_mempool_size{${labels}} ${numeric(snapshot.mempool && snapshot.mempool.size)}`);
    rows.incidentFreshness.push(`wattcoin_snapshot_timestamp_seconds{${labels}} ${Date.parse(snapshot.timestamp || '') ? Date.parse(snapshot.timestamp) / 1000 : 0}`);
  }

  metricBlocks.push(metricLine('wattcoin_node_up', 'Whether the Wattcoin node endpoints are currently reachable.', 'gauge', rows.up));
  metricBlocks.push(metricLine('wattcoin_node_health_status_code', 'Node health status as numeric code: healthy=2, degraded=1, critical=0, unknown=-1.', 'gauge', rows.healthStatus));
  metricBlocks.push(metricLine('wattcoin_node_scrape_age_seconds', 'Age of the last successful endpoint scrape.', 'gauge', rows.scrapeAge));
  metricBlocks.push(metricLine('wattcoin_node_last_auth_failure_timestamp_seconds', 'Unix timestamp of the last 401 response from a node endpoint.', 'gauge', rows.authFailures));
  metricBlocks.push(metricLine('wattcoin_node_last_http_status', 'Last observed HTTP status from any polled endpoint.', 'gauge', rows.httpStatus));
  metricBlocks.push(metricLine('wattcoin_node_archive_age_seconds', 'Age of the most recent successful remote file archive.', 'gauge', rows.archiveAge));
  metricBlocks.push(metricLine('wattcoin_chain_local_height', 'Current local block height.', 'gauge', rows.localHeight));
  metricBlocks.push(metricLine('wattcoin_chain_best_peer_height', 'Best observed peer block height.', 'gauge', rows.bestPeerHeight));
  metricBlocks.push(metricLine('wattcoin_chain_node_lag_blocks', 'Current local lag behind the best peer.', 'gauge', rows.nodeLag));
  metricBlocks.push(metricLine('wattcoin_chain_latest_block_age_seconds', 'Age of the latest local block.', 'gauge', rows.latestBlockAge));
  metricBlocks.push(metricLine('wattcoin_chain_block_interval_median_seconds', 'Median observed block interval over the recent window.', 'gauge', rows.blockIntervalMedian));
  metricBlocks.push(metricLine('wattcoin_chain_fork_rate_per_hour', 'Fork mismatch rate over the trailing hour.', 'gauge', rows.forkRate));
  metricBlocks.push(metricLine('wattcoin_chain_rollback_median_depth', 'Median rollback depth over the recent window.', 'gauge', rows.rollbackMedian));
  metricBlocks.push(metricLine('wattcoin_peers_healthy', 'Healthy peers reachable from the node.', 'gauge', rows.peerHealthy));
  metricBlocks.push(metricLine('wattcoin_peers_total', 'Configured active peers.', 'gauge', rows.peerTotal));
  metricBlocks.push(metricLine('wattcoin_peers_unique_segments', 'Unique peer network segments visible to the node.', 'gauge', rows.peerSegments));
  metricBlocks.push(metricLine('wattcoin_peers_configured', 'Configured peers loaded from runtime config.', 'gauge', rows.peerConfigured));
  metricBlocks.push(metricLine('wattcoin_peers_seed', 'Bundled seed peers currently shipped with the app.', 'gauge', rows.peerSeed));
  metricBlocks.push(metricLine('wattcoin_peers_discovered', 'Currently cached discovered peers.', 'gauge', rows.peerDiscovered));
  metricBlocks.push(metricLine('wattcoin_peers_discovered_by_source', 'Discovered peer count by learning source.', 'gauge', rows.peerDiscoverySource));
  metricBlocks.push(metricLine('wattcoin_peers_banned_urls', 'Current banned peer URL count.', 'gauge', rows.bannedUrls));
  metricBlocks.push(metricLine('wattcoin_peers_banned_identities', 'Current banned peer identity count.', 'gauge', rows.bannedIdentities));
  metricBlocks.push(metricLine('wattcoin_mempool_pressure', 'Current mempool pressure ratio.', 'gauge', rows.mempoolPressure));
  metricBlocks.push(metricLine('wattcoin_mempool_size', 'Current mempool size.', 'gauge', rows.mempoolSize));
  metricBlocks.push(metricLine('wattcoin_snapshot_timestamp_seconds', 'Timestamp of the last successful ops metrics snapshot.', 'gauge', rows.incidentFreshness));
  return `${metricBlocks.join('\n')}\n`;
}

async function compressFile(sourcePath, destinationPath) {
  await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
  const source = fs.createReadStream(sourcePath);
  const target = fs.createWriteStream(destinationPath);
  const gzip = zlib.createGzip({ level: 9 });
  await pipeline(source, gzip, target);
}

async function walkFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function enforceRetention(config) {
  const now = Date.now();
  const archiveFiles = await walkFiles(config.archivesDir);
  for (const filePath of archiveFiles) {
    const stats = await fsp.stat(filePath);
    const ageDays = (now - stats.mtimeMs) / (24 * 60 * 60_000);
    const relativePath = path.relative(config.archivesDir, filePath);
    const isAbuseLog = relativePath.includes(`${path.sep}abuse-events${path.sep}`) || relativePath.startsWith(`abuse-events${path.sep}`);
    if (isAbuseLog && ageDays > config.retention.abuseColdDays) {
      await fsp.rm(filePath, { force: true });
      continue;
    }
    if (isAbuseLog && ageDays > config.retention.abuseHotDays && !filePath.endsWith('.gz')) {
      const coldPath = path.join(config.coldDir, `${relativePath}.gz`);
      await compressFile(filePath, coldPath);
      await fsp.rm(filePath, { force: true });
      continue;
    }
    if (!isAbuseLog && ageDays > config.retention.scrapeDays) {
      await fsp.rm(filePath, { force: true });
    }
  }
}

function startServer(config) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/metrics') {
      const body = renderMetrics();
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, startedAt: state.startedAt, nodes: state.nodes.size }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not-found' }));
  });
  server.listen(config.listenPort, config.listenHost, () => {
    console.log(`[monitoring] collector listening on ${config.listenHost}:${config.listenPort}`);
  });
}

async function bootstrap(config) {
  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.mkdir(config.incidentsDir, { recursive: true });
  await fsp.mkdir(config.archivesDir, { recursive: true });
  await fsp.mkdir(config.coldDir, { recursive: true });
  for (const node of config.nodes) {
    ensureNodeState(node);
    await pollHealth(config, node);
    await pollMetrics(config, node);
    await archiveNode(config, node);
  }
  await enforceRetention(config);
}

async function startPollingLoops(config) {
  for (const node of config.nodes) {
    setInterval(() => {
      pollHealth(config, node).catch((error) => console.error(`[monitoring] health poll failed for ${node.id}:`, error.message));
    }, config.pollIntervals.healthMs);
    setInterval(() => {
      pollMetrics(config, node).catch((error) => console.error(`[monitoring] metrics poll failed for ${node.id}:`, error.message));
    }, config.pollIntervals.metricsMs);
    setInterval(() => {
      archiveNode(config, node).catch((error) => console.error(`[monitoring] archive failed for ${node.id}:`, error.message));
    }, config.pollIntervals.archiveMs);
  }
  setInterval(() => {
    enforceRetention(config).catch((error) => console.error('[monitoring] retention failed:', error.message));
  }, 60 * 60_000);
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.configPath);
  if (args.validateConfig) {
    console.log(JSON.stringify({ ok: true, configPath: config.configPath, nodes: config.nodes.map((node) => ({ id: node.id, name: node.name, opsBaseUrl: node.opsBaseUrl, hasSsh: Boolean(node.ssh), usesSshTunnel: Boolean(node.ssh && node.ssh.tunnel && node.ssh.tunnel.enabled) })) }, null, 2));
    return;
  }
  await bootstrap(config);
  startServer(config);
  await startPollingLoops(config);
}

main().catch((error) => {
  console.error('[monitoring] fatal:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});