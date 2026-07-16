function registerHardwareLoadIpcHandlers(
  ipcMain,
  {
    setHardwareLoadPercent,
    hwAuthority,
    setProbeLoadPercent,
    getHardwareLoadState,
    stopHardwareLoad,
    _closeBgProbeWs,
    ensureGpu,
    getGpuInfo,
    getGpuLoadState,
    setGpuLoadPercentFn,
    stopGpuHardwareLoad,
    runGpuPowProbe,
  },
) {
  ipcMain.handle('wattcoin-set-hardware-load', (_, percent, opts) => {
    const pct = Number(percent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return { ok: false, error: 'percent must be a finite number between 0 and 100' };
    }
    try {
      // storeOnly: record the target percent without spawning workers or starting
      // load.  The peer-probe path is responsible for actual CPU/GPU loading so
      // that hardware only starts when a coordinator-issued seed arrives.
      if (opts && opts.storeOnly) {
        hwAuthority.currentLoadPercent = pct;
        setProbeLoadPercent(pct);
        return { ok: true, appliedPercent: pct, storeOnly: true, ...getHardwareLoadState() };
      }
      const appliedPercent = setHardwareLoadPercent(pct);
      hwAuthority.currentLoadPercent = typeof appliedPercent === 'number' ? appliedPercent : pct;
      setProbeLoadPercent(hwAuthority.currentLoadPercent);
      return {
        ok: true,
        appliedPercent,
        ...getHardwareLoadState(),
        note: 'CPU and memory are actively controlled. GPU load control is not available in generic mode.',
      };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to set hardware load' };
    }
  });

  ipcMain.handle('wattcoin-stop-hardware-load', () => {
    try {
      stopHardwareLoad();
      _closeBgProbeWs();
      hwAuthority.currentLoadPercent = 0;
      setProbeLoadPercent(0);
      return { ok: true, ...getHardwareLoadState() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to stop hardware load' };
    }
  });

  ipcMain.handle('wattcoin-gpu-info', async (_event, payload) => {
    try {
      const gpuCount = (payload && typeof payload === 'object' ? Number(payload.gpuCount) : Number(payload)) || 1;
      const available = await ensureGpu(gpuCount);
      if (!available) return { ok: false, error: 'GPU binary unavailable' };
      const info = getGpuInfo();
      return { ok: true, ...info, ...getGpuLoadState() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'GPU info failed' };
    }
  });

  ipcMain.handle('wattcoin-set-gpu-load', async (_event, payload) => {
    let percent, gpuCount;
    if (payload && typeof payload === 'object') {
      percent = Number(payload.percent);
      gpuCount = Number(payload.gpuCount) || 1;
    } else {
      percent = Number(payload);
      gpuCount = 1;
    }
    console.warn(`[GpuLoad/IPC] wattcoin-set-gpu-load called: percent=${percent} gpuCount=${gpuCount}`);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { ok: false, error: 'percent must be a finite number between 0 and 100' };
    }
    if (!Number.isInteger(gpuCount) || gpuCount < 1 || gpuCount > 8) {
      return { ok: false, error: 'gpuCount must be an integer between 1 and 8' };
    }
    try {
      const appliedPercent =
        typeof setGpuLoadPercentFn === 'function' ? await setGpuLoadPercentFn(percent, gpuCount) : 0;
      hwAuthority.currentLoadPercent = typeof appliedPercent === 'number' ? appliedPercent : percent;
      console.warn(`[GpuLoad/IPC] wattcoin-set-gpu-load result: appliedPercent=${appliedPercent}`);
      return { ok: true, appliedPercent, ...getGpuLoadState() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to set GPU load' };
    }
  });

  ipcMain.handle('wattcoin-stop-gpu-load', () => {
    console.warn(`[GpuLoad/IPC] wattcoin-stop-gpu-load called`);
    try {
      stopGpuHardwareLoad();
      hwAuthority.currentLoadPercent = 0;
      return { ok: true, ...getGpuLoadState() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to stop GPU load' };
    }
  });

  ipcMain.handle('wattcoin-gpu-pow-probe', async (_event, payload = {}) => {
    try {
      const seed = Number(payload && payload.seed) | 0 || 1;
      const difficulty = Math.max(1, Math.min(65535, Number(payload && payload.difficulty) || 32768));
      const results = await runGpuPowProbe(seed, difficulty);
      if (!results || results.length === 0) {
        return { ok: false, error: 'GPU PoW probe failed' };
      }
      return { ok: true, devices: results, gpuCount: results.length };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'GPU PoW probe exception' };
    }
  });

  ipcMain.handle('wattcoin-get-hardware-load-state', () => {
    try {
      return { ok: true, ...getHardwareLoadState() };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'Failed to read hardware load state' };
    }
  });
}

module.exports = { registerHardwareLoadIpcHandlers };
