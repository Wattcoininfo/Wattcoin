const { probeState } = require('./local-probes');
const { peerAttestHistory } = require('./peer-probes');
const { workerHwHistory } = require('./worker-state');

function clearProbeHistory() {
  probeState.history = [];
  peerAttestHistory.length = 0;
}

const workerPeerProbeVerifiedMap = new Map();
function getWorkerPeerProbeVerified(workerId) {
  return !!workerPeerProbeVerifiedMap.get(String(workerId || ''));
}
function setWorkerPeerProbeVerified(workerId) {
  workerPeerProbeVerifiedMap.set(String(workerId || ''), true);
}
function resetWorkerPeerProbeVerified(workerId) {
  workerPeerProbeVerifiedMap.delete(String(workerId || ''));
}

function getWorkerHwStats(workerId) {
  const hist = workerHwHistory.get(String(workerId || ''));
  if (!hist) return null;
  const cpuMean = hist.cpuSamples.length > 0 ? hist.cpuSamples.reduce((a, b) => a + b, 0) / hist.cpuSamples.length : 0;
  const memMean = hist.memSamples.length > 0 ? hist.memSamples.reduce((a, b) => a + b, 0) / hist.memSamples.length : 0;
  const gpuPowMean =
    hist.gpuPowSamples.length > 0 ? hist.gpuPowSamples.reduce((a, b) => a + b, 0) / hist.gpuPowSamples.length : 0;
  return {
    cpuMean,
    memMean,
    gpuPowMean,
    cpuCount: hist.cpuSamples.length,
    memCount: hist.memSamples.length,
    gpuPowCount: hist.gpuPowSamples.length,
  };
}

function getCoordinatorStateSnapshot() {
  const hwHistObj = {};
  for (const [k, v] of workerHwHistory) {
    hwHistObj[k] = {
      cpuSamples: v.cpuSamples.slice(),
      memSamples: v.memSamples.slice(),
      gpuPowSamples: (v.gpuPowSamples || []).slice(),
    };
  }
  const probeVerifiedObj = {};
  for (const [k] of workerPeerProbeVerifiedMap) {
    probeVerifiedObj[k] = true;
  }
  return { workerHwHistory: hwHistObj, workerPeerProbeVerified: probeVerifiedObj };
}

function restoreCoordinatorState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (snapshot.workerHwHistory && typeof snapshot.workerHwHistory === 'object') {
    for (const [k, v] of Object.entries(snapshot.workerHwHistory)) {
      if (v && Array.isArray(v.cpuSamples) && Array.isArray(v.memSamples)) {
        workerHwHistory.set(k, {
          cpuSamples: v.cpuSamples.slice(),
          memSamples: v.memSamples.slice(),
          gpuPowSamples: (v.gpuPowSamples || []).slice(),
        });
      }
    }
  }
  if (snapshot.workerPeerProbeVerified && typeof snapshot.workerPeerProbeVerified === 'object') {
    for (const [k, v] of Object.entries(snapshot.workerPeerProbeVerified)) {
      if (v) workerPeerProbeVerifiedMap.set(k, true);
    }
  }
}

module.exports = {
  clearProbeHistory,
  getWorkerPeerProbeVerified,
  setWorkerPeerProbeVerified,
  resetWorkerPeerProbeVerified,
  getWorkerHwStats,
  getCoordinatorStateSnapshot,
  restoreCoordinatorState,
};
