const { EventEmitter } = require('events');

function createWalletSyncStateManager({ getWtcNode, walletAddressCache, setCoordinatorIdentityKey, BrowserWindow }) {
  const WALLET_SYNC_STATE_REFRESH_INTERVAL_MS = 5000;
  const updateInstallInProgressRef = { value: false };
  const walletSyncEmitter = new EventEmitter();

  let walletSyncRefreshPromise = null;
  let walletSyncStateTimer = null;
  let walletSyncState = {
    ok: false,
    nodeReady: false,
    rpcReachable: false,
    selectedAddress: '',
    addresses: [],
    walletReadiness: {
      ok: false,
      status: 'syncing',
      message: 'Node is starting up. Please wait...',
      spendReady: false,
      blocks: 0,
      headers: 0,
      connections: 0,
      verificationProgress: 0,
    },
    updatedAt: 0,
    reason: 'startup',
  };

  function cloneWalletSyncState() {
    return JSON.parse(JSON.stringify(walletSyncState));
  }

  function broadcastWalletSyncState() {
    const snapshot = cloneWalletSyncState();
    walletSyncEmitter.emit('changed', snapshot);
  }

  function computeWalletSyncState(reason = 'refresh') {
    const wtcNode = getWtcNode();
    if (!wtcNode) {
      return {
        ok: false,
        nodeReady: false,
        rpcReachable: false,
        selectedAddress: '',
        addresses: [],
        walletReadiness: {
          ok: false,
          status: 'syncing',
          message: 'Node is starting up. Please wait...',
          spendReady: false,
          blocks: 0,
          headers: 0,
          connections: 0,
          verificationProgress: 0,
        },
        updatedAt: Date.now(),
        reason,
      };
    }

    const addresses = Array.isArray(wtcNode.getAddresses()) ? wtcNode.getAddresses() : [];
    const selectedAddress =
      typeof wtcNode.getPrimaryAddress === 'function' ? String(wtcNode.getPrimaryAddress() || '').trim() : '';
    if (selectedAddress) {
      walletAddressCache.address = selectedAddress;
      walletAddressCache.at = Date.now();
      setCoordinatorIdentityKey(selectedAddress);
    }

    const synced = {
      ok: true,
      nodeReady: true,
      rpcReachable: true,
      selectedAddress,
      addresses,
      walletReadiness: walletSyncState.walletReadiness,
      updatedAt: Date.now(),
      reason,
    };

    wtcNode
      .getWalletReadiness()
      .then((readiness) => {
        if (!readiness || typeof readiness !== 'object') return;
        const next = {
          ...synced,
          rpcReachable: readiness.rpcReachable !== false,
          walletReadiness: {
            ok: readiness.ok !== false,
            status: readiness.status || 'syncing',
            message: readiness.message || 'Checking wallet sync status...',
            spendReady: !!readiness.spendReady,
            blocks: Math.max(0, Number(readiness.blocks) || 0),
            headers: Math.max(0, Number(readiness.headers) || 0),
            connections: Math.max(0, Number(readiness.connections) || 0),
            verificationProgress: Math.max(0, Math.min(1, Number(readiness.verificationProgress) || 0)),
            localBlocks: Math.max(-1, Number(readiness.localBlocks) || 0),
            bestPeerHeight: Math.max(-1, Number(readiness.bestPeerHeight) || 0),
            lagBlocks: Math.max(0, Number(readiness.lagBlocks) || 0),
            bestPeer: typeof readiness.bestPeer === 'string' ? readiness.bestPeer : '',
            scanning: !!readiness.scanning,
            initialBlockDownload: !!readiness.initialBlockDownload,
            lastSyncResult: readiness.lastSyncResult || null,
            syncBlockedReason: typeof readiness.syncBlockedReason === 'string' ? readiness.syncBlockedReason : '',
          },
          updatedAt: Date.now(),
          reason,
        };
        const prevSerialized = JSON.stringify(walletSyncState);
        const nextSerialized = JSON.stringify(next);
        walletSyncState = next;
        if (prevSerialized !== nextSerialized) {
          broadcastWalletSyncState();
        }
      })
      .catch(() => {});

    return synced;
  }

  function refreshWalletSyncState(reason = 'refresh', { force = false } = {}) {
    if (walletSyncRefreshPromise && !force) return walletSyncRefreshPromise;
    walletSyncRefreshPromise = (async () => {
      const next = await computeWalletSyncState(reason);
      const previousSerialized = JSON.stringify(walletSyncState);
      const nextSerialized = JSON.stringify(next);
      walletSyncState = next;
      if (previousSerialized !== nextSerialized || force) {
        broadcastWalletSyncState();
      }
      return cloneWalletSyncState();
    })().finally(() => {
      walletSyncRefreshPromise = null;
    });
    return walletSyncRefreshPromise;
  }

  function startWalletSyncStateLoop() {
    if (walletSyncStateTimer) return;
    refreshWalletSyncState('loop-start', { force: true }).catch(() => {});
    walletSyncStateTimer = setInterval(() => {
      refreshWalletSyncState('periodic').catch(() => {});
    }, WALLET_SYNC_STATE_REFRESH_INTERVAL_MS);
  }

  function stopWalletSyncStateLoop() {
    if (!walletSyncStateTimer) return;
    clearInterval(walletSyncStateTimer);
    walletSyncStateTimer = null;
  }

  walletSyncEmitter.on('changed', (snapshot) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.webContents.send('wattcoin-wallet-state', snapshot);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  });

  return {
    refreshWalletSyncState,
    startWalletSyncStateLoop,
    stopWalletSyncStateLoop,
    updateInstallInProgressRef,
  };
}

module.exports = { createWalletSyncStateManager };
