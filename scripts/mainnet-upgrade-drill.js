'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('process');

const AUTOMATED_GATE_SCRIPTS = [
  'test:p2p-adversarial',
  'test:ledger',
  'mainnet:durability:snapshot',
  'mainnet:durability:corruption',
  'mainnet:validate-seeds',
];

function parseArgs(argv) {
  const args = {
    gatesOnly: false,
    yes: false,
    help: false,
    captureEvidence: false,
    nodeATip: '',
    nodeBTip: '',
    nodeAHealth: '',
    nodeBHealth: '',
    authToken: '',
    evidenceDir: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--gates-only') args.gatesOnly = true;
    else if (token === '--yes') args.yes = true;
    else if (token === '--capture-evidence') args.captureEvidence = true;
    else if (token === '--node-a-tip' && argv[i + 1]) args.nodeATip = String(argv[++i]).trim();
    else if (token === '--node-b-tip' && argv[i + 1]) args.nodeBTip = String(argv[++i]).trim();
    else if (token === '--node-a-health' && argv[i + 1]) args.nodeAHealth = String(argv[++i]).trim();
    else if (token === '--node-b-health' && argv[i + 1]) args.nodeBHealth = String(argv[++i]).trim();
    else if (token === '--auth-token' && argv[i + 1]) args.authToken = String(argv[++i]).trim();
    else if (token === '--evidence-dir' && argv[i + 1]) args.evidenceDir = String(argv[++i]).trim();
    else throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printHelp() {
  console.log('Usage: node scripts/mainnet-upgrade-drill.js [options]');
  console.log('');
  console.log('Options:');
  console.log('  --gates-only                Run automated release gates only.');
  console.log('  --capture-evidence          Write drill evidence to a timestamped artifact folder.');
  console.log('  --node-a-tip <url>          Candidate GET /api/v1/chain/tip endpoint for node A.');
  console.log('  --node-b-tip <url>          Candidate GET /api/v1/chain/tip endpoint for node B.');
  console.log('  --node-a-health <url>       GET /api/v1/ops/health endpoint for node A.');
  console.log('  --node-b-health <url>       GET /api/v1/ops/health endpoint for node B.');
  console.log('  --auth-token <token>        Send x-wattcoin-ledger-token on tip/health checks.');
  console.log('  --evidence-dir <path>       Override the artifact output directory.');
  console.log('  --yes                       Auto-confirm manual checkpoints.');
  console.log('  --help, -h                  Show this help.');
}

function getTimestampStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function createEvidenceRecorder(args) {
  const enabled = args.captureEvidence || Boolean(args.evidenceDir);
  if (!enabled) {
    return {
      enabled: false,
      dir: '',
      recordJson() {},
      recordStep() {},
      finalize() {},
    };
  }

  const dir = path.resolve(
    args.evidenceDir || path.join(__dirname, '..', 'artifacts', 'mainnet-upgrade-drill', getTimestampStamp()),
  );
  fs.mkdirSync(dir, { recursive: true });

  const summary = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    args: {
      gatesOnly: args.gatesOnly,
      nodeATip: args.nodeATip,
      nodeBTip: args.nodeBTip,
      nodeAHealth: args.nodeAHealth,
      nodeBHealth: args.nodeBHealth,
      authTokenProvided: Boolean(args.authToken),
    },
    steps: [],
  };

  function flushSummary() {
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  }

  flushSummary();

  return {
    enabled: true,
    dir,
    recordJson(name, payload) {
      fs.writeFileSync(path.join(dir, name), JSON.stringify(payload, null, 2), 'utf8');
    },
    recordStep(step, status, details = {}) {
      summary.steps.push({ ts: new Date().toISOString(), step, status, details });
      flushSummary();
    },
    finalize(ok, details = {}) {
      summary.ok = Boolean(ok);
      summary.finishedAt = new Date().toISOString();
      summary.result = details;
      flushSummary();
    },
  };
}

function runNpmScript(scriptName) {
  const npmCliPath = process.env.npm_execpath;
  let executable;
  let finalArgs;

  if (npmCliPath) {
    executable = process.execPath;
    finalArgs = [npmCliPath, 'run', scriptName];
  } else if (process.platform === 'win32') {
    executable = process.env.ComSpec || 'cmd.exe';
    finalArgs = ['/c', 'npm', 'run', scriptName];
  } else {
    executable = 'npm';
    finalArgs = ['run', scriptName];
  }

  console.log(`[upgrade-drill] Running ${scriptName}`);
  const result = spawnSync(executable, finalArgs, {
    stdio: 'inherit',
    shell: false,
    windowsHide: false,
  });
  if (result.error) {
    throw new Error(`${scriptName} failed: ${result.error.message || String(result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(`${scriptName} exited with code ${result.status}`);
  }
}

function fetchJson(urlText, headers = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch (_) {
      reject(new Error(`Invalid URL: ${urlText}`));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request(parsed, { method: 'GET', timeout: 10000, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch (_) {
          reject(new Error(`Invalid JSON from ${urlText}`));
          return;
        }
        if (res.statusCode >= 400) {
          reject(new Error(`${urlText} returned HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Timeout fetching ${urlText}`)));
    req.on('error', reject);
    req.end();
  });
}

function buildRequestHeaders(args) {
  return args.authToken ? { 'x-wattcoin-ledger-token': args.authToken } : {};
}

async function verifyTipCompatibility(nodeATipUrl, nodeBTipUrl, args, evidence) {
  if (!nodeATipUrl || !nodeBTipUrl) return;
  const headers = buildRequestHeaders(args);
  const [aTip, bTip] = await Promise.all([fetchJson(nodeATipUrl, headers), fetchJson(nodeBTipUrl, headers)]);
  if (!aTip || !aTip.ok) throw new Error(`Node A tip endpoint not healthy: ${nodeATipUrl}`);
  if (!bTip || !bTip.ok) throw new Error(`Node B tip endpoint not healthy: ${nodeBTipUrl}`);

  evidence.recordJson('node-a-tip.json', { url: nodeATipUrl, body: aTip });
  evidence.recordJson('node-b-tip.json', { url: nodeBTipUrl, body: bTip });

  const fields = ['networkId', 'protocolVersion', 'genesisHash'];
  for (const field of fields) {
    if (String(aTip[field] || '') !== String(bTip[field] || '')) {
      throw new Error(`Tip compatibility failed: ${field} mismatch (${aTip[field]} vs ${bTip[field]})`);
    }
  }

  console.log('[upgrade-drill] Tip compatibility OK');
  console.log(` nodeA height=${aTip.height} hash=${aTip.hash}`);
  console.log(` nodeB height=${bTip.height} hash=${bTip.hash}`);
}

async function verifyLagConverged(label, healthUrl, args, evidence, fileName) {
  if (!healthUrl) return;
  const health = await fetchJson(healthUrl, buildRequestHeaders(args));
  const lag = Number(health && health.metrics ? health.metrics.nodeLagBlocks : NaN);
  const status = String(health && health.status ? health.status : 'unknown');
  evidence.recordJson(fileName, { label, url: healthUrl, body: health });
  if (!health || !health.ok) throw new Error(`${label} health endpoint not healthy: ${healthUrl}`);
  if (!Number.isFinite(lag) || lag !== 0) {
    throw new Error(`${label} node lag has not converged to 0 (nodeLagBlocks=${lag})`);
  }
  if (status === 'critical') {
    throw new Error(`${label} reports critical health status`);
  }
  console.log(`[upgrade-drill] ${label} lag converged to 0 (${status})`);
}

async function confirmStep(rl, message, autoYes, evidence) {
  if (autoYes) {
    evidence.recordStep(message, 'auto-confirmed');
    console.log(`[upgrade-drill] Auto-confirmed: ${message}`);
    return;
  }

  const answer = String(await rl.question(`${message} Type "yes" to continue: `))
    .trim()
    .toLowerCase();
  if (answer !== 'yes') {
    evidence.recordStep(message, 'rejected');
    throw new Error(`Operator did not confirm step: ${message}`);
  }
  evidence.recordStep(message, 'confirmed');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const evidence = createEvidenceRecorder(args);
  if (evidence.enabled) {
    console.log(`[upgrade-drill] Evidence directory: ${evidence.dir}`);
  }

  try {
    for (const scriptName of AUTOMATED_GATE_SCRIPTS) {
      runNpmScript(scriptName);
      evidence.recordStep(`gate:${scriptName}`, 'passed');
    }

    if (args.gatesOnly) {
      console.log('[upgrade-drill] Automated gates passed.');
      evidence.finalize(true, { mode: 'gates-only' });
      return;
    }

    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      await confirmStep(
        rl,
        'Stage node A at current release N and node B at candidate release N+1.',
        args.yes,
        evidence,
      );

      if (args.nodeATip && args.nodeBTip) {
        await verifyTipCompatibility(args.nodeATip, args.nodeBTip, args, evidence);
        evidence.recordStep('tip-compatibility-initial', 'passed');
      } else {
        await confirmStep(
          rl,
          'Verify /api/v1/chain/tip metadata matches between node A and node B.',
          args.yes,
          evidence,
        );
      }

      await confirmStep(
        rl,
        'Run normal sync and mining for 30 minutes with the mixed-version pair.',
        args.yes,
        evidence,
      );
      await confirmStep(rl, 'Roll node B back from N+1 to N.', args.yes, evidence);

      if (args.nodeAHealth || args.nodeBHealth) {
        await verifyLagConverged('node A', args.nodeAHealth, args, evidence, 'node-a-health-after-rollback.json');
        await verifyLagConverged('node B', args.nodeBHealth, args, evidence, 'node-b-health-after-rollback.json');
        evidence.recordStep('rollback-health-check', 'passed');
      } else {
        await confirmStep(
          rl,
          'Confirm both nodes rejoin and node lag returns to 0 after rollback.',
          args.yes,
          evidence,
        );
      }

      await confirmStep(rl, 'Re-upgrade node B from N to N+1.', args.yes, evidence);

      if (args.nodeATip && args.nodeBTip) {
        await verifyTipCompatibility(args.nodeATip, args.nodeBTip, args, evidence);
        evidence.recordStep('tip-compatibility-final', 'passed');
      }
      if (args.nodeAHealth || args.nodeBHealth) {
        await verifyLagConverged('node A', args.nodeAHealth, args, evidence, 'node-a-health-final.json');
        await verifyLagConverged('node B', args.nodeBHealth, args, evidence, 'node-b-health-final.json');
        evidence.recordStep('final-health-check', 'passed');
      } else {
        await confirmStep(
          rl,
          'Confirm mixed-version rollout is stable and node lag converges to 0 after re-upgrade.',
          args.yes,
          evidence,
        );
      }
    } finally {
      rl.close();
    }

    console.log('[upgrade-drill] PASS');
    console.log(' passCriteria=no permanent divergence; rollback depth observable; lag converges to 0');
    evidence.finalize(true, { mode: 'full-drill' });
  } catch (err) {
    evidence.finalize(false, { error: err && err.message ? err.message : String(err) });
    throw err;
  }
}

main().catch((err) => {
  console.error('[upgrade-drill] FAIL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
