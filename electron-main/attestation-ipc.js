function registerAttestationIpcHandlers(ipcMain, deps) {
  const { issueBenchmarkChallenge, submitBenchmarkProof, computePolicyForMiner, getWtcNode } = deps;

  ipcMain.handle('wattcoin-attestation-issue-challenge', (_event, payload = {}) => {
    const minerId = payload && payload.minerId ? String(payload.minerId) : 'local-client';
    const hardwareSummary =
      payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
    const identityAddress = payload && payload.identityAddress ? String(payload.identityAddress) : '';
    return issueBenchmarkChallenge(minerId, hardwareSummary, identityAddress);
  });

  ipcMain.handle('wattcoin-attestation-submit-proof', async (_event, payload = {}) => {
    return await submitBenchmarkProof(payload || {});
  });

  ipcMain.handle('wattcoin-attestation-get-policy', (_event, payload = {}) => {
    const minerId = payload && payload.minerId ? String(payload.minerId) : 'local-client';
    const hardwareSummary =
      payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
    return {
      ok: true,
      policy: computePolicyForMiner(minerId, hardwareSummary, { allowSpotCheck: true }),
    };
  });

  ipcMain.handle('wattcoin-sign-attestation-message', (_event, payload = {}) => {
    const _walletName = 'wattminer';
    const address = String(payload && payload.address ? payload.address : '').trim();
    const message = String(payload && payload.message ? payload.message : '').trim();
    if (!address || !message) {
      return { ok: false, code: 'SIGN_INPUT_INVALID', message: 'Address and message are required.' };
    }
    const wtcNode = getWtcNode();
    if (wtcNode) {
      const isOwned = wtcNode.getAddresses().includes(address);
      if (!isOwned) {
        return { ok: false, code: 'ADDRESS_NOT_OWNED', message: 'Selected address is not owned by wallet.' };
      }
      try {
        const result = wtcNode.signMessage(address, message);
        return { ok: true, address, message, signature: result.signature };
      } catch (e) {
        return {
          ok: false,
          code: 'SIGN_FAILED',
          message: e && e.message ? e.message : 'Failed to sign attestation message.',
        };
      }
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
  });
}

module.exports = { registerAttestationIpcHandlers };
