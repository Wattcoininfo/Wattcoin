'use strict';

function registerMainIpcHandlers(ipcMain, deps) {
  const {
    getWtcNode,
    walletAddressCache,
    setCoordinatorIdentityKey,
    refreshWalletSyncState,
    opsState,
    collectOpsSnapshot,
    loadOrCreateDeviceIdentity,
  } = deps;

  ipcMain.handle('wattcoin-get-wallet-address', () => {
    const wtcNode = getWtcNode();
    if (!wtcNode) return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up. Please wait...' };
    const address = wtcNode.getPrimaryAddress();
    walletAddressCache.address = address;
    walletAddressCache.at = Date.now();
    setCoordinatorIdentityKey(address);
    refreshWalletSyncState('get-wallet-address').catch(() => {});
    return { ok: true, address };
  });

  ipcMain.handle('wattcoin-get-wallet-state', () => {
    return refreshWalletSyncState('snapshot');
  });

  ipcMain.handle('wattcoin-set-primary-address', async (_, targetAddress) => {
    const address = typeof targetAddress === 'string' ? targetAddress.trim() : '';
    const wtcNode = getWtcNode();
    if (!wtcNode) {
      return { ok: false, code: 'NODE_NOT_READY', message: 'Node not initialised yet.' };
    }
    if (!address) {
      return { ok: false, code: 'INVALID_ADDRESS', message: 'Address is required.' };
    }
    try {
      wtcNode.setPrimaryAddress(address);
      walletAddressCache.address = address;
      walletAddressCache.at = Date.now();
      setCoordinatorIdentityKey(address);
      const snapshot = await refreshWalletSyncState('set-primary-address', { force: true });
      return { ok: true, address, snapshot };
    } catch (e) {
      return {
        ok: false,
        code: 'SET_PRIMARY_FAILED',
        message: e && e.message ? e.message : 'Failed to set primary address.',
      };
    }
  });

  ipcMain.handle('wattcoin-get-device-identity', () => {
    try {
      const id = loadOrCreateDeviceIdentity();
      const walletAddress = walletAddressCache.address || '';
      return { ok: true, deviceId: id.deviceId, createdAt: id.createdAt, isNew: id.isNew, walletAddress };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : 'Failed to read device identity.' };
    }
  });

  ipcMain.handle('wattcoin-get-ops-metrics', async () => {
    try {
      const snapshot = opsState.latestSnapshot || (await collectOpsSnapshot());
      return { ok: true, snapshot };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : 'failed to read ops metrics' };
    }
  });

  ipcMain.handle('wattcoin-get-wallet-readiness', async () => {
    const wtcNode = getWtcNode();
    if (wtcNode) {
      const readiness = await wtcNode.getWalletReadiness();
      const lastSyncResult = opsState.lastSyncResult || null;
      const lastReason =
        lastSyncResult && typeof lastSyncResult.reason === 'string' ? lastSyncResult.reason.trim() : '';
      const syncBlockedReason =
        !readiness.spendReady &&
        lastReason &&
        lastReason !== 'already best chain' &&
        lastReason !== 'sync already in progress'
          ? lastReason
          : '';
      return {
        ...readiness,
        lastSyncResult,
        syncBlockedReason,
      };
    }
    return { ok: false, spendReady: false, code: 'NODE_NOT_READY', message: 'Node is starting up. Please wait...' };
  });
}

module.exports = { registerMainIpcHandlers };
