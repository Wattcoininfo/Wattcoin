const path = require('path');
const fs = require('fs');

function optionalString(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

const publisherName = optionalString('WATTCOIN_SIGN_PUBLISHER', 'CSC_NAME', 'WIN_CSC_NAME');
const certificateFile = optionalString('WATTCOIN_WINDOWS_CERT_FILE');
const certificatePassword = optionalString('WATTCOIN_WINDOWS_CERT_PASSWORD', 'WIN_CSC_KEY_PASSWORD');
const certificateSubjectName = optionalString('WATTCOIN_WINDOWS_CERT_SUBJECT_NAME');
const customSignScript = optionalString('WATTCOIN_WINDOWS_SIGN_SCRIPT');
const rfc3161TimeStampServer = optionalString('WATTCOIN_RFC3161_TIMESTAMP_URL');
const timeStampServer = optionalString('WATTCOIN_TIMESTAMP_URL');
const windowsSigningOnHold = optionalBoolean('WATTCOIN_WINDOWS_SIGNING_ON_HOLD', true);
const enableWindowsSigning = !windowsSigningOnHold && optionalBoolean('WATTCOIN_ENABLE_WINDOWS_SIGNING', false);

const winConfig = {
  target: {
    target: 'nsis',
    arch: ['x64'],
  },
  // Prevent electron-builder from auto-detecting the publisher CN from the
  // signing certificate and embedding it in app-update.yml.  A self-signed
  // dev cert is not in Windows' Trusted Root store on user machines, so
  // electron-updater's Get-AuthenticodeSignature check would return
  // Status=NotTrusted (not 0=Valid) and reject every update with
  // ERR_UPDATER_INVALID_SIGNATURE.  The runtime override below also skips
  // the check, but this prevents the publisherName from being written at all.
  verifyUpdateCodeSignature: false,
};

if (enableWindowsSigning && publisherName) {
  winConfig.publisherName = [publisherName];
}

if (enableWindowsSigning) {
  const signtoolOptions = {};

  if (certificateFile) {
    signtoolOptions.certificateFile = path.resolve(certificateFile);
  }
  if (certificatePassword) {
    signtoolOptions.certificatePassword = certificatePassword;
  }
  if (certificateSubjectName) {
    signtoolOptions.certificateSubjectName = certificateSubjectName;
  }
  if (rfc3161TimeStampServer) {
    signtoolOptions.rfc3161TimeStampServer = rfc3161TimeStampServer;
  } else if (timeStampServer) {
    signtoolOptions.timeStampServer = timeStampServer;
  }

  if (Object.keys(signtoolOptions).length > 0) {
    winConfig.signtoolOptions = signtoolOptions;
  }
}

if (enableWindowsSigning && customSignScript) {
  winConfig.sign = path.resolve(customSignScript);
}

const scriptDir = path.resolve(__dirname, 'scripts');
const hasAfterPack = fs.existsSync(path.join(scriptDir, 'after-pack-windows.js'));
const hasAfterSign = fs.existsSync(path.join(scriptDir, 'after-sign-windows.js'));

const config = {
  appId: 'com.wattcoin.miner',
  productName: 'Wattcoin Miner',
  icon: 'assets/icons/icon.png',
  directories: {
    output: 'Releases',
  },
  publish: {
    provider: 'generic',
    url: 'https://wattcoin.ee/releases',
  },
  forceCodeSigning: !windowsSigningOnHold && optionalBoolean('WATTCOIN_REQUIRE_WINDOWS_SIGNING', false),
  files: [
    'dist/**/*',
    'assets/icons/**/*',
    'electron-main.js',
    'preload.js',
    'electron-start.js',
    'backend-benchmark.js',
    'hardware-tables.cjs',
    'cpu-load-worker.js',
    'ddr-load-worker.js',
    'hardware-load-controller.js',
    'ops-health.js',
    'probe-attestation.js',
    'remote-seed-manifest.js',
    'requester-registration.js',
    'round-ledger.js',
    'runtime-config.js',
    'wtc-node.js',
    'wtc-accounts.js',
    'wtc-address.js',
    'wtc-chain.js',
    'wtc-consensus.js',
    'wtc-mempool.js',
    'wtc-nfts.js',
    'wtc-governance.js',
    'wtc-sale-queue.js',
    'wtc-staking-queue.js',
    'peer-count-observability.js',
    'peer-discovery-observability.js',
    'peer-privacy.js',
    'peer-self-filter.js',
    'local-subnet-discovery.js',
    'protocol-constants.js',
    'app-integrity-manifest.json',
    'package.json',
  ],
  extraResources: [
    ...[
      ['wattcoin-beta-config.json', 'wattcoin-beta-config.json'],
      ['docs/seed-peers.mainnet.json', 'seed-peers.mainnet.json'],
      ['resources/wtc-genesis.json', 'wtc-genesis.json'],
    ]
      .filter(([src]) => fs.existsSync(path.resolve(__dirname, src)))
      .map(([src, dest]) => ({ from: src, to: dest })),
  ],
  // electron-builder v26 applies fuses natively, including computing and embedding
  // the ASAR hash before flipping EnableEmbeddedAsarIntegrityValidation.
  // Windows ASAR integrity requires electron >= 30.0.0.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  win: {
    ...winConfig,
    icon: 'assets/icons/icon.ico',
    artifactName: 'Wattcoin Miner Setup ${version}.exe',
    extraFiles: [
      {
        from: 'assets/icons/Wattcoin Miner.VisualElementsManifest.xml',
        to: 'Wattcoin Miner.VisualElementsManifest.xml',
      },
      {
        from: 'assets/icons/icon-150.png',
        to: 'assets/icons/icon-150.png',
      },
      {
        from: 'assets/icons/icon-70.png',
        to: 'assets/icons/icon-70.png',
      },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    installerIcon: 'assets/icons/icon.ico',
    uninstallerIcon: 'assets/icons/icon.ico',
    installerHeaderIcon: 'assets/icons/icon.ico',
  },
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'assets/icons/icon.png',
    artifactName: 'Wattcoin-Miner-${version}.${ext}',
    category: 'Utility',
    maintainer: 'Wattcoin Foundation <info@wattcoin.ee>',
    desktop: {
      entry: {
        Name: 'Wattcoin Miner',
        Comment: 'Wattcoin Miner — CPU/GPU miner, wallet and staking',
        Terminal: false,
      },
    },
  },
};

if (hasAfterPack) config.afterPack = 'scripts/after-pack-windows.js';
if (hasAfterSign) config.afterSign = 'scripts/after-sign-windows.js';

module.exports = config;
