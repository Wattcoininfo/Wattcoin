const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { spawnSync } = require('child_process');
const { assertUnobfuscatedDevSources } = require('./check-dev-source');

const APP_INTEGRITY_FILES = [
  'electron-main.js',
  'preload.js',
  'backend-benchmark.js',
  'hardware-load-controller.js',
  'cpu-load-worker.js',
  'ddr-load-worker.js',
  'probe-attestation.js',
  'wtc-node.js',
  'wtc-consensus.js',
  'wtc-chain.js',
  'wtc-mempool.js',
  'wtc-governance.js',
  'wtc-sale-queue.js',
  'wtc-staking-queue.js',
  'runtime-config.js',
];

function assertReleaseObfuscationDisabled() {
  const forbiddenFlags = [
    'WATTCOIN_RELEASE_OBFUSCATE',
    'WATTCOIN_RELEASE_OBFUSCATE_RENDERER',
  ];
  const enabledFlags = forbiddenFlags.filter((name) => optionalBoolean(name, false));
  if (enabledFlags.length === 0) return;
  throw new Error(
    `Obfuscation is no longer supported. Clear: ${enabledFlags.join(', ')}`,
  );
}

function verifyRendererSaleBundle(root) {
  const assetsDir = path.join(root, 'dist', 'assets');
  if (!fs.existsSync(assetsDir)) {
    throw new Error(`Renderer assets directory not found after build: ${assetsDir}`);
  }

  const bundle = fs
    .readdirSync(assetsDir)
    .filter(name => /\.js$/i.test(name))
    .map(name => fs.readFileSync(path.join(assetsDir, name), 'utf8'))
    .join('\n');

  if (!bundle) {
    throw new Error('Renderer verification failed: no built JS bundle content found.');
  }

  const hasFixedActiveTierGuard = />=\s*[A-Za-z_$][\w$]*\s*\?\s*-1\s*:/.test(bundle);
  const hasFixedPerTierSoldMath = /Math\.min\(\s*[A-Za-z_$][\w$]*\s*,\s*Math\.max\(\s*0\s*,\s*[A-Za-z_$][\w$]*\s*-\s*[A-Za-z_$][\w$]*\.start\s*\)\s*\)/.test(bundle);

  if (!hasFixedActiveTierGuard || !hasFixedPerTierSoldMath) {
    throw new Error(
      'Renderer verification failed: built sale UI bundle does not contain the fixed tier math. ' +
      'Refusing to package a release with stale wallet sale rendering.'
    );
  }

  console.log('[release-build] Renderer sale bundle verification passed.');
}

function assertMainProcessRuntimeFilesPackaged(root) {
  const entryPath = path.join(root, 'electron-main.js');
  const builderConfigPath = path.join(root, 'electron-builder.config.js');
  const source = fs.readFileSync(entryPath, 'utf8');
  const builderConfig = require(builderConfigPath);
  const allowlist = new Set(
    (Array.isArray(builderConfig && builderConfig.files) ? builderConfig.files : [])
      .filter((entry) => typeof entry === 'string')
      .map((entry) => entry.replace(/\\/g, '/'))
  );
  const runtimeRequires = new Set();
  const requirePattern = /require\('\.\/([^']+)'\)/g;
  let match;
  while ((match = requirePattern.exec(source))) {
    const target = String(match[1] || '').trim();
    if (!target || target === 'package.json' || target === 'peer-privacy-dev') continue;
    runtimeRequires.add(target.includes('.') ? target : `${target}.js`);
  }

  const missing = [...runtimeRequires]
    .filter((entry) => !allowlist.has(entry))
    .sort();

  if (missing.length > 0) {
    throw new Error(
      'Packaging verification failed: electron-builder.config.js is missing runtime file(s): ' +
      missing.join(', ')
    );
  }

  console.log(`[release-build] Packaged runtime file check passed (${runtimeRequires.size} main-process dependency files).`);
}

function applyReleaseHardening(root) {
  const backups = new Map();
  const enableHardening = optionalBoolean('WATTCOIN_RELEASE_HARDENING', true);
  if (!enableHardening) {
    console.log('[release-build] Release hardening disabled via WATTCOIN_RELEASE_HARDENING=0.');
    return backups;
  }
  assertReleaseObfuscationDisabled();

  // Generate app JS integrity manifest (verified at runtime in packaged app).
  const manifest = {};
  for (const relPath of APP_INTEGRITY_FILES) {
    const absPath = path.join(root, relPath);
    if (!fs.existsSync(absPath)) continue;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    manifest[relPath.replace(/\\/g, '/')] = hash;
  }
  const manifestPath = path.join(root, 'app-integrity-manifest.json');
  const previousManifest = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, 'utf8')
    : null;
  backups.set(manifestPath, previousManifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[release-build] app-integrity-manifest.json generated (${Object.keys(manifest).length} files).`);

  return backups;
}

function restoreHardeningBackups(backups) {
  for (const [absPath, original] of backups.entries()) {
    try {
      if (original === null) {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } else {
        fs.writeFileSync(absPath, original, 'utf8');
      }
    } catch (e) {
      console.warn(`[release-build] Failed to restore ${absPath}: ${e && e.message ? e.message : e}`);
    }
  }
}

function optionalString(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function optionalBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function hasWindowsSigningConfiguration() {
  return Boolean(
    optionalString('CSC_LINK') ||
    optionalString('WIN_CSC_LINK') ||
    optionalString('WATTCOIN_WINDOWS_CERT_FILE') ||
    optionalString('WATTCOIN_WINDOWS_CERT_SUBJECT_NAME')
  );
}

function isWindowsSigningOnHold() {
  return optionalBoolean('WATTCOIN_WINDOWS_SIGNING_ON_HOLD', true);
}

function applyWindowsSigningHoldIfNeeded() {
  if (process.platform !== 'win32') return false;
  if (!isWindowsSigningOnHold()) return false;
  // During signing hold, force signing controls off even if stale env vars exist.
  process.env.WATTCOIN_ENABLE_WINDOWS_SIGNING = '0';
  process.env.WATTCOIN_REQUIRE_WINDOWS_SIGNING = '0';
  process.env.CSC_LINK = '';
  process.env.WIN_CSC_LINK = '';
  return true;
}

function logSigningMode() {
  if (process.platform !== 'win32') return;

  if (applyWindowsSigningHoldIfNeeded()) {
    console.log('[release-build] Windows signing is ON HOLD (WATTCOIN_WINDOWS_SIGNING_ON_HOLD=1).');
    return;
  }

  const required = optionalBoolean('WATTCOIN_REQUIRE_WINDOWS_SIGNING', false);
  const configured = hasWindowsSigningConfiguration();
  const mode = configured ? 'configured' : 'not configured';
  console.log(`[release-build] Windows signing ${mode}.`);

  if (required && !configured) {
    throw new Error(
      'WATTCOIN_REQUIRE_WINDOWS_SIGNING is enabled, but no Windows signing certificate configuration was found.'
    );
  }
}

function bumpPatchVersion(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

function runNpmExec(args) {
  const npmCliPath = process.env.npm_execpath;
  let executable, finalArgs, useShell;

  if (npmCliPath) {
    // Invoked via `npm run` — use the same node + npm script path (no shell needed).
    executable = process.execPath;
    finalArgs  = [npmCliPath, ...args];
    useShell   = false;
  } else if (process.platform === 'win32') {
    // Direct `node scripts/release-build.js` on Windows — invoke via cmd.exe /c
    // so .cmd extensions are resolved without needing shell:true with concatenated args.
    executable = process.env.ComSpec || 'cmd.exe';
    finalArgs  = ['/c', 'npm', ...args];
    useShell   = false;
  } else {
    executable = 'npm';
    finalArgs  = args;
    useShell   = false;
  }

  const res = spawnSync(executable, finalArgs, {
    stdio: 'inherit',
    shell: useShell,
    windowsHide: false,
  });
  if (res.error) {
    throw new Error(`npm exec spawn error: ${res.error.message || String(res.error)}`);
  }
  if (res.status !== 0) {
    throw new Error(`npm exec failed with exit code ${res.status}`);
  }
}

function runCommandCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: false,
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message || String(result.error)}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}${stderr ? `: ${stderr}` : ''}`);
  }
  return String(result.stdout || '');
}

function tryRunCommandCapture(command, args, options = {}) {
  try {
    return runCommandCapture(command, args, options).trim();
  } catch (_) {
    return '';
  }
}

function snapshotFileContents(filePaths = []) {
  const backups = new Map();
  for (const filePath of filePaths) {
    if (!filePath || backups.has(filePath)) continue;
    backups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);
  }
  return backups;
}

function restoreFileContents(backups = new Map()) {
  for (const [filePath, original] of backups.entries()) {
    try {
      if (original === null) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, original, 'utf8');
      }
    } catch (e) {
      console.warn(`[release-build] Failed to restore ${filePath}: ${e && e.message ? e.message : e}`);
    }
  }
}

function getVersionArtifactPaths(root, version) {
  const releasesDir = path.join(root, 'Releases');
  const installerName = `Wattcoin Miner Setup ${version}.exe`;
  return [
    path.join(releasesDir, installerName),
    path.join(releasesDir, `${installerName}.blockmap`),
    path.join(releasesDir, `Wattcoin Miner Setup ${version}.__uninstaller.exe`),
    path.join(releasesDir, `wattcoin-miner-${version}-x64.nsis.7z`),
  ];
}

function removeExistingVersionArtifacts(root, version) {
  for (const filePath of getVersionArtifactPaths(root, version)) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (e) {
      throw new Error(`Failed to remove stale release artifact ${filePath}: ${e && e.message ? e.message : e}`);
    }
  }
}

function findWorkspaceElectronProcesses(root) {
  if (process.platform !== 'win32') return [];
  const normalizedRoot = String(root || '').replace(/\\/g, '\\\\').replace(/'/g, "''");
  const script = [
    `$root = '${normalizedRoot}'`,
    "$matches = Get-CimInstance Win32_Process -Filter \"name = 'electron.exe'\" | Where-Object {",
    "  $_.CommandLine -and ($_.CommandLine -like \"*$root*\" -or $_.CommandLine -match 'electron-main\\.js')",
    '} | Select-Object ProcessId, CommandLine',
    "if (-not $matches) { '[]' } else { $matches | ConvertTo-Json -Compress }",
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return [];
  const raw = String(result.stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (_) {
    return [];
  }
}

function assertWorkspaceElectronProcessesStopped(root) {
  const processes = findWorkspaceElectronProcesses(root);
  if (processes.length === 0) return;
  const summary = processes
    .map((proc) => `${proc.ProcessId}: ${String(proc.CommandLine || '').trim()}`)
    .join(' | ');
  throw new Error(
    `Close the running Wattcoin Electron app before release build. Locked process(es): ${summary}`
  );
}

function getBuildLogPaths(root, version) {
  const releasesDir = path.join(root, 'Releases');
  const buildChangesDir = path.join(releasesDir, 'build-changes');
  return {
    releasesDir,
    buildChangesDir,
    historyPath: path.join(releasesDir, 'build-history.json'),
    versionLogPath: path.join(buildChangesDir, `build-changes-${version}.md`),
  };
}

function collectBuildChangeLog(root, { mode, previousVersion, nextVersion, deployOnly }) {
  const timestamp = new Date().toISOString();
  const gitHead = tryRunCommandCapture('git', ['rev-parse', 'HEAD'], { cwd: root });
  const gitBranch = tryRunCommandCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const gitStatusOutput = tryRunCommandCapture('git', ['status', '--short'], { cwd: root });
  const gitRecentCommitsOutput = tryRunCommandCapture('git', ['log', '--oneline', '-10'], { cwd: root });

  return {
    timestamp,
    mode,
    deployOnly: Boolean(deployOnly),
    previousVersion,
    version: nextVersion,
    git: {
      head: gitHead,
      branch: gitBranch,
      status: gitStatusOutput ? gitStatusOutput.split(/\r?\n/).filter(Boolean) : [],
      recentCommits: gitRecentCommitsOutput ? gitRecentCommitsOutput.split(/\r?\n/).filter(Boolean) : [],
    },
  };
}

function writeBuildChangeLog(root, entry) {
  const { releasesDir, buildChangesDir, historyPath, versionLogPath } = getBuildLogPaths(root, entry.version);
  fs.mkdirSync(releasesDir, { recursive: true });
  fs.mkdirSync(buildChangesDir, { recursive: true });

  let history = [];
  if (fs.existsSync(historyPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      history = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      history = [];
    }
  }

  const nextHistory = history.filter((item) => !(item && item.version === entry.version)).concat(entry);
  fs.writeFileSync(historyPath, `${JSON.stringify(nextHistory, null, 2)}\n`, 'utf8');

  const lines = [
    `# Build Changes ${entry.version}`,
    '',
    `- Timestamp: ${entry.timestamp}`,
    `- Mode: ${entry.mode}`,
    `- Deploy only: ${entry.deployOnly ? 'yes' : 'no'}`,
    `- Previous version: ${entry.previousVersion || 'n/a'}`,
    `- New version: ${entry.version}`,
    `- Git branch: ${entry.git.branch || 'unknown'}`,
    `- Git HEAD: ${entry.git.head || 'unknown'}`,
    '',
    '## Working tree changes',
  ];

  if (entry.git.status.length > 0) {
    for (const line of entry.git.status) lines.push(`- ${line}`);
  } else {
    lines.push('- none');
  }

  lines.push('', '## Recent commits');
  if (entry.git.recentCommits.length > 0) {
    for (const line of entry.git.recentCommits) lines.push(`- ${line}`);
  } else {
    lines.push('- unavailable');
  }

  lines.push('');
  fs.writeFileSync(versionLogPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`[release-build] Build change log written: ${versionLogPath}`);
}

function verifyAndArchiveInstaller(root, version) {
  const releasesDir = path.join(root, 'Releases');
  const fileName = `Wattcoin Miner Setup ${version}.exe`;
  const installerPath = path.join(releasesDir, fileName);
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Installer not found after build: ${installerPath}`);
  }

  const stat = fs.statSync(installerPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Installer is invalid or empty: ${installerPath}`);
  }

  console.log(`Installer verified (${stat.size} bytes) and archived to: ${installerPath}`);
}

function normalizeWhitepaperDownloadLink(html, version) {
  const expectedHref = `/releases/Wattcoin Miner Setup ${version}.exe`;
  return html.replace(
    /(<a) href="[^"]*Wattcoin Miner Setup [^"]+\.exe"( download class="download-btn"[^>]*>)/,
    `$1 href="${expectedHref}"$2`
  );
}

function syncWhitepaperVersionLabels(html, version, monthName, year) {
  let next = String(html || '');
  // Literal em-dash variants (legacy)
  next = next.replace(/VERSION \d+\.\d+\.\d+(?= — [A-Z]+ \d{4})/g, `VERSION ${version}`);
  next = next.replace(/Wattcoin Miner v\d+\.\d+\.\d+/g, `Wattcoin Miner v${version}`);
  next = next.replace(/v\d+\.\d+\.\d+(?= &nbsp;—&nbsp; <a href="mailto:info@wattcoin\.ee">)/g, `v${version}`);
  next = next.replace(/(VERSION \d+\.\d+\.\d+ — )[A-Z]+ \d{4}/g, `$1${monthName} ${year}`);
  next = next.replace(/(v\d+\.\d+\.\d+ — )[A-Z]+ \d{4}/g, `$1${monthName} ${year}`);
  // &mdash; entity variants (used in static HTML footer and inline version labels)
  next = next.replace(/VERSION \d+\.\d+\.\d+(?= &mdash; [A-Z]+ \d{4})/g, `VERSION ${version}`);
  next = next.replace(/(VERSION \d+\.\d+\.\d+ &mdash; )[A-Z]+ \d{4}/g, `$1${monthName} ${year}`);
  next = next.replace(/v\d+\.\d+\.\d+(?=\s*&nbsp;&mdash;&nbsp;\s*<a href="mailto:info@wattcoin\.ee">)/g, `v${version}`);
  next = next.replace(/(&nbsp;&mdash;&nbsp;\s*)([A-Z]+ \d{4})(\s*<br\s*\/?>)/g, `$1${monthName} ${year}$3`);
  return normalizeWhitepaperDownloadLink(next, version);
}

function verifyReleaseMetadata(root, version) {
  const releasesDir = path.join(root, 'Releases');
  const latestYmlPath = path.join(releasesDir, 'latest.yml');
  const installerName = `Wattcoin Miner Setup ${version}.exe`;
  const blockmapName = `${installerName}.blockmap`;

  if (!fs.existsSync(latestYmlPath)) {
    throw new Error(`latest.yml not found after build: ${latestYmlPath}`);
  }

  const latestYml = fs.readFileSync(latestYmlPath, 'utf8');
  if (!latestYml.includes(`url: ${installerName}`) || !latestYml.includes(`path: ${installerName}`)) {
    throw new Error(`latest.yml does not reference expected installer ${installerName}`);
  }

  const blockmapPath = path.join(releasesDir, blockmapName);
  if (!fs.existsSync(blockmapPath)) {
    throw new Error(`Blockmap not found after build: ${blockmapPath}`);
  }
}

function encodeReleaseFileName(name) {
  return encodeURIComponent(name).replace(/%2F/gi, '/');
}

function fetchUrl(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20_000 }, (res) => {
      const status = Number(res.statusCode) || 0;
      const location = res.headers && res.headers.location ? String(res.headers.location) : '';

      if (status >= 300 && status < 400 && location) {
        if (redirectCount >= 5) {
          res.resume();
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }
        const nextUrl = new URL(location, url).toString();
        res.resume();
        resolve(fetchUrl(nextUrl, redirectCount + 1));
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status, body, url });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out for ${url}`));
    });
    req.on('error', reject);
  });
}

async function verifyDeployedAssets(version) {
  const installerName = `Wattcoin Miner Setup ${version}.exe`;
  const encodedInstaller = encodeReleaseFileName(installerName);
  const encodedBlockmap = encodeReleaseFileName(`${installerName}.blockmap`);

  const urls = [
    'https://wattcoin.ee/releases/latest.yml',
    'https://wattcoin.ee/latest.yml',
    `https://wattcoin.ee/releases/${encodedInstaller}`,
    `https://wattcoin.ee/${encodedInstaller}`,
    `https://wattcoin.ee/releases/${encodedBlockmap}`,
    `https://wattcoin.ee/${encodedBlockmap}`,
  ];

  for (const url of urls) {
    const result = await fetchUrl(url);
    if (result.status !== 200) {
      throw new Error(`Remote verify failed (${result.status}): ${url}`);
    }
    console.log(`[release-build] Verified remote asset: ${url}`);
  }

  const releasesFeed = await fetchUrl('https://wattcoin.ee/releases/latest.yml');
  const rootFeed = await fetchUrl('https://wattcoin.ee/latest.yml');
  const expectedVersionLine = `version: ${version}`;

  if (!releasesFeed.body.includes(expectedVersionLine)) {
    throw new Error(`Remote /releases/latest.yml missing expected ${expectedVersionLine}`);
  }
  if (!rootFeed.body.includes(expectedVersionLine)) {
    throw new Error(`Remote /latest.yml missing expected ${expectedVersionLine}`);
  }

  console.log(`[release-build] Remote feeds verified for version ${version}.`);
}

function logPackagingChecklistReminder() {
  const lines = [
    '[release-build]',
    '[release-build] ============================================================',
    '[release-build] STOP AND CHECK PACKAGING BEFORE SHIPPING THIS INSTALLER',
    '[release-build] ============================================================',
    '[release-build] electron-builder.config.js uses an explicit files/extraResources allowlist.',
    '[release-build] Every new main-process module must be added there manually.',
    '[release-build] If you forget, the installed app can build successfully and then crash on launch.',
    '[release-build] Required check before EVERY shipped installer:',
    '[release-build] 1. Review electron-builder.config.js files and extraResources.',
    '[release-build] 2. Confirm every new runtime dependency is packaged.',
    '[release-build] 3. Only then ship or upload the installer.',
    '[release-build] ============================================================',
    '[release-build]',
  ];
  for (const line of lines) console.warn(line);
}

function autoConfigureDevSigning(root) {
  if (process.platform !== 'win32') return;
  // Don't override explicit certificate configuration already in the environment.
  if (
    optionalString('WATTCOIN_WINDOWS_CERT_FILE') ||
    optionalString('CSC_LINK') ||
    optionalString('WIN_CSC_LINK')
  ) return;

  const certPfx        = path.join(root, 'certs', 'sign.pfx');
  const certPassFile   = path.join(root, 'certs', '.password');
  if (!fs.existsSync(certPfx)) return;

  process.env.WATTCOIN_WINDOWS_CERT_FILE       = certPfx;
  process.env.WATTCOIN_WINDOWS_SIGNING_ON_HOLD = '0';
  process.env.WATTCOIN_ENABLE_WINDOWS_SIGNING  = '1';

  if (!optionalString('WATTCOIN_WINDOWS_CERT_PASSWORD', 'WIN_CSC_KEY_PASSWORD')) {
    if (fs.existsSync(certPassFile)) {
      process.env.WATTCOIN_WINDOWS_CERT_PASSWORD = fs.readFileSync(certPassFile, 'utf8').trim();
    }
  }

  console.log('[release-build] Dev signing certificate detected: certs/sign.pfx — signing enabled.');
}

async function main() {
  const root = path.resolve(__dirname, '..');
  let hardeningBackups = new Map();
  let mutableReleaseBackups = new Map();
  let buildSucceeded = false;
  const deployOnly = optionalBoolean('WATTCOIN_RELEASE_DEPLOY_ONLY', false);
  const skipDeploy = deployOnly ? false : (process.argv.includes('--local') || optionalBoolean('WATTCOIN_SKIP_DEPLOY', false));
  autoConfigureDevSigning(root);
  logSigningMode();
  const packageJsonPath = path.join(root, 'package.json');
  const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageJsonRaw);

  if (deployOnly) {
    const currentVersion = String(packageJson.version || '').trim();
    if (!currentVersion) {
      throw new Error('Deploy-only mode requires a valid package.json version.');
    }
    writeBuildChangeLog(root, collectBuildChangeLog(root, {
      mode: 'deploy-only',
      previousVersion: currentVersion,
      nextVersion: currentVersion,
      deployOnly: true,
    }));
    verifyAndArchiveInstaller(root, currentVersion);
    verifyReleaseMetadata(root, currentVersion);

    console.log(`[release-build] Deploy-only mode for version ${currentVersion}.`);
    console.log('[release-build] Deploying to server...');
    const deployScript = path.join(__dirname, '_sftp-deploy.js');
    const deployRes = spawnSync(process.execPath, [deployScript], {
      stdio: 'inherit',
      windowsHide: false,
    });
    if (deployRes.error) {
      throw new Error(`Deploy failed: ${deployRes.error.message || String(deployRes.error)}`);
    }
    if (deployRes.status !== 0) {
      throw new Error(`Deploy script exited with code ${deployRes.status}`);
    }
    console.log('[release-build] Deploy complete.');
    await verifyDeployedAssets(currentVersion);
    return;
  }

  assertWorkspaceElectronProcessesStopped(root);

  const previousVersion = packageJson.version;
  const nextVersion = bumpPatchVersion(previousVersion);
  const { historyPath, versionLogPath } = getBuildLogPaths(root, nextVersion);
  const whitepaperPath = path.join(root, 'wattcoin-whitepaper.html');
  const homepagePath = path.join(root, 'homepage.html');
  const walletPath = path.join(root, 'wallet.html');
  const latestYmlPath = path.join(root, 'Releases', 'latest.yml');
  mutableReleaseBackups = snapshotFileContents([
    packageJsonPath,
    whitepaperPath,
    homepagePath,
    walletPath,
    latestYmlPath,
    historyPath,
    versionLogPath,
  ]);
  removeExistingVersionArtifacts(root, nextVersion);
  writeBuildChangeLog(root, collectBuildChangeLog(root, {
    mode: 'build-and-deploy',
    previousVersion,
    nextVersion,
    deployOnly: false,
  }));
  packageJson.version = nextVersion;
  fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  console.log(`Version bumped: ${previousVersion} -> ${nextVersion}`);

  // Update all version references in homepage.html, wattcoin-whitepaper.html and wallet.html
  {
    const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
    const now = new Date();
    const monthName = months[now.getMonth()];
    const year = now.getFullYear();
    if (fs.existsSync(homepagePath)) {
      let hp = fs.readFileSync(homepagePath, 'utf8');
      hp = syncWhitepaperVersionLabels(hp, nextVersion, monthName, year);
      fs.writeFileSync(homepagePath, hp, 'utf8');
      console.log(`homepage.html updated to ${nextVersion} — ${monthName} ${year}`);
    }
    if (fs.existsSync(whitepaperPath)) {
      let wp = fs.readFileSync(whitepaperPath, 'utf8');
      wp = syncWhitepaperVersionLabels(wp, nextVersion, monthName, year);
      fs.writeFileSync(whitepaperPath, wp, 'utf8');
      console.log(`wattcoin-whitepaper.html updated to ${nextVersion} — ${monthName} ${year}`);
    }
    if (fs.existsSync(walletPath)) {
      let wl = fs.readFileSync(walletPath, 'utf8');
      wl = syncWhitepaperVersionLabels(wl, nextVersion, monthName, year);
      fs.writeFileSync(walletPath, wl, 'utf8');
      console.log(`wallet.html updated to ${nextVersion} — ${monthName} ${year}`);
    }
  }

  try {
    hardeningBackups = applyReleaseHardening(root);

    runNpmExec(['exec', '--', 'vite', 'build']);
    verifyRendererSaleBundle(root);
    assertMainProcessRuntimeFilesPackaged(root);
    logPackagingChecklistReminder();
    runNpmExec(['exec', '--', 'electron-builder', '--config', 'electron-builder.config.js']);
    verifyAndArchiveInstaller(root, nextVersion);
    verifyReleaseMetadata(root, nextVersion);

    if (!skipDeploy) {
      console.log('[release-build] Deploying to server...');
      const deployScript = path.join(__dirname, '_sftp-deploy.js');
      const deployRes = spawnSync(process.execPath, [deployScript], {
        stdio: 'inherit',
        windowsHide: false,
      });
      if (deployRes.error) {
        throw new Error(`Deploy failed: ${deployRes.error.message || String(deployRes.error)}`);
      }
      if (deployRes.status !== 0) {
        throw new Error(`Deploy script exited with code ${deployRes.status}`);
      }
      console.log('[release-build] Deploy complete.');

      await verifyDeployedAssets(nextVersion);
    } else {
      console.log('[release-build] --local: skipping deploy and remote verification.');
    }
    buildSucceeded = true;
  } finally {
    restoreHardeningBackups(hardeningBackups);
    if (!buildSucceeded) {
      restoreFileContents(mutableReleaseBackups);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[release-build] Failed:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  assertMainProcessRuntimeFilesPackaged,
  bumpPatchVersion,
  syncWhitepaperVersionLabels,
};