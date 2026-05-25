try {
  const si = require('systeminformation');
  const { contextBridge } = require('electron');
  console.log('[Wattcoin preload] Loaded preload.js');
  if (!contextBridge) {
    console.error('[Wattcoin preload] contextBridge is undefined');
  } else {
    const { ipcRenderer } = require('electron');
    const appVersion = ipcRenderer.sendSync('wattcoin-get-app-version');
    contextBridge.exposeInMainWorld('wattcoinHardware', {
      appVersion,
      getSystemInfo: async () => {
        console.log('[Wattcoin preload] getSystemInfo called');
        const cpu = await si.cpu();
        const graphics = await si.graphics();
        const gpuControllers = graphics.controllers || [];
        const gpu = gpuControllers[0] || {};
        const gpus = gpuControllers; // all GPU controllers for multi-GPU support
        const mem = await si.mem();
        const memLayout = await si.memLayout();
        const osInfo = await si.osInfo();
        const system = await si.system();
        const baseboard = await si.baseboard();
        const chassis = await si.chassis();
        return {
          cpu,
          gpu,
          gpus,
          mem,
          memLayout,
          os: osInfo,
          system,
          baseboard,
          chassis,
        };
      },
      getWalletState: () => ipcRenderer.invoke('wattcoin-get-wallet-state'),
      getWalletAddress: () => ipcRenderer.invoke('wattcoin-get-wallet-address'),
      setPrimaryAddress: (address) => ipcRenderer.invoke('wattcoin-set-primary-address', address),
      getBenchmarkCapabilities: () => ipcRenderer.invoke('wattcoin-get-benchmark-capabilities'),
      runBackendBenchmark: (request) => ipcRenderer.invoke('wattcoin-run-backend-benchmark', request || {}),
      setHardwareLoad: (percent) => ipcRenderer.invoke('wattcoin-set-hardware-load', percent),
      stopHardwareLoad: () => ipcRenderer.invoke('wattcoin-stop-hardware-load'),
      getHardwareLoadState: () => ipcRenderer.invoke('wattcoin-get-hardware-load-state'),
      exportWalletBackup: (options) => ipcRenderer.invoke('wattcoin-export-wallet-backup', options || {}),
      restoreWalletBackup: (options) => ipcRenderer.invoke('wattcoin-restore-wallet-backup', options || {}),
      mineBlock: (address, proofData) => {
        console.log('[Wattcoin preload] mineBlock called with address:', address);
        return ipcRenderer.invoke('wattcoin-mine-block', address, proofData || null);
      },
      getPendingProbe: () => ipcRenderer.invoke('wattcoin-get-pending-probe'),
      submitProbeResult: (result) => ipcRenderer.invoke('wattcoin-submit-probe-result', result || {}),
      getProbeHistory: () => ipcRenderer.invoke('wattcoin-get-probe-history'),
      requestPeerProbe: (opts) => ipcRenderer.invoke('wattcoin-request-peer-probe', opts || {}),
      submitPeerProbeResult: (payload) => ipcRenderer.invoke('wattcoin-submit-peer-probe-result', payload || {}),
      // Wallet-bound fingerprint persistence (item 6): stored in userData, not localStorage.
      readFingerprintFile: () => ipcRenderer.invoke('wattcoin-read-fingerprint'),
      writeFingerprintFile: (data) => ipcRenderer.invoke('wattcoin-write-fingerprint', data || {}),
      // Hardware-bound device identity: generated once on first run, stored in userData.
      // deviceId (SHA-256 of local secret) is the stable public identifier for this device.
      getDeviceIdentity: () => ipcRenderer.invoke('wattcoin-get-device-identity'),
      getPeerCount: () => ipcRenderer.invoke('wattcoin-get-peer-count'),
      // Generic invoke method for other IPC handlers.
      // Uses an explicit allowlist — any channel not on the list is silently rejected so
      // newly-added sensitive handlers are protected by default (secure-by-default).
      invoke: (channel, ...args) => {
        const ALLOWED_CHANNELS = new Set([
          'wattcoin-get-wallet-address',
          'wattcoin-get-wallet-state',
          'wattcoin-set-primary-address',
          'wattcoin-get-benchmark-capabilities',
          'wattcoin-run-backend-benchmark',
          'wattcoin-set-hardware-load',
          'wattcoin-stop-hardware-load',
          'wattcoin-get-hardware-load-state',
          'wattcoin-mine-block',
          'wattcoin-get-pending-probe',
          'wattcoin-submit-probe-result',
          'wattcoin-get-probe-history',
          'wattcoin-get-attest-history',
          'wattcoin-get-probe-log',
          'wattcoin-save-probe-log',
          'wattcoin-request-peer-probe',
          'wattcoin-submit-peer-probe-result',
          'wattcoin-read-fingerprint',
          'wattcoin-write-fingerprint',
          'wattcoin-get-device-identity',
          'wattcoin-get-peer-count',
          'wattcoin-get-authority-state',
          'wattcoin-reset-hardware-identity',
          'wattcoin-clear-search-cache',
          'wattcoin-seed-authority-state',
          'wattcoin-report-gpu-calibration',
          'wattcoin-verify-gpu-proof',
          'wattcoin-activate-hardware-hold',
          'wattcoin-attestation-issue-challenge',
          'wattcoin-attestation-submit-proof',
          'wattcoin-attestation-get-policy',
          'wattcoin-sign-attestation-message',
          'wattcoin-get-miner-access-policy',
          'wattcoin-get-beta-policy',
          'wattcoin-verify-miner-password',
          'wattcoin-get-network-info',
          'wattcoin-get-wallet-readiness',
          'wattcoin-get-node-mined-coins',
          'wattcoin-ledger-add-contribution',
          'wattcoin-ledger-get-round-summary',
          'wattcoin-ledger-settle-round',
          'wattcoin-ledger-get-balances',
          'wattcoin-get-seed',
          'wattcoin-export-wallet-backup',
          'wattcoin-restore-wallet-backup',
          'wattcoin-send',
          'wattcoin-get-tx-status',
          'wattcoin-list-transactions',
          'wattcoin-get-addresses',
          'wattcoin-create-address',
          'wattcoin-delete-address',
          'wattcoin-check-for-update',
          'wattcoin-install-update',
          'wattcoin-fetch-url',
          'wattcoin-get-electricity-price',
          'wattcoin-explorer-get-blocks',
          'wattcoin-explorer-get-block',
          'wattcoin-validate-address',
          'wattcoin-open-external-url',
          'wattcoin-open-pay-page',
          'wattcoin-sale-status',
          'wattcoin-sale-compute-price',
          'wattcoin-sale-place-order',
          'wattcoin-sale-get-order',
          'wattcoin-sale-cancel-order',
          'wattcoin-sale-get-my-orders',
          'wattcoin-sale-confirm-payment',
          'wattcoin-staking-status',
          'wattcoin-staking-stake',
          'wattcoin-staking-get-entry',
          'wattcoin-staking-get-my-entries',
          'wattcoin-staking-cancel',
          'wattcoin-nft-list',
          'wattcoin-nft-get',
          'wattcoin-nft-collection',
          'wattcoin-nft-transfer',
          'wattcoin-nft-mint-all',
        ]);
        if (!ALLOWED_CHANNELS.has(channel)) {
          return Promise.reject(new Error(`IPC channel '${channel}' is not allowed from the renderer`));
        }
        return ipcRenderer.invoke(channel, ...args);
      },
      // Auto-update
      onUpdateDownloaded: (cb) => {
        ipcRenderer.on('wattcoin-update-downloaded', (_, info) => cb(info));
      },
      onWalletState: (cb) => {
        const handler = (_, snapshot) => cb(snapshot);
        ipcRenderer.on('wattcoin-wallet-state', handler);
        return () => ipcRenderer.removeListener('wattcoin-wallet-state', handler);
      },
      installUpdate: () => ipcRenderer.invoke('wattcoin-install-update').catch(() => {}),
    });
    console.log('[Wattcoin preload] wattcoinHardware exposed');
  }
} catch (e) {
  console.error('[Wattcoin preload] Error in preload.js:', e);
}
