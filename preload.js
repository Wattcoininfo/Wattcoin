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
        const gpuControllers = (graphics.controllers || []).filter((g) => {
          const name = String(g.model || g.name || '').trim();
          if (!name) return false;
          if (/Microsoft (Basic|Remote) (Render|Display)/i.test(name)) return false;
          if (/Microsoft Hyper-V/i.test(name)) return false;
          return true;
        });
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
      isHardwareRecognized: (opts) => ipcRenderer.invoke('wattcoin-is-hardware-recognized', opts || {}),
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
      getAsicConfig: () => ipcRenderer.invoke('wattcoin-asic-get-config'),
      setAsicConfig: (config) => ipcRenderer.invoke('wattcoin-asic-set-config', config),
      scanAsicNetwork: () => ipcRenderer.invoke('wattcoin-asic-scan'),
      waitForFreshShares: (count) => ipcRenderer.invoke('wattcoin-asic-wait-fresh-shares', count),
      injectAsicCustomJob: (prevHashHex) => ipcRenderer.invoke('wattcoin-asic-inject-custom-job', prevHashHex),
      startAsicMining: () => ipcRenderer.invoke('wattcoin-asic-start-mining'),
      stopAsicMining: () => ipcRenderer.invoke('wattcoin-asic-stop-mining'),
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
      checkFirewallRule: () => ipcRenderer.invoke('wattcoin-check-firewall-rule'),
      wasUpdated: () => ipcRenderer.invoke('wattcoin-was-updated'),
      firewallConsented: () => ipcRenderer.invoke('wattcoin-firewall-consented'),
      healFirewall: () => ipcRenderer.invoke('wattcoin-heal-firewall'),
      // Generic invoke method for other IPC handlers.
      // Uses an explicit allowlist — any channel not on the list is silently rejected so
      // newly-added sensitive handlers are protected by default (secure-by-default).
      invoke: (channel, ...args) => {
        const ALLOWED_CHANNELS = new Set([
          'wattcoin-get-wallet-address',
          'wattcoin-get-wallet-state',
          'wattcoin-set-primary-address',
          'wattcoin-get-benchmark-capabilities',
          'wattcoin-is-hardware-recognized',
          'wattcoin-run-backend-benchmark',
          'wattcoin-set-hardware-load',
          'wattcoin-stop-hardware-load',
          'wattcoin-get-hardware-load-state',
          'wattcoin-mine-block',
          'wattcoin-get-pending-probe',
          'wattcoin-submit-probe-result',
          'wattcoin-get-probe-history',
          'wattcoin-get-attest-history',
          'wattcoin-clear-probe-history',
          'wattcoin-get-probe-log',
          'wattcoin-save-probe-log',
          'wattcoin-request-peer-probe',
          'wattcoin-submit-peer-probe-result',
          'wattcoin-read-fingerprint',
          'wattcoin-write-fingerprint',
          'wattcoin-get-device-identity',
          'wattcoin-get-peer-count',
          'wattcoin-check-firewall-rule',
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
          'wattcoin-governance-status',
          'wattcoin-governance-list',
          'wattcoin-governance-get-vote',
          'wattcoin-governance-get-tallies',
          'wattcoin-governance-propose',
          'wattcoin-governance-vote',
          'wattcoin-team-list',
          'wattcoin-team-add',
          'wattcoin-team-edit',
          'wattcoin-team-delete',
          'wattcoin-docs-list',
          'wattcoin-docs-upload',
          'wattcoin-docs-delete',
          'wattcoin-explorer-get-stats',
          'wattcoin-explorer-get-address',
          'wattcoin-explorer-search',
          'wattcoin-explorer-get-tx-detail',
          'wattcoin-mining-status',
          'wattcoin-asic-set-config',
          'wattcoin-asic-get-config',
          'wattcoin-asic-scan',
          'wattcoin-asic-wait-fresh-shares',
          'wattcoin-asic-inject-custom-job',
          'wattcoin-asic-start-mining',
          'wattcoin-asic-stop-mining',
          'wattcoin-get-peer-topology',
          'wattcoin-gpu-pow-probe',
          'wattcoin-gpu-proof',
          'wattcoin-gpu-info',
          'wattcoin-stop-gpu-load',
          'wattcoin-set-gpu-load',
          'wattcoin-asic-liveness-status',
          'wattcoin-sale-get-purchase-total',
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
