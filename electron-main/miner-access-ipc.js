function getMinerBetaPassword(runtimeConfig) {
  const candidate = runtimeConfig.minerPassword || '';
  return typeof candidate === 'string' ? candidate : '';
}

function isMinerPasswordRequired(runtimeConfig) {
  return getMinerBetaPassword(runtimeConfig).trim().length > 0;
}

function registerMinerAccessIpcHandlers(ipcMain, deps) {
  const { getRuntimeConfig, secureStringEquals, logAbuseEvent, getBetaPolicy } = deps;

  ipcMain.handle('wattcoin-get-miner-access-policy', () => {
    const passwordRequired = isMinerPasswordRequired(getRuntimeConfig());
    return {
      ok: true,
      passwordRequired,
      mode: passwordRequired ? 'password' : 'open',
      message: passwordRequired
        ? 'Miner beta password is required before mining can start.'
        : 'No miner password is configured.',
    };
  });

  ipcMain.handle('wattcoin-get-beta-policy', () => {
    return {
      ok: true,
      ...getBetaPolicy(),
    };
  });

  ipcMain.handle('wattcoin-verify-miner-password', async (_event, passwordAttempt) => {
    const runtime = getRuntimeConfig();
    const passwordRequired = isMinerPasswordRequired(runtime);
    if (!passwordRequired) {
      return { ok: true, passwordRequired: false, authorized: true, message: 'Password not required.' };
    }

    const expected = getMinerBetaPassword(runtime);
    const provided = typeof passwordAttempt === 'string' ? passwordAttempt : '';
    const authorized = secureStringEquals(provided, expected);
    if (!authorized) {
      await logAbuseEvent({
        type: 'auth-failure',
        endpoint: 'wattcoin-verify-miner-password',
        actorId: 'local-client',
        metadata: { reason: 'invalid-password' },
      });
    }
    return {
      ok: true,
      passwordRequired: true,
      authorized,
      message: authorized ? 'Miner unlocked.' : 'Invalid miner password.',
    };
  });
}

module.exports = { registerMinerAccessIpcHandlers };
