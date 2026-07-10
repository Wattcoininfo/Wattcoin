import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import Miner from '../frontend/Miner.jsx';

const NOOP = () => {};

function createMinProps(overrides = {}) {
  return {
    mining: false,
    setMining: NOOP,
    coins: 0,
    maturedCoins: 0,
    unmaturedCoins: 0,
    setCoins: NOOP,
    energy: 0,
    setEnergy: NOOP,
    log: [],
    setLog: NOOP,
    probeLog: [],
    setProbeLog: NOOP,
    isActive: true,
    setPowerW: NOOP,
    miningAddress: '',
    onBlockMined: NOOP,
    chainHeight: 0,
    hardwareLookupResetNonce: 0,
    ...overrides,
  };
}

beforeAll(() => {
  window.wattcoinHardware = {
    appVersion: '0.0.0-test',
    getSystemInfo: () =>
      Promise.resolve({
        cpu: { manufacturer: 'GenuineIntel', brand: 'Test CPU', cores: 4, physicalCores: 4 },
        gpu: { model: 'Test GPU', vendor: 'TestVendor' },
        gpus: [],
        mem: { total: 16e9 },
        memLayout: [{ size: 16e9, type: 'DDR4', clockSpeed: 3200 }],
        os: { platform: 'win32', distro: 'Windows 10' },
        system: { manufacturer: 'Test', model: 'Test' },
        baseboard: { manufacturer: 'Test', model: 'Test' },
        chassis: { type: 'Desktop' },
      }),
    getWalletState: () => Promise.resolve({ ok: true, confirmed: 0, spendable: 0 }),
    getWalletAddress: () => Promise.resolve(''),
    getBenchmarkCapabilities: () => Promise.resolve({ ok: true }),
    isHardwareRecognized: () => Promise.resolve({ ok: true }),
    runBackendBenchmark: () => Promise.resolve({ ok: true }),
    setHardwareLoad: NOOP,
    stopHardwareLoad: NOOP,
    getHardwareLoadState: () => Promise.resolve({ running: false, percent: 0 }),
    getPendingProbe: () => Promise.resolve(null),
    submitProbeResult: () => Promise.resolve({}),
    getProbeHistory: () => Promise.resolve([]),
    getPeerCount: () => Promise.resolve(5),
    invoke: () => Promise.resolve({ ok: true }),
    onUpdateDownloaded: NOOP,
    onWalletState: () => NOOP,
    installUpdate: NOOP,
  };
});

afterEach(cleanup);

describe('Miner firewall banner', () => {
  it('shows banner when firewallBlocked is true', async () => {
    render(<Miner {...createMinProps({ firewallBlocked: true })} />);

    const banner = await screen.findByText(/no windows firewall rule was created/i);
    expect(banner).toBeInTheDocument();
  });

  it('hides banner when firewallBlocked is false', () => {
    render(<Miner {...createMinProps({ firewallBlocked: false })} />);

    expect(screen.queryByText(/no windows firewall rule was created/i)).not.toBeInTheDocument();
  });
});
