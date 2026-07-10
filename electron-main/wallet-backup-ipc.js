const { dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { getFocusedWindow } = require('./electron-utils');
const {
  validatePassphrase,
  sha256Hex,
  formatBackupTimestampForFilename,
  encryptBackupPayload,
  decryptBackupPayload,
  normalizeWalletError,
  getActiveNetwork,
} = require('./main-utils');

const BACKUP_FILE_EXTENSION = 'wcbak';
const BACKUP_FORMAT_VERSION = 1;

function parseBackupContainer(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('Invalid backup file format (JSON parsing failed).');
  }

  const format = parsed && parsed.format;
  const version = parsed && parsed.version;
  if (format !== 'WATTCOIN_WALLET_BACKUP' || version !== BACKUP_FORMAT_VERSION) {
    throw new Error('Unsupported backup format version.');
  }

  if (!parsed.encrypted || typeof parsed.encrypted !== 'object') {
    throw new Error('Backup is missing encrypted payload.');
  }

  return parsed;
}

function registerWalletBackupIpcHandlers(ctx) {
  const {
    getWalletDataDir,
    getDeviceIdentityFilePath,
    getOrCreateWalletEncryptionKey,
    loadOrCreateDeviceIdentity,
    getActivePeers,
    getActiveReverseTunnelPeerConnectionCount,
    getPeerDirectoryTargets,
    getTrustedPeerTargets,
    requestPeerJson,
    isSelfPeerUrl,
    handlePeerTipSignal,
    getLedgerNetworkSettings,
    getLocalTunnelPeerLiveness,
    roundLedger,
    startGovernanceSync,
    setCoordinatorIdentityKey,
    refreshWalletSyncState,
    stopHardwareLoad,
    createWtcNode,
    setWtcNode,
    setWalletAddressCache,
  } = ctx;

  ipcMain.handle('wattcoin-export-wallet-backup', async (_, options = {}) => {
    const passphrase = options && typeof options.passphrase === 'string' ? options.passphrase : '';
    if (!validatePassphrase(passphrase)) {
      return { ok: false, code: 'INVALID_PASSPHRASE', message: 'Passphrase must be at least 8 characters.' };
    }
    try {
      const walletFilePath = path.join(getWalletDataDir(), 'wtc-wallet.json');
      if (!fs.existsSync(walletFilePath)) {
        return { ok: false, code: 'WALLET_FILE_MISSING', message: 'WTC wallet file not found.' };
      }
      const backupTimestamp = formatBackupTimestampForFilename();
      const saveResult = await dialog.showSaveDialog(getFocusedWindow(), {
        title: 'Export Encrypted Wallet Backup',
        defaultPath: `wattcoin-wtc-${backupTimestamp}.${BACKUP_FILE_EXTENSION}`,
        filters: [{ name: 'Wattcoin Wallet Backup', extensions: [BACKUP_FILE_EXTENSION] }],
        properties: ['createDirectory', 'showOverwriteConfirmation'],
      });
      if (saveResult.canceled || !saveResult.filePath) {
        return { ok: false, code: 'CANCELED', message: 'Backup export canceled.' };
      }
      const walletBytes = await fsp.readFile(walletFilePath);
      const createdAt = new Date().toISOString();
      const walletHash = sha256Hex(walletBytes);
      const payload = {
        metadata: { walletName: 'wtc-native', network: getActiveNetwork(), createdAt, app: 'Wattcoin' },
        walletDatBase64: walletBytes.toString('base64'),
        integrity: { algorithm: 'sha256', walletDatHex: walletHash },
      };
      const encrypted = encryptBackupPayload(payload, passphrase);
      const container = {
        format: 'WATTCOIN_WALLET_BACKUP',
        version: BACKUP_FORMAT_VERSION,
        kdf: { name: 'scrypt', keyLength: 32 },
        cipher: { name: 'aes-256-gcm' },
        encrypted,
      };
      await fsp.writeFile(saveResult.filePath, JSON.stringify(container, null, 2), 'utf8');
      return { ok: true, filePath: saveResult.filePath, walletName: 'wtc-native', createdAt, checksum: walletHash };
    } catch (e) {
      return normalizeWalletError(e);
    }
  });

  ipcMain.handle('wattcoin-restore-wallet-backup', async (_, options = {}) => {
    const defaultWalletName = 'wattminer';
    const passphrase = options && typeof options.passphrase === 'string' ? options.passphrase : '';
    if (!validatePassphrase(passphrase)) {
      return { ok: false, code: 'INVALID_PASSPHRASE', message: 'Passphrase must be at least 8 characters.' };
    }
    try {
      const openResult = await dialog.showOpenDialog(getFocusedWindow(), {
        title: 'Restore Encrypted Wallet Backup',
        filters: [{ name: 'Wattcoin Wallet Backup', extensions: [BACKUP_FILE_EXTENSION] }],
        properties: ['openFile'],
      });
      if (openResult.canceled || !openResult.filePaths || openResult.filePaths.length === 0) {
        return { ok: false, code: 'CANCELED', message: 'Backup restore canceled.' };
      }
      const backupPath = openResult.filePaths[0];
      if (!backupPath) {
        return { ok: false, code: 'CANCELED', message: 'Backup restore canceled.' };
      }
      if (!fs.existsSync(backupPath)) {
        return { ok: false, code: 'BACKUP_FILE_MISSING', message: `Backup file not found: ${backupPath}` };
      }
      const raw = await fsp.readFile(backupPath, 'utf8');
      const container = parseBackupContainer(raw);
      let payload = null;
      try {
        payload = decryptBackupPayload(container.encrypted, passphrase);
      } catch (_) {
        return { ok: false, code: 'DECRYPT_FAILED', message: 'Failed to decrypt backup. Check your passphrase.' };
      }
      const metadata = payload && payload.metadata ? payload.metadata : {};
      const _walletName =
        typeof metadata.walletName === 'string' && metadata.walletName ? metadata.walletName : defaultWalletName;
      const expectedNetwork = getActiveNetwork();
      const network = metadata && metadata.network ? metadata.network : 'unknown';
      if (network !== expectedNetwork) {
        return {
          ok: false,
          code: 'NETWORK_MISMATCH',
          message: `Backup network is ${network}, expected ${expectedNetwork}.`,
        };
      }
      const walletDataBase64 = payload && payload.walletDatBase64 ? payload.walletDatBase64 : '';
      const walletDat = Buffer.from(walletDataBase64, 'base64');
      if (!walletDat || walletDat.length === 0) {
        return { ok: false, code: 'INVALID_BACKUP', message: 'Backup payload does not contain wallet data.' };
      }
      const expectedHash = payload && payload.integrity ? payload.integrity.walletDatHex : '';
      const actualHash = sha256Hex(walletDat);
      if (!expectedHash || expectedHash !== actualHash) {
        return { ok: false, code: 'INTEGRITY_CHECK_FAILED', message: 'Backup checksum verification failed.' };
      }
      const walletFilePath = path.join(getWalletDataDir(), 'wtc-wallet.json');
      const walletDir = path.dirname(walletFilePath);
      if (fs.existsSync(walletFilePath)) {
        const overwriteResult = await dialog.showMessageBox(getFocusedWindow(), {
          type: 'warning',
          buttons: ['Cancel Restore', 'Overwrite Wallet'],
          defaultId: 0,
          cancelId: 0,
          title: 'Wallet Already Exists',
          message: 'A wallet already exists at this location.',
          detail: `${walletFilePath}\n\nRestoring this backup will replace your current wallet. Make sure you have exported a backup of your current wallet first.`,
        });
        if (overwriteResult.response !== 1) {
          return { ok: false, code: 'CANCELED', message: 'Restore canceled.' };
        }
      }
      try {
        stopHardwareLoad();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      await fsp.mkdir(walletDir, { recursive: true });
      await fsp.writeFile(walletFilePath, walletDat);
      let newNode = null;
      try {
        const wtcSecret = (() => {
          try {
            const raw = JSON.parse(fs.readFileSync(getDeviceIdentityFilePath(), 'utf8'));
            return raw && raw.secret ? raw.secret : '';
          } catch (_) {
            return '';
          }
        })();
        newNode = createWtcNode({
          dataDir: getWalletDataDir(),
          signingSecret: wtcSecret || crypto.randomBytes(32).toString('hex'),
          peerIdentity: String(loadOrCreateDeviceIdentity().deviceId || '').trim(),
          walletKey: getOrCreateWalletEncryptionKey(),
          getActivePeers: () => getActivePeers(getLedgerNetworkSettings()),
          getConnectedPeerCount: () => getActiveReverseTunnelPeerConnectionCount(),
          getPeerTargets: () => getPeerDirectoryTargets(getLedgerNetworkSettings()),
          getTrustedPeerTargets: () => getTrustedPeerTargets(getLedgerNetworkSettings()),
          requestPeerJson,
          isSelfPeerUrl,
          onPeerTip: (peerUrl, tip) => handlePeerTipSignal(peerUrl, tip, 'tip-probe'),
          allowPartialQuorumCommit: !(getLedgerNetworkSettings().enabled && getLedgerNetworkSettings().mode === 'peer'),
          isLiveLocalTunnelPeer: getLocalTunnelPeerLiveness,
          getEnergyContributions: () => roundLedger.getCurrentRoundSnapshot().contributionsWh,
        });
        setWtcNode(newNode);
        startGovernanceSync();
        try {
          const restoredPrimary = newNode.getPrimaryAddress();
          setWalletAddressCache({ address: restoredPrimary || '', at: restoredPrimary ? Date.now() : 0 });
          if (restoredPrimary) setCoordinatorIdentityKey(restoredPrimary);
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      } catch (reinitErr) {
        console.error('[RestoreBackup] Failed to re-init WTC node:', reinitErr && reinitErr.message);
      }
      const allAddresses = newNode ? newNode.getAddresses() : [];
      refreshWalletSyncState('restore-wallet-backup', { force: true }).catch(() => {});
      return {
        ok: true,
        walletName: 'wtc-native',
        filePath: backupPath,
        restoredTo: walletFilePath,
        checksum: actualHash,
        restartedNode: true,
        allAddresses,
      };
    } catch (e) {
      return normalizeWalletError(e);
    }
  });
}

module.exports = { registerWalletBackupIpcHandlers };
