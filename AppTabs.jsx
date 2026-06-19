import React, { useState, useRef, useEffect, useCallback } from 'react';
import Wattcoin from './Wattcoin.jsx';
import Miner from './Miner.jsx';
import MiningLog from './MiningLog.jsx';
import Governance from './Governance.jsx';
import nftImgGold from './assets/Vortex NFT Gold.jpg';
import nftImgSilver from './assets/Vortex NFT Silver.jpg';
import nftImgBronze from './assets/Vortex NFT Bronze.jpg';

const TIER0_ENERGY = 1;
const TIER1_ENERGY = 20_000;
const BASE_REWARD = 1000;
const TOTAL_TIERS = 21;
const COINS_PER_TIER = 1_000_000;
const TOTAL_COINS = COINS_PER_TIER * TOTAL_TIERS;

const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));
const _rewardForTier = (n) => BASE_REWARD / Math.pow(2, n);

const tabs = [
  { label: 'Dashboard', key: 'dashboard' },
  { label: 'Log', key: 'log' },
  { label: 'Wallet', key: 'wallet' },
  { label: 'Governance', key: 'governance' },
  { label: 'Whitepaper', key: 'whitepaper' },
];

const LOG_STORAGE_KEY = 'wattcoin-mining-log-v3';
const MAX_PERSISTED_LOG_ENTRIES = 2000;
const TAB_BAR_HEIGHT_PX = 74;
const BALANCE_STORAGE_KEY = 'wattcoin-wallet-balances';
const ENERGY_STORAGE_KEY = 'wattcoin-mining-energy-wh';
const ENERGY_BY_ADDRESS_STORAGE_KEY = 'wattcoin-mining-energy-by-address-v1';
const SENT_TX_HISTORY_STORAGE_KEY = 'wattcoin-sent-transaction-history-v1';
const MAX_PERSISTED_SENT_TXS = 200;
const MINER_UNLOCK_STORAGE_KEY = 'wattcoin-miner-unlocked-v1';
const MINER_PROTECTED_TABS = new Set([]);

function loadPersistedLog() {
  try {
    const raw = localStorage.getItem(LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry === 'object');
  } catch (_) {
    return [];
  }
}

function loadPersistedBalances() {
  try {
    const raw = localStorage.getItem(BALANCE_STORAGE_KEY);
    if (!raw) return { coins: 0, maturedCoins: 0, unmaturedCoins: 0 };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { coins: 0, maturedCoins: 0, unmaturedCoins: 0 };
    }
    const coins = Math.max(0, Number(parsed.coins) || 0);
    const maturedCoins = Math.max(0, Number(parsed.maturedCoins) || 0);
    const unmaturedCoins = Math.max(0, Number(parsed.unmaturedCoins) || 0);
    return { coins, maturedCoins, unmaturedCoins };
  } catch (_) {
    return { coins: 0, maturedCoins: 0, unmaturedCoins: 0 };
  }
}

function loadPersistedEnergy() {
  try {
    const raw = localStorage.getItem(ENERGY_STORAGE_KEY);
    const parsed = Number(raw);
    return Math.max(0, Number.isFinite(parsed) ? parsed : 0);
  } catch (_) {
    return 0;
  }
}

function loadPersistedEnergyByAddress() {
  try {
    const raw = localStorage.getItem(ENERGY_BY_ADDRESS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const normalized = {};
    Object.entries(parsed).forEach(([address, value]) => {
      const key = typeof address === 'string' ? address.trim() : '';
      if (!key) return;
      const amount = Math.max(0, Number(value) || 0);
      normalized[key] = amount;
    });
    return normalized;
  } catch (_) {
    return {};
  }
}

function loadPersistedSentTransactions() {
  try {
    const raw = localStorage.getItem(SENT_TX_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        txid: typeof entry.txid === 'string' ? entry.txid : '',
        category: typeof entry.category === 'string' ? entry.category : 'send',
        direction: 'out',
        amount: Number(entry.amount) || 0,
        confirmations: Math.max(0, Number(entry.confirmations) || 0),
        address: typeof entry.address === 'string' ? entry.address : '',
        time: Number(entry.time) || 0,
        network: typeof entry.network === 'string' ? entry.network : 'regtest',
        selectedAddress: typeof entry.selectedAddress === 'string' ? entry.selectedAddress : '',
        localOnly: true,
      }));
  } catch (_) {
    return [];
  }
}

function loadPersistedMinerUnlock() {
  try {
    return localStorage.getItem(MINER_UNLOCK_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

function createDefaultWalletReadiness() {
  return {
    ok: false,
    status: 'syncing',
    message: 'Checking wallet sync status...',
    spendReady: false,
    blocks: 0,
    headers: 0,
    connections: 0,
    verificationProgress: 0,
    localBlocks: 0,
    bestPeerHeight: 0,
    lagBlocks: 0,
    bestPeer: '',
    scanning: false,
    initialBlockDownload: true,
    lastSyncResult: null,
    syncBlockedReason: '',
  };
}

function createDefaultWalletSyncState() {
  return {
    ok: false,
    nodeReady: false,
    rpcReachable: false,
    selectedAddress: '',
    addresses: [],
    walletReadiness: createDefaultWalletReadiness(),
    updatedAt: 0,
    reason: 'initial',
  };
}

export default function AppTabs() {
  const initialBalances = loadPersistedBalances();
  const initialEnergy = loadPersistedEnergy();
  const initialEnergyByAddress = loadPersistedEnergyByAddress();
  const [activeTab, setActiveTab] = useState('dashboard');

  useEffect(() => {
    const titles = {
      dashboard: 'Wattcoin — Mine | Energy-Backed Cryptocurrency',
      log: 'Wattcoin — Mining Log | Proof-of-Energy Activity',
      wallet: 'Wattcoin — Wallet | Send, Stake & Manage WTC',
      governance: 'Wattcoin — Governance | DAO Treasury & Vortex NFT Voting',
      whitepaper: 'Wattcoin — Whitepaper | Proof-of-Energy Cryptocurrency',
    };
    document.title = titles[activeTab] || 'Wattcoin — Energy-Backed Cryptocurrency';
  }, [activeTab]);

  function handleTabClick(key) {
    setActiveTab(key);
  }
  const [log, setLog] = useState(() => loadPersistedLog());
  const [probeLog, setProbeLog] = useState([]);

  // Load persisted probe log on mount
  useEffect(() => {
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    hw.invoke('wattcoin-get-probe-log')
      .then((res) => {
        if (res && Array.isArray(res.entries) && res.entries.length > 0) {
          setProbeLog(res.entries);
        }
      })
      .catch(() => {});
  }, []);

  // Save probe log to disk whenever it changes (debounced 3s)
  const probeLogSaveTimer = useRef(null);
  useEffect(() => {
    if (probeLog.length === 0) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    if (probeLogSaveTimer.current) clearTimeout(probeLogSaveTimer.current);
    probeLogSaveTimer.current = setTimeout(() => {
      hw.invoke('wattcoin-save-probe-log', probeLog).catch(() => {});
    }, 3000);
    return () => {
      if (probeLogSaveTimer.current) clearTimeout(probeLogSaveTimer.current);
    };
  }, [probeLog]);
  const [updateReady, setUpdateReady] = useState(null); // { version } when update downloaded
  const [updateInstallRequested, setUpdateInstallRequested] = useState(false);
  // Mining state moved here
  const [mining, setMining] = useState(false);
  const [coins, setCoins] = useState(initialBalances.coins);
  const [maturedCoins, setMaturedCoins] = useState(initialBalances.maturedCoins);
  const [unmaturedCoins, setUnmaturedCoins] = useState(initialBalances.unmaturedCoins);
  const [chainHeight, setChainHeight] = useState(-1);
  const [energyByAddress, setEnergyByAddress] = useState(() => {
    if (Object.keys(initialEnergyByAddress).length > 0) return initialEnergyByAddress;
    // Backward compatibility with old single-bucket estimate.
    if (initialEnergy > 0) return { __legacy__: initialEnergy };
    return {};
  });
  const [powerW, setPowerW] = useState(0); // NEW: actual power used
  const [hardwareLookupResetNonce, setHardwareLookupResetNonce] = useState(0);
  const [hwResetOnCooldown, setHwResetOnCooldown] = useState(false);
  const [hwResetCooldownRemainingMs, setHwResetCooldownRemainingMs] = useState(0);
  const [searchCacheOnCooldown, setSearchCacheOnCooldown] = useState(false);
  const [miningWarning, setMiningWarning] = useState(null);
  const [firewallBlocked, setFirewallBlocked] = useState(false);
  const [searchCacheCooldownRemainingMs, setSearchCacheCooldownRemainingMs] = useState(0);
  const [_betaPolicy, _setBetaPolicy] = useState({
    loading: true,
    betaMode: false,
    withdrawalsEnabled: true,
    resetWipePolicy: false,
    policyMessage: '',
  });
  const [minerAccessPolicy, setMinerAccessPolicy] = useState({
    loading: true,
    passwordRequired: false,
  });
  const [minerUnlocked, setMinerUnlocked] = useState(() => loadPersistedMinerUnlock());
  const [minerPassword, setMinerPassword] = useState('');
  const [minerUnlockBusy, setMinerUnlockBusy] = useState(false);
  const [minerUnlockError, setMinerUnlockError] = useState('');
  const [walletSyncState, setWalletSyncState] = useState(() => createDefaultWalletSyncState());
  const selectedWalletAddress = walletSyncState.selectedAddress || '';

  useEffect(() => {
    let cancelled = false;
    async function loadMinerAccessPolicy() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
        if (!cancelled) {
          setMinerAccessPolicy({ loading: false, passwordRequired: false });
          setMinerUnlocked(true);
        }
        return;
      }
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-miner-access-policy');
        if (cancelled || !(res && res.ok)) return;
        const passwordRequired = !!res.passwordRequired;
        setMinerAccessPolicy({ loading: false, passwordRequired });
        if (!passwordRequired) {
          setMinerUnlocked(true);
        }
      } catch (_) {
        if (!cancelled) {
          setMinerAccessPolicy({ loading: false, passwordRequired: false });
          setMinerUnlocked(true);
        }
      }
    }

    loadMinerAccessPolicy();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch hw-reset cooldown once on mount so the button shows correct state immediately.
  useEffect(() => {
    async function fetchHwResetCooldown() {
      try {
        const hw = window.wattcoinHardware;
        if (!(hw && hw.invoke)) return;
        const auth = await hw.invoke('wattcoin-get-authority-state').catch(() => null);
        if (auth && typeof auth.hwResetCooldownRemainingMs === 'number') {
          setHwResetOnCooldown(auth.hwResetOnCooldown || false);
          setHwResetCooldownRemainingMs(auth.hwResetCooldownRemainingMs || 0);
        }
        if (auth && typeof auth.searchCacheCooldownRemainingMs === 'number') {
          setSearchCacheOnCooldown(auth.searchCacheOnCooldown || false);
          setSearchCacheCooldownRemainingMs(auth.searchCacheCooldownRemainingMs || 0);
        }
      } catch (_) {
        /* non-fatal */
      }
    }
    fetchHwResetCooldown();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function checkFirewall() {
      try {
        const hw = window.wattcoinHardware;
        if (!hw || !hw.checkFirewallRule) return;

        // Re-check after update: the installer may have added the rule while the
        // old process was shutting down.  A fresh check ensures the UI reflects
        // the post-update state even if the initial mount check ran too early.
        const wasUpdated = typeof hw.wasUpdated === 'function' ? await hw.wasUpdated() : false;

        const result = await hw.checkFirewallRule();
        if (!cancelled) {
          if (result && result.windows && !result.exists) {
            if (result.errors) {
              console.warn('[Firewall] Detection errors:', result.errors);
            }
            if (wasUpdated) {
              // Just updated but rule still missing — retry once after a short
              // delay in case Windows is still applying the firewall policy.
              await new Promise((r) => setTimeout(r, 3000));
              if (cancelled) return;
              const retry = await hw.checkFirewallRule();
              if (retry && retry.windows && retry.exists) {
                setFirewallBlocked(false);
                return;
              }
            }
            setFirewallBlocked(true);
          } else {
            setFirewallBlocked(false);
          }
        }
      } catch (_) {
        if (!cancelled) setFirewallBlocked(false);
      }
    }
    checkFirewall();
    return () => {
      cancelled = true;
    };
  }, []);

  const [firewallHealing, setFirewallHealing] = useState(false);

  async function handleHealFirewall() {
    try {
      const hw = window.wattcoinHardware;
      if (!hw || typeof hw.healFirewall !== 'function') return;
      setFirewallHealing(true);
      const result = await hw.healFirewall();
      if (result && result.ok) {
        const recheck = await hw.checkFirewallRule();
        if (recheck && recheck.windows && recheck.exists) {
          setFirewallBlocked(false);
        }
      } else {
        console.warn('[Firewall] Heal failed:', result && result.reason ? result.reason : 'unknown');
      }
    } catch (e) {
      console.warn('[Firewall] Heal error:', e && e.message ? e.message : e);
    } finally {
      setFirewallHealing(false);
    }
  }

  useEffect(() => {
    try {
      if (minerUnlocked) {
        localStorage.setItem(MINER_UNLOCK_STORAGE_KEY, '1');
      } else {
        localStorage.removeItem(MINER_UNLOCK_STORAGE_KEY);
      }
    } catch (_) {
      // Ignore storage errors in restricted environments.
    }
  }, [minerUnlocked]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe = null;

    function applySnapshot(snapshot) {
      if (cancelled || !snapshot || typeof snapshot !== 'object') return;
      setWalletSyncState((prev) => ({
        ...prev,
        ...snapshot,
        walletReadiness: {
          ...createDefaultWalletReadiness(),
          ...(snapshot.walletReadiness || {}),
        },
      }));
    }

    async function loadWalletState() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.getWalletState)) return;
      try {
        const snapshot = await window.wattcoinHardware.getWalletState();
        applySnapshot(snapshot);
      } catch (_) {
        // Leave default disconnected state until the next push update.
      }
    }

    loadWalletState();
    if (window.wattcoinHardware && window.wattcoinHardware.onWalletState) {
      unsubscribe = window.wattcoinHardware.onWalletState(applySnapshot);
    }

    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const previousSelectedWalletAddressRef = useRef('');
  useEffect(() => {
    const previous = previousSelectedWalletAddressRef.current;
    const next = selectedWalletAddress || '';
    previousSelectedWalletAddressRef.current = next;
    if (!previous || !next || previous === next) return;
    setCoins(0);
    setMaturedCoins(0);
    setUnmaturedCoins(0);
  }, [selectedWalletAddress]);

  const handleSelectedWalletAddressChange = useCallback(
    async (address) => {
      const next = typeof address === 'string' ? address.trim() : '';
      if (!next || next === selectedWalletAddress) return;
      if (!(window.wattcoinHardware && window.wattcoinHardware.setPrimaryAddress)) return;
      try {
        const res = await window.wattcoinHardware.setPrimaryAddress(next);
        if (res && res.ok && res.snapshot) {
          setWalletSyncState((prev) => ({
            ...prev,
            ...res.snapshot,
            walletReadiness: {
              ...createDefaultWalletReadiness(),
              ...(res.snapshot.walletReadiness || {}),
            },
          }));
        }
      } catch (_) {
        // Best effort: pushed wallet-state updates will reconcile later.
      }
    },
    [selectedWalletAddress],
  );

  const miningRef = useRef(null);
  const protectedTabLocked =
    MINER_PROTECTED_TABS.has(activeTab) && minerAccessPolicy.passwordRequired && !minerUnlocked;

  async function handleUnlockProtectedTabs(event) {
    event.preventDefault();
    if (minerUnlockBusy) return;
    const candidate = minerPassword.trim();
    if (!candidate) {
      setMinerUnlockError('Enter the password to unlock this machine.');
      return;
    }
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setMinerUnlocked(true);
      setMinerUnlockError('');
      return;
    }
    setMinerUnlockBusy(true);
    setMinerUnlockError('');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-verify-miner-password', candidate);
      if (res && res.ok && res.authorized) {
        setMinerUnlocked(true);
        setMinerPassword('');
        setMinerUnlockError('');
        return;
      }
      setMinerUnlockError((res && res.message) || 'Invalid password.');
    } catch (_) {
      setMinerUnlockError('Unable to verify password right now.');
    } finally {
      setMinerUnlockBusy(false);
    }
  }

  // Node connection state
  const nodeConnecting = walletSyncState.rpcReachable === false;
  // Helper for timestamp
  const _now = () => new Date().toLocaleString('en-GB');
  const selectedAddressKey =
    (typeof selectedWalletAddress === 'string' ? selectedWalletAddress.trim() : '') || '__legacy__';
  const energy = Math.max(0, Number(energyByAddress[selectedAddressKey]) || 0);
  const setEnergy = useCallback(
    (updater) => {
      setEnergyByAddress((prev) => {
        const current = Math.max(0, Number(prev && prev[selectedAddressKey]) || 0);
        const nextRaw = typeof updater === 'function' ? updater(current) : updater;
        const next = Math.max(0, Number(nextRaw) || 0);
        return {
          ...(prev || {}),
          [selectedAddressKey]: next,
        };
      });
    },
    [selectedAddressKey],
  );

  const syncBalancesFromLedger = useCallback(async () => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-get-node-mined-coins', selectedWalletAddress || '');
      if (!(res && res.ok)) return;

      const total =
        typeof res.totalMinedCoins === 'number'
          ? res.totalMinedCoins
          : typeof res.minedCoins === 'number'
            ? res.minedCoins
            : 0;
      const matured =
        typeof res.maturedMinedCoins === 'number'
          ? res.maturedMinedCoins
          : typeof res.minedCoins === 'number'
            ? res.minedCoins
            : 0;
      const unmatured =
        typeof res.unmaturedMinedCoins === 'number' ? res.unmaturedMinedCoins : Math.max(0, total - matured);

      setCoins(Math.max(0, total));
      setMaturedCoins(Math.max(0, matured));
      setUnmaturedCoins(Math.max(0, unmatured));
      if (typeof res.blocks === 'number' && res.blocks >= -1) setChainHeight(res.blocks);
    } catch (_) {
      // Keep last values if node query fails temporarily.
    }
  }, [selectedWalletAddress]);

  // Listen for auto-update events from the main process.
  useEffect(() => {
    if (window.wattcoinHardware && window.wattcoinHardware.onUpdateDownloaded) {
      window.wattcoinHardware.onUpdateDownloaded((info) => {
        setUpdateInstallRequested(false);
        setUpdateReady(info);
      });
    }
  }, []);

  // Keep balances in sync with backend round-ledger state.
  useEffect(() => {
    let cancelled = false;

    async function syncWhenActive() {
      await syncBalancesFromLedger();
      if (cancelled) return;
    }

    syncWhenActive();
    const intervalMs = mining || activeTab === 'dashboard' || activeTab === 'wallet' ? 3000 : 15000;
    const interval = setInterval(syncWhenActive, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [syncBalancesFromLedger, mining, activeTab, minerUnlocked]);

  // Persist log entries so mining history survives app restarts.
  useEffect(() => {
    try {
      const compact = Array.isArray(log) ? log.slice(0, MAX_PERSISTED_LOG_ENTRIES) : [];
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(compact));
    } catch (_) {
      // Ignore storage errors in restricted environments.
    }
  }, [log]);

  // Keep a ref to the latest round contribution so the synchronous beforeunload
  // handler can include it without needing an async call at close time.
  const currentRoundWhRef = useRef(0);
  useEffect(() => {
    if (!mining) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    const poll = () => {
      hw.invoke('wattcoin-ledger-get-balances', selectedWalletAddress || '')
        .then((bal) => {
          if (bal && typeof bal.currentRoundContributionWh === 'number') {
            currentRoundWhRef.current = bal.currentRoundContributionWh;
          }
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, [mining, selectedWalletAddress]);

  // Ensure a stop event is persisted if the app closes while mining is active.
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!mining) return;
      const roundWh = currentRoundWhRef.current || 0;
      const roundWhStr =
        roundWh > 0
          ? ` (contributed ${roundWh >= 1000 ? (roundWh / 1000).toFixed(3) + ' kWh' : roundWh.toFixed(4) + ' Wh'} this round)`
          : '';
      const stopEntry = {
        time: new Date().toLocaleString('en-GB'),
        msg: `Mining stopped (app closed)${roundWhStr}.`,
        type: 'info',
      };
      try {
        const existing = Array.isArray(log) ? log : loadPersistedLog();
        const compact = [stopEntry, ...existing].slice(0, MAX_PERSISTED_LOG_ENTRIES);
        localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(compact));
      } catch (_) {
        // Ignore storage errors in restricted environments.
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [mining, log]);

  // Persist last known wallet balances so prior session values remain visible.
  useEffect(() => {
    try {
      localStorage.setItem(
        BALANCE_STORAGE_KEY,
        JSON.stringify({
          coins: Math.max(0, Number(coins) || 0),
          maturedCoins: Math.max(0, Number(maturedCoins) || 0),
          unmaturedCoins: Math.max(0, Number(unmaturedCoins) || 0),
        }),
      );
    } catch (_) {
      // Ignore storage errors in restricted environments.
    }
  }, [coins, maturedCoins, unmaturedCoins]);

  // Persist Wattcoin mining progress so pending WTC survives app restarts.
  useEffect(() => {
    try {
      localStorage.setItem(ENERGY_STORAGE_KEY, String(Math.max(0, Number(energy) || 0)));
      localStorage.setItem(ENERGY_BY_ADDRESS_STORAGE_KEY, JSON.stringify(energyByAddress || {}));
    } catch (_) {
      // Ignore storage errors in restricted environments.
    }
  }, [energy, energyByAddress]);

  // Mining effect at parent level
  useEffect(() => {
    if (!mining) {
      setMiningWarning(null);
      return;
    }
    let ipcInFlight = false;
    const tickSeconds = 0.25;
    miningRef.current = setInterval(() => {
      if (ipcInFlight) return;
      const energyDeltaWh = (powerW * tickSeconds) / 3600;

      if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
        ipcInFlight = true;
        window.wattcoinHardware
          .invoke('wattcoin-ledger-add-contribution', selectedWalletAddress || '', energyDeltaWh)
          .then((res) => {
            if (res && res.ok) {
              setEnergy((ePrev) => ePrev + energyDeltaWh);
              setMiningWarning(null);
            } else if (res && res.code) {
              const warnings = {
                HW_CHANGED:
                  'Mining blocked — hardware changed on this wallet. Use Reset Hardware to accept the new hardware.',
                HW_HOLD: `Mining suspended — ${res.message || 'hardware trust violations.'}`,
                NEVER_BENCHMARKED: 'Mining blocked — complete a full hardware benchmark first.',
                NO_PEERS: 'Mining paused — waiting for peer connection.',
                LEDGER_ADD_FAILED: 'Mining error — contribution rejected. Restart the miner or check logs.',
                RATE_LIMIT_LOCKED: 'Mining rate-limited — too many requests. Waiting for cooldown.',
                RATE_LIMIT_EXCEEDED: 'Mining rate-limited — too many requests. Cooldown applied.',
              };
              setMiningWarning({
                code: res.code,
                message: warnings[res.code] || `Mining blocked — ${res.message || 'unknown reason'}.`,
              });
            }
          })
          .catch(() => {})
          .finally(() => {
            ipcInFlight = false;
          });
      }
    }, tickSeconds * 1000);
    return () => {
      clearInterval(miningRef.current);
      // Sync the Energy Used card to the ledger's confirmed value on stop.
      if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
        window.wattcoinHardware
          .invoke('wattcoin-ledger-get-balances', selectedWalletAddress || '')
          .then((bal) => {
            if (bal && typeof bal.currentRoundContributionWh === 'number') {
              setEnergy(bal.currentRoundContributionWh);
            }
          })
          .catch(() => {});
      }
    };
  }, [mining, powerW, setEnergy, selectedWalletAddress]);

  const handleBlockMined = useCallback(
    async (minedInfo) => {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
      const payload = {
        blockHash: minedInfo && minedInfo.blockHash ? String(minedInfo.blockHash) : '',
        minedAddress: minedInfo && minedInfo.address ? String(minedInfo.address) : selectedWalletAddress || '',
        proofIssues: Array.isArray(minedInfo && minedInfo.proofIssues) ? minedInfo.proofIssues : [],
        proofCommitment: minedInfo && minedInfo.proofCommitment ? String(minedInfo.proofCommitment) : null,
        rewardCoins: Number(minedInfo && minedInfo.reward) || 0,
        // Item 1: coordinator-side CPU/mem proof re-verification fields.
        cpuSpeedInitialSeed: Number(minedInfo && minedInfo.cpuSpeedInitialSeed) || 0,
        cpuSpeedProof: String((minedInfo && minedInfo.cpuSpeedProof) || ''),
        memProof: String((minedInfo && minedInfo.memProof) || ''),
        // Item 4: whether a peer probe was verified during this round.
        peerProbeVerified: !!(minedInfo && minedInfo.peerProbeVerified),
        // Item 5: signed receipt from the coordinator's peer probe.
        probeReceipt:
          minedInfo && minedInfo.probeReceipt && typeof minedInfo.probeReceipt === 'object'
            ? minedInfo.probeReceipt
            : null,
        contributionsWh:
          minedInfo && minedInfo.contributionsWh && typeof minedInfo.contributionsWh === 'object'
            ? minedInfo.contributionsWh
            : null,
      };
      try {
        await window.wattcoinHardware.invoke('wattcoin-ledger-settle-round', payload);
      } catch (_) {
        // Keep UI running even if settle call fails transiently.
      }
      await syncBalancesFromLedger();
    },
    [selectedWalletAddress, syncBalancesFromLedger],
  );

  // Stop mining if coins reach cap
  useEffect(() => {
    if (coins >= TOTAL_COINS && mining) setMining(false);
  }, [coins, mining]);

  // Poll total purchased WTC for the current address (for tier status bar)
  const [purchasedWtc, setPurchasedWtc] = useState(0);
  useEffect(() => {
    if (!selectedWalletAddress || !(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    let cancelled = false;
    function loadPurchaseTotal() {
      window.wattcoinHardware
        .invoke('wattcoin-sale-get-purchase-total', selectedWalletAddress)
        .then((res) => {
          if (!cancelled && res && res.ok) setPurchasedWtc(Number(res.total) || 0);
        })
        .catch(() => {});
    }
    loadPurchaseTotal();
    const iv = setInterval(loadPurchaseTotal, 30_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [selectedWalletAddress]);

  return (
    <div style={{ minHeight: '100vh', background: '#060e06' }}>
      <nav
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1100,
          display: 'flex',
          gap: 0,
          borderBottom: '2px solid #1e3a1e',
          background: '#0d1a0d',
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => handleTabClick(tab.key)}
            style={{
              flex: 1,
              padding: '18px 0',
              background: activeTab === tab.key ? '#1e3a1e' : '#0d1a0d',
              color: activeTab === tab.key ? '#4ade80' : '#e8f5e8',
              border: 'none',
              borderBottom: activeTab === tab.key ? '2px solid #4ade80' : '2px solid transparent',
              fontWeight: 700,
              fontSize: 18,
              letterSpacing: '0.08em',
              cursor: 'pointer',
              transition: 'background 0.2s, color 0.2s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      {/* Node connection notification */}
      {updateReady && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: nodeConnecting ? 60 : 0,
            zIndex: 1001,
            background: '#0d2b0d',
            color: '#4ade80',
            fontWeight: 700,
            fontSize: 15,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 16,
            padding: '12px 16px',
            borderTop: '2px solid #4ade80',
          }}
        >
          <span>
            {updateInstallRequested
              ? `Installing update v${updateReady.version}...`
              : `Update v${updateReady.version} ready to install`}
          </span>
          <button
            onClick={() => {
              if (!window.wattcoinHardware || !window.wattcoinHardware.installUpdate || updateInstallRequested) return;
              setUpdateInstallRequested(true);
              window.wattcoinHardware.installUpdate().catch(() => {
                setUpdateInstallRequested(false);
              });
            }}
            disabled={updateInstallRequested}
            style={{
              background: '#4ade80',
              color: '#060e06',
              border: 'none',
              borderRadius: 6,
              padding: '6px 18px',
              fontWeight: 700,
              fontSize: 14,
              cursor: updateInstallRequested ? 'wait' : 'pointer',
              opacity: updateInstallRequested ? 0.7 : 1,
            }}
          >
            {updateInstallRequested ? 'Starting installer...' : 'Restart & Install'}
          </button>
          <button
            onClick={() => {
              if (updateInstallRequested) return;
              setUpdateReady(null);
            }}
            disabled={updateInstallRequested}
            style={{
              background: 'transparent',
              color: '#86efac',
              border: '1px solid #4ade80',
              borderRadius: 6,
              padding: '5px 12px',
              fontWeight: 600,
              fontSize: 13,
              cursor: updateInstallRequested ? 'default' : 'pointer',
              opacity: updateInstallRequested ? 0.5 : 1,
            }}
          >
            Later
          </button>
        </div>
      )}
      {nodeConnecting && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1000,
            background: '#1e3a1e',
            color: '#fbbf24',
            fontWeight: 700,
            fontSize: 18,
            textAlign: 'center',
            padding: '16px 0',
            borderTop: '2px solid #4ade80',
            letterSpacing: '0.06em',
          }}
        >
          Node connecting... Please wait
        </div>
      )}
      {miningWarning && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: (updateReady ? 60 : 0) + (nodeConnecting ? 60 : 0),
            zIndex: 1001,
            background: '#3a1a1a',
            color: '#fbbf24',
            fontWeight: 700,
            fontSize: 14,
            textAlign: 'center',
            padding: '10px 16px',
            borderTop: '2px solid #f59e0b',
          }}
        >
          {miningWarning.message}
        </div>
      )}
      <div style={{ paddingTop: `${TAB_BAR_HEIGHT_PX}px` }}>
        <div style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }}>
          {protectedTabLocked ? (
            <ProtectedTabUnlock
              busy={minerUnlockBusy || minerAccessPolicy.loading}
              password={minerPassword}
              error={minerUnlockError}
              onPasswordChange={setMinerPassword}
              onSubmit={handleUnlockProtectedTabs}
            />
          ) : (
            <Miner
              mining={mining}
              setMining={setMining}
              coins={coins}
              maturedCoins={maturedCoins}
              unmaturedCoins={unmaturedCoins}
              setCoins={setCoins}
              energy={energy}
              setEnergy={setEnergy}
              log={log}
              setLog={setLog}
              probeLog={probeLog}
              setProbeLog={setProbeLog}
              isActive={activeTab === 'dashboard'}
              setPowerW={setPowerW} // NEW: pass setter for powerW
              miningAddress={selectedWalletAddress}
              onBlockMined={handleBlockMined}
              chainHeight={chainHeight}
              hardwareLookupResetNonce={hardwareLookupResetNonce}
              firewallBlocked={firewallBlocked}
              firewallHealing={firewallHealing}
              onHealFirewall={firewallBlocked ? handleHealFirewall : undefined}
            />
          )}
        </div>
        <div style={{ display: activeTab === 'log' ? 'block' : 'none' }}>
          {protectedTabLocked ? (
            <ProtectedTabUnlock
              busy={minerUnlockBusy || minerAccessPolicy.loading}
              password={minerPassword}
              error={minerUnlockError}
              onPasswordChange={setMinerPassword}
              onSubmit={handleUnlockProtectedTabs}
            />
          ) : (
            <MiningLog
              log={log}
              probeLog={probeLog}
              hwResetOnCooldown={hwResetOnCooldown}
              hwResetCooldownRemainingMs={hwResetCooldownRemainingMs}
              searchCacheOnCooldown={searchCacheOnCooldown}
              searchCacheCooldownRemainingMs={searchCacheCooldownRemainingMs}
              onClearLog={() => {
                setLog([]);
                setProbeLog([]);
                try {
                  localStorage.removeItem(LOG_STORAGE_KEY);
                } catch (_) {
                  /* istanbul ignore next */
                }
                try {
                  const hw = window.wattcoinHardware;
                  if (hw && hw.invoke) {
                    hw.invoke('wattcoin-save-probe-log', []);
                    hw.invoke('wattcoin-clear-probe-history');
                  }
                } catch (_) {
                  /* istanbul ignore next */
                }
              }}
              onClearSearchCache={async () => {
                try {
                  const hw = window.wattcoinHardware;
                  const result = hw && hw.invoke ? await hw.invoke('wattcoin-clear-search-cache') : null;
                  if (result && result.ok === false && result.reason === 'cooldown') {
                    const remainingMs = result.cooldownRemainingMs || 0;
                    const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
                    const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                    const timeStr =
                      days > 0
                        ? `${days} day${days !== 1 ? 's' : ''} and ${hours} hour${hours !== 1 ? 's' : ''}`
                        : `${hours} hour${hours !== 1 ? 's' : ''}`;
                    setSearchCacheOnCooldown(true);
                    setSearchCacheCooldownRemainingMs(remainingMs);
                    setLog((prev) => [
                      {
                        time: new Date().toLocaleString('en-GB'),
                        msg: `Search cache clear is on a 3-day cooldown. Available again in ${timeStr}.`,
                        type: 'warn',
                      },
                      ...prev,
                    ]);
                    return;
                  }
                  try {
                    localStorage.removeItem('wattcoin-online-tdp-v2');
                    localStorage.removeItem('wattcoin-online-cpu-tdp-v2');
                    localStorage.removeItem('wattcoin-online-laptop-power-v8');
                  } catch (_) {
                    /* istanbul ignore next */
                  }
                  setHardwareLookupResetNonce((value) => value + 1);
                  const nextAllowedMs =
                    result && result.nextClearAllowedAtMs
                      ? result.nextClearAllowedAtMs
                      : Date.now() + 3 * 24 * 60 * 60 * 1000;
                  setSearchCacheOnCooldown(true);
                  setSearchCacheCooldownRemainingMs(nextAllowedMs - Date.now());
                  setLog((prev) => [
                    {
                      time: new Date().toLocaleString('en-GB'),
                      msg: 'TDP search cache cleared. Fresh hardware lookup data will be fetched on next benchmark. Next clear available in 3 days.',
                      type: 'info',
                    },
                    ...prev,
                  ]);
                } catch (error) {
                  setLog((prev) => [
                    {
                      time: new Date().toLocaleString('en-GB'),
                      msg: `Search cache clear failed: ${error && error.message ? error.message : String(error)}`,
                      type: 'error',
                    },
                    ...prev,
                  ]);
                }
              }}
              onResetHardware={async () => {
                try {
                  const hw = window.wattcoinHardware;
                  const result = hw && hw.invoke ? await hw.invoke('wattcoin-reset-hardware-identity') : null;
                  // Cooldown active — backend refused the reset.
                  if (result && result.ok === false && result.reason === 'cooldown') {
                    const remainingMs = result.cooldownRemainingMs || 0;
                    const days = Math.floor(remainingMs / (24 * 60 * 60 * 1000));
                    const hours = Math.floor((remainingMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
                    const timeStr =
                      days > 0
                        ? `${days} day${days !== 1 ? 's' : ''} and ${hours} hour${hours !== 1 ? 's' : ''}`
                        : `${hours} hour${hours !== 1 ? 's' : ''}`;
                    setHwResetOnCooldown(true);
                    setHwResetCooldownRemainingMs(remainingMs);
                    setLog((prev) => [
                      {
                        time: new Date().toLocaleString('en-GB'),
                        msg: `Hardware reset is on a 7-day cooldown. Available again in ${timeStr}.`,
                        type: 'warn',
                      },
                      ...prev,
                    ]);
                    return;
                  }
                  try {
                    localStorage.removeItem('wattcoin-online-tdp-v2');
                    localStorage.removeItem('wattcoin-online-cpu-tdp-v2');
                    localStorage.removeItem('wattcoin-online-laptop-power-v8');
                  } catch (_) {
                    /* istanbul ignore next */
                  }
                  setHardwareLookupResetNonce((value) => value + 1);
                  // Activate cooldown in UI immediately after a successful reset.
                  const nextAllowedMs =
                    result && result.nextResetAllowedAtMs
                      ? result.nextResetAllowedAtMs
                      : Date.now() + 7 * 24 * 60 * 60 * 1000;
                  setHwResetOnCooldown(true);
                  setHwResetCooldownRemainingMs(nextAllowedMs - Date.now());
                  const previousFingerprint =
                    result && result.previousFingerprint && typeof result.previousFingerprint === 'object'
                      ? result.previousFingerprint
                      : null;
                  const parts = [];
                  if (previousFingerprint) {
                    if (previousFingerprint.cpuModel) parts.push(`CPU ${previousFingerprint.cpuModel}`);
                    if (Array.isArray(previousFingerprint.gpuModels) && previousFingerprint.gpuModels.length > 0)
                      parts.push(`GPU ${previousFingerprint.gpuModels.join(', ')}`);
                    if (
                      previousFingerprint.memType ||
                      previousFingerprint.memSpeedMhz ||
                      previousFingerprint.memSticks
                    ) {
                      parts.push(
                        `Memory ${previousFingerprint.memType || 'unknown'} ${previousFingerprint.memSpeedMhz || 0} MHz x${previousFingerprint.memSticks || 0}`,
                      );
                    }
                  }
                  setLog((prev) => [
                    {
                      time: new Date().toLocaleString('en-GB'),
                      msg: `Hardware identity reset. ${parts.length ? `Previous baseline: ${parts.join(' • ')}. ` : ''}A fresh benchmark will adopt the current CPU, GPU, and memory configuration without requiring a new wallet. Next reset allowed in 7 days.`,
                      type: 'warn',
                    },
                    ...prev,
                  ]);
                } catch (error) {
                  setLog((prev) => [
                    {
                      time: new Date().toLocaleString('en-GB'),
                      msg: `Hardware reset failed: ${error && error.message ? error.message : String(error)}`,
                      type: 'error',
                    },
                    ...prev,
                  ]);
                }
              }}
            />
          )}
        </div>
        {activeTab === 'governance' && (
          <div style={{ height: `calc(100vh - ${TAB_BAR_HEIGHT_PX}px)`, overflowY: 'auto' }}>
            <Governance selectedWalletAddress={selectedWalletAddress} />
          </div>
        )}
        {activeTab === 'whitepaper' && (
          <div style={{ height: `calc(100vh - ${TAB_BAR_HEIGHT_PX}px)`, overflowY: 'auto' }}>
            <Wattcoin />
          </div>
        )}
        {activeTab === 'wallet' && (
          <WalletTab
            coins={coins}
            maturedCoins={maturedCoins}
            unmaturedCoins={unmaturedCoins}
            energy={energy}
            selectedWalletAddress={selectedWalletAddress}
            walletSyncState={walletSyncState}
            refreshBalances={syncBalancesFromLedger}
            onAddressChange={handleSelectedWalletAddressChange}
            purchasedWtc={purchasedWtc}
          />
        )}
      </div>
    </div>
  );
}

function ProtectedTabUnlock({ busy, password, error, onPasswordChange, onSubmit }) {
  return (
    <div
      style={{
        minHeight: `calc(100vh - ${TAB_BAR_HEIGHT_PX}px)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#060e06',
        padding: 24,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: '100%',
          maxWidth: 420,
          background: '#060e06',
          border: '1px solid #1e3a1e',
          borderRadius: 14,
          padding: 24,
        }}
      >
        <div style={{ color: '#e8f5e8', fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Password Required</div>
        <div style={{ color: '#7aaa7a', fontSize: 13, marginBottom: 16 }}>
          This machine must be unlocked once before Dashboard and Log are accessible.
        </div>
        <input
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
          placeholder="Enter password"
          autoComplete="current-password"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            background: '#0d160d',
            border: '1px solid #2d4a2d',
            borderRadius: 8,
            padding: '12px 14px',
            color: '#e8f5e8',
            fontFamily: 'monospace',
            fontSize: 14,
            outline: 'none',
            marginBottom: 12,
          }}
        />
        {error ? <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: 12 }}>{error}</div> : null}
        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%',
            background: busy ? '#1e3a1e' : '#4ade80',
            color: busy ? '#7aaa7a' : '#001008',
            border: 'none',
            borderRadius: 8,
            padding: '12px 16px',
            fontWeight: 700,
            fontSize: 14,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Checking...' : 'Unlock This Machine'}
        </button>
      </form>
    </div>
  );
}

// Wallet address display component with dropdown menu
function WalletAddressDisplay({ selectedWalletAddress, walletSyncState, onAddressChange }) {
  const address = selectedWalletAddress || '';
  const addresses = Array.isArray(walletSyncState && walletSyncState.addresses) ? walletSyncState.addresses : [];
  const status = address
    ? ''
    : ((walletSyncState && walletSyncState.walletReadiness && walletSyncState.walletReadiness.message) || '').trim() ||
      'Node connecting...';
  const [showDeleteModal, setShowDeleteModal] = React.useState(false);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const [deleteMessage, setDeleteMessage] = React.useState('');
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [addressCopied, setAddressCopied] = React.useState(false);
  const [showBackupModal, setShowBackupModal] = React.useState(false);
  const [backupPassphrase, setBackupPassphrase] = React.useState('');
  const [backupBusy, setBackupBusy] = React.useState(false);
  const [backupMessage, setBackupMessage] = React.useState('');
  const [showRestoreModal, setShowRestoreModal] = React.useState(false);
  const [restorePassphrase, setRestorePassphrase] = React.useState('');
  const [restoreBusy, setRestoreBusy] = React.useState(false);
  const [restoreMessage, setRestoreMessage] = React.useState('');
  const [restoreNeedsForce, setRestoreNeedsForce] = React.useState(false);
  const [restoreBackupPath, setRestoreBackupPath] = React.useState('');
  const [createBusy, setCreateBusy] = React.useState(false);
  const [createMessage, setCreateMessage] = React.useState('');
  const [addressNicknames, setAddressNicknames] = React.useState(() => {
    try {
      return JSON.parse(localStorage.getItem('wattcoin-address-nicknames') || '{}');
    } catch (_) {
      return {};
    }
  });
  const [editingNickname, setEditingNickname] = React.useState(null);
  const [nicknameInput, setNicknameInput] = React.useState('');

  function saveNicknames(updated) {
    setAddressNicknames(updated);
    try {
      localStorage.setItem('wattcoin-address-nicknames', JSON.stringify(updated));
    } catch (_) {
      /* istanbul ignore next */
    }
  }
  function startEditingNickname() {
    setNicknameInput(addressNicknames[address] || '');
    setEditingNickname(address);
  }
  function commitNickname() {
    const trimmed = nicknameInput.trim();
    const updated = { ...addressNicknames };
    if (trimmed) updated[address] = trimmed;
    else delete updated[address];
    saveNicknames(updated);
    setEditingNickname(null);
  }

  async function handleCreateAddress() {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setCreateMessage('Wallet API unavailable.');
      return;
    }
    setCreateBusy(true);
    setCreateMessage('Creating address...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-create-address');
      if (res && res.ok && res.address) {
        if (typeof onAddressChange === 'function') await onAddressChange(res.address);
        setDropdownOpen(false);
        setCreateMessage('');
      } else {
        setCreateMessage(`Error: ${res && res.message ? res.message : 'Failed to create address'}`);
      }
    } catch (e) {
      setCreateMessage(`Error: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setCreateBusy(false);
  }

  function handleDeleteAddressPrompt() {
    setDeleteMessage('');
    setDeleteBusy(false);
    setShowDeleteModal(true);
  }

  async function doDeleteActiveAddress() {
    const active = (address || '').trim();
    if (!active) {
      setDeleteMessage('No active mining address selected.');
      return;
    }
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setDeleteMessage('Wallet API unavailable.');
      return;
    }

    setDeleteBusy(true);
    setDeleteMessage('Deleting address from wallet list...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-delete-address', active);
      if (res && res.ok) {
        setDeleteMessage('Address removed from wallet list. It is recoverable via wallet backup restore.');
        setDeleteBusy(false);
        return;
      }
      setDeleteMessage(`Delete failed: ${res && res.message ? res.message : 'Unknown error'}`);
    } catch (e) {
      setDeleteMessage(`Delete failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setDeleteBusy(false);
  }

  function handleExportBackup() {
    setBackupPassphrase('');
    setBackupMessage('');
    setBackupBusy(false);
    setShowBackupModal(true);
  }

  async function doExportBackup() {
    if (!(window.wattcoinHardware && window.wattcoinHardware.exportWalletBackup)) {
      setBackupMessage('Wallet backup API unavailable.');
      return;
    }
    if (backupPassphrase.length < 8) {
      setBackupMessage('Passphrase must be at least 8 characters.');
      return;
    }
    setBackupBusy(true);
    setBackupMessage('Exporting…');
    try {
      const res = await window.wattcoinHardware.exportWalletBackup({ passphrase: backupPassphrase });
      if (res && res.ok) {
        setBackupMessage(`Backup exported!\n\nSaved to: ${res.filePath}`);
        setBackupBusy(false);
        return;
      }
      if (res && res.code === 'CANCELED') {
        setShowBackupModal(false);
      } else {
        setBackupMessage(`Backup failed: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setBackupMessage(`Backup failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setBackupBusy(false);
  }

  function handleRestoreBackup() {
    setRestorePassphrase('');
    setRestoreMessage('');
    setRestoreNeedsForce(false);
    setRestoreBackupPath('');
    setRestoreBusy(false);
    setShowRestoreModal(true);
  }

  async function doRestoreBackup(forceOverwrite) {
    if (!(window.wattcoinHardware && window.wattcoinHardware.restoreWalletBackup)) {
      setRestoreMessage('Wallet restore API unavailable.');
      return;
    }
    if (restorePassphrase.length < 8) {
      setRestoreMessage('Passphrase must be at least 8 characters.');
      return;
    }
    setRestoreBusy(true);
    setRestoreMessage('Restoring…');
    try {
      const res = await window.wattcoinHardware.restoreWalletBackup({
        passphrase: restorePassphrase,
        allowOverwrite: !!forceOverwrite,
        backupPath: restoreBackupPath || undefined,
      });
      if (res && res.code === 'WALLET_EXISTS') {
        if (res.backupPath) {
          setRestoreBackupPath(res.backupPath);
        }
        setRestoreNeedsForce(true);
        setRestoreMessage('A wallet already exists. Click "Overwrite & Restore" to replace it.');
        setRestoreBusy(false);
        return;
      }
      if (res && res.code === 'CANCELED') {
        setRestoreBackupPath('');
        setShowRestoreModal(false);
      } else if (res && res.ok) {
        if (res.filePath) {
          setRestoreBackupPath(res.filePath);
        }
        setRestoreMessage('Wallet restored! Node restarted and wallet reloaded.');
      } else {
        setRestoreMessage(`Restore failed: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setRestoreMessage(`Restore failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setRestoreBusy(false);
  }

  async function handleAddressSelect(addr) {
    if (typeof onAddressChange === 'function') await onAddressChange(addr);
    setDropdownOpen(false);
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: '#a7ffb0', fontWeight: 600, marginBottom: 5 }}>Mining address:</div>

      {/* Address row: nickname | dropdown | copy */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        {/* Nickname column */}
        {address && (
          <div style={{ flexShrink: 0, width: 102, display: 'flex', alignItems: 'flex-start' }}>
            {editingNickname === address ? (
              <div style={{ display: 'flex', gap: 2, width: '100%' }}>
                <input
                  autoFocus
                  value={nicknameInput}
                  onChange={(e) => setNicknameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitNickname();
                    if (e.key === 'Escape') setEditingNickname(null);
                  }}
                  placeholder="Nickname"
                  maxLength={20}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '5px 6px',
                    borderRadius: 6,
                    border: '1px solid #4ade80',
                    background: '#0d1a0d',
                    color: '#d7ffd9',
                    fontSize: 12,
                    outline: 'none',
                  }}
                />
                <button
                  onClick={commitNickname}
                  title="Save"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#4ade80',
                    cursor: 'pointer',
                    padding: '4px 4px',
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  ✓
                </button>
                <button
                  onClick={() => setEditingNickname(null)}
                  title="Cancel"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#9ac79f',
                    cursor: 'pointer',
                    padding: '4px 2px',
                    fontSize: 14,
                    lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={startEditingNickname}
                title={addressNicknames[address] ? 'Edit nickname' : 'Set nickname'}
                style={{
                  background: addressNicknames[address] ? '#1a351a' : 'none',
                  border: addressNicknames[address] ? '1px solid #2d5a2d' : '1px dashed #3a5a3a',
                  borderRadius: 6,
                  color: addressNicknames[address] ? '#86efac' : '#4a7a4a',
                  padding: '5px 8px',
                  fontSize: 12,
                  cursor: 'pointer',
                  maxWidth: 100,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  width: '100%',
                  textAlign: 'left',
                  lineHeight: 1.3,
                }}
              >
                {addressNicknames[address] || '✎ name'}
              </button>
            )}
          </div>
        )}

        {/* Dropdown column */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            style={{
              fontFamily: 'monospace',
              fontSize: 13,
              background: '#1e3a1e',
              color: '#4ade80',
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid #4ade80',
              cursor: 'pointer',
              textAlign: 'left',
              whiteSpace: 'nowrap',
              lineHeight: 1.3,
            }}
          >
            {address || status} ▼
          </button>

          {/* Dropdown menu */}
          {dropdownOpen && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                background: '#0d1a0d',
                border: '2px solid #4ade80',
                borderRadius: 8,
                marginTop: 4,
                zIndex: 1000,
                width: '100%',
                maxHeight: 220,
                overflowY: 'auto',
                boxShadow: '0 4px 16px #0008',
              }}
            >
              {addresses.length > 0 ? (
                addresses.map((addr, idx) => (
                  <div
                    key={idx}
                    onClick={() => handleAddressSelect(addr)}
                    style={{
                      padding: '7px 12px',
                      cursor: 'pointer',
                      background: addr === address ? '#1e3a1e' : 'transparent',
                      borderBottom: idx < addresses.length - 1 ? '1px solid #1a2e1a' : 'none',
                    }}
                  >
                    {addressNicknames[addr] && (
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: addr === address ? '#4ade80' : '#86efac',
                          marginBottom: 2,
                          fontFamily: 'inherit',
                        }}
                      >
                        {addressNicknames[addr]}
                      </div>
                    )}
                    <div
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: addr === address ? '#a7ffb0' : '#708870',
                        wordBreak: 'break-all',
                        lineHeight: 1.3,
                      }}
                    >
                      {addr}
                    </div>
                  </div>
                ))
              ) : (
                <div style={{ padding: '10px 12px', color: '#9bb09b', fontSize: 12, fontStyle: 'italic' }}>
                  No saved addresses yet. Click + New Address.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Copy address button — ghost icon, no border */}
        {address && (
          <button
            onClick={() => {
              navigator.clipboard
                .writeText(address)
                .then(() => {
                  setAddressCopied(true);
                  setTimeout(() => setAddressCopied(false), 1500);
                })
                .catch(() => {});
            }}
            title="Copy mining address"
            style={{
              flexShrink: 0,
              background: 'none',
              color: addressCopied ? '#86efac' : '#4ade80',
              border: 'none',
              borderRadius: 6,
              padding: '6px 6px',
              fontSize: 16,
              cursor: 'pointer',
              lineHeight: 1,
              transition: 'color 0.2s',
              opacity: addressCopied ? 1 : 0.7,
            }}
          >
            {addressCopied ? '✓' : '⧉'}
          </button>
        )}
      </div>

      {/* Control buttons */}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={handleCreateAddress}
          disabled={createBusy}
          style={{
            background: createBusy ? '#2d7a50' : '#4ade80',
            color: '#000',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: createBusy ? 'default' : 'pointer',
            fontWeight: 600,
            fontSize: 12,
            opacity: createBusy ? 0.7 : 1,
          }}
        >
          {createBusy ? 'Creating...' : '+ New Address'}
        </button>

        <button
          onClick={handleDeleteAddressPrompt}
          style={{
            background: '#f59e0b',
            color: '#1f1100',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Delete Address
        </button>

        <button
          onClick={handleExportBackup}
          style={{
            background: '#60a5fa',
            color: '#001018',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Backup Wallet
        </button>

        <button
          onClick={handleRestoreBackup}
          style={{
            background: '#fb7185',
            color: '#2b0000',
            padding: '6px 12px',
            border: 'none',
            borderRadius: 6,
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Restore Wallet
        </button>
      </div>

      {createMessage && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: createMessage.startsWith('Error') ? '#f87171' : '#86efac',
            padding: '4px 0',
          }}
        >
          {createMessage}
        </div>
      )}

      {showDeleteModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#241205',
              border: '2px solid #f59e0b',
              borderRadius: 12,
              padding: 24,
              minWidth: 360,
              maxWidth: 520,
              color: '#fef3c7',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 10, color: '#f59e0b' }}>
              Delete Active Mining Address
            </div>
            <div style={{ fontSize: 13, marginBottom: 12, color: '#fde68a', whiteSpace: 'pre-wrap' }}>
              {`Active address:\n${address || '(none)'}`}
            </div>
            <div style={{ fontSize: 13, marginBottom: 12, color: '#fecaca' }}>
              Warning: this removes the currently active mining address from this wallet list. It is recoverable. Make
              sure you have a recovery backup file before continuing.
            </div>
            {deleteMessage && (
              <div
                style={{
                  fontSize: 12,
                  marginBottom: 10,
                  color: deleteMessage.startsWith('Address removed') ? '#4ade80' : '#fca5a5',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {deleteMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleteBusy}
                style={{
                  padding: '7px 16px',
                  borderRadius: 6,
                  border: '1px solid #7c2d12',
                  background: 'transparent',
                  color: '#fcd34d',
                  cursor: deleteBusy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {deleteMessage.startsWith('Address removed') ? 'Close' : 'Cancel'}
              </button>
              {!deleteMessage.startsWith('Address removed') && (
                <button
                  onClick={() => doDeleteActiveAddress()}
                  disabled={deleteBusy || !address}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: deleteBusy || !address ? '#7c2d12' : '#f59e0b',
                    color: deleteBusy || !address ? '#fcd34d' : '#1f1100',
                    cursor: deleteBusy || !address ? 'default' : 'pointer',
                    fontWeight: 700,
                    fontSize: 13,
                  }}
                >
                  {deleteBusy ? 'Deleting...' : 'Delete Address'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Backup Wallet modal */}
      {showBackupModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#0a1a2a',
              border: '2px solid #60a5fa',
              borderRadius: 12,
              padding: 28,
              minWidth: 360,
              maxWidth: 460,
              color: '#e8f5e8',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12, color: '#60a5fa' }}>Backup Wallet</div>
            <div style={{ fontSize: 13, marginBottom: 14, color: '#94a3b8' }}>
              Enter a passphrase to encrypt your backup file. You will need this passphrase to restore.
            </div>
            <input
              type="password"
              placeholder="Passphrase (min 8 characters)"
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !backupBusy) doExportBackup();
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #60a5fa',
                background: '#0d2233',
                color: '#e8f5e8',
                fontSize: 13,
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
              autoFocus
              disabled={backupBusy}
            />
            {backupMessage && (
              <div
                style={{
                  fontSize: 12,
                  marginBottom: 10,
                  color: backupMessage.startsWith('Backup exported') ? '#4ade80' : '#f87171',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {backupMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowBackupModal(false)}
                disabled={backupBusy}
                style={{
                  padding: '7px 16px',
                  borderRadius: 6,
                  border: '1px solid #334155',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: backupBusy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {backupMessage.startsWith('Backup exported') ? 'Close' : 'Cancel'}
              </button>
              {!backupMessage.startsWith('Backup exported') && (
                <button
                  onClick={() => doExportBackup()}
                  disabled={backupBusy || backupPassphrase.length < 8}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: backupBusy || backupPassphrase.length < 8 ? '#1e3a5a' : '#60a5fa',
                    color: backupBusy || backupPassphrase.length < 8 ? '#4a6a8a' : '#001018',
                    cursor: backupBusy || backupPassphrase.length < 8 ? 'default' : 'pointer',
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {backupBusy ? 'Exporting…' : 'Export Backup'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Restore Wallet modal */}
      {showRestoreModal && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 2000,
          }}
        >
          <div
            style={{
              background: '#1a0a0a',
              border: '2px solid #fb7185',
              borderRadius: 12,
              padding: 28,
              minWidth: 360,
              maxWidth: 460,
              color: '#e8f5e8',
            }}
          >
            <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12, color: '#fb7185' }}>Restore Wallet</div>
            <div style={{ fontSize: 13, marginBottom: 14, color: '#fca5a5' }}>
              ⚠️ This will overwrite your current wallet and restart the node. Make sure you have a backup before
              proceeding.
            </div>
            <input
              type="password"
              placeholder="Backup passphrase"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !restoreBusy) doRestoreBackup(restoreNeedsForce);
              }}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 6,
                border: '1px solid #fb7185',
                background: '#2b0000',
                color: '#e8f5e8',
                fontSize: 13,
                marginBottom: 12,
                boxSizing: 'border-box',
              }}
              autoFocus
              disabled={restoreBusy}
            />
            {restoreMessage && (
              <div
                style={{
                  fontSize: 12,
                  marginBottom: 10,
                  color: restoreMessage.startsWith('Wallet restored') ? '#4ade80' : '#f87171',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {restoreMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setShowRestoreModal(false)}
                disabled={restoreBusy}
                style={{
                  padding: '7px 16px',
                  borderRadius: 6,
                  border: '1px solid #334155',
                  background: 'transparent',
                  color: '#94a3b8',
                  cursor: restoreBusy ? 'default' : 'pointer',
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {restoreMessage.startsWith('Wallet restored') ? 'Close' : 'Cancel'}
              </button>
              {!restoreMessage.startsWith('Wallet restored') && (
                <button
                  onClick={() => doRestoreBackup(restoreNeedsForce)}
                  disabled={restoreBusy || restorePassphrase.length < 8}
                  style={{
                    padding: '7px 16px',
                    borderRadius: 6,
                    border: 'none',
                    background: restoreBusy || restorePassphrase.length < 8 ? '#3a1010' : '#fb7185',
                    color: restoreBusy || restorePassphrase.length < 8 ? '#7a4040' : '#2b0000',
                    cursor: restoreBusy || restorePassphrase.length < 8 ? 'default' : 'pointer',
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {restoreBusy ? 'Restoring…' : restoreNeedsForce ? 'Overwrite & Restore' : 'Restore Wallet'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function _computeCoinsFromEnergyWallet(energyWh) {
  let remainingWh = Math.max(0, Number(energyWh) || 0);
  let minedCoins = 0;
  for (let tier = 0; tier < TOTAL_TIERS; tier++) {
    const energyPerCoinWh = energyForTier(tier);
    const tierMaxWh = COINS_PER_TIER * energyPerCoinWh;
    if (remainingWh >= tierMaxWh) {
      minedCoins += COINS_PER_TIER;
      remainingWh -= tierMaxWh;
    } else {
      minedCoins += remainingWh / energyPerCoinWh;
      return Math.min(TOTAL_COINS, minedCoins);
    }
  }
  return Math.min(TOTAL_COINS, minedCoins);
}

const PAGE_SIZE = 20;

function shortHash(h) {
  if (!h || h.length < 16) return h || '-';
  return h.slice(0, 8) + '\u2026' + h.slice(-6);
}

function formatTs(ms) {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString();
  } catch (_) {
    return '-';
  }
}

function proofColor(type) {
  switch (type) {
    case 'gpu':
      return '#a78bfa';
    case 'memory':
      return '#60a5fa';
    default:
      return '#4ade80';
  }
}

function proofLabel(type) {
  switch (type) {
    case 'gpu':
      return 'GPU';
    case 'memory':
      return 'MEM';
    default:
      return 'CPU';
  }
}

function ExplorerView() {
  // Block list state
  const [blocks, setBlocks] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [selectedBlockData, setSelectedBlockData] = useState(null);
  const [blockBusy, setBlockBusy] = useState(false);

  // Stats state
  const [stats, setStats] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResult, setSearchResult] = useState(null);

  // Jump to height
  const [jumpHeight, setJumpHeight] = useState('');

  // Sub-views: 'blocks', 'address', 'tx'
  const [subView, setSubView] = useState('blocks');
  const [addressData, setAddressData] = useState(null);
  const [addressBusy, setAddressBusy] = useState(false);
  const [txData, setTxData] = useState(null);
  const [txBusy, setTxBusy] = useState(false);

  const hasPrev = offset + PAGE_SIZE < total;
  const hasNext = offset > 0;

  const loadBlocks = useCallback(async (off) => {
    if (!window.wattcoinHardware?.invoke) {
      setStatus('API unavailable.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-blocks', {
        offset: off,
        limit: PAGE_SIZE,
      });
      if (res?.ok) {
        setBlocks(res.blocks || []);
        setTotal(res.total || 0);
        setOffset(off);
        setSelectedBlock(null);
        setSelectedBlockData(null);
      } else setStatus('Failed to load blocks.');
    } catch (e) {
      setStatus('Error: ' + e?.message);
    }
    setBusy(false);
  }, []);

  const loadStats = useCallback(async () => {
    if (!window.wattcoinHardware?.invoke) return;
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-stats');
      if (res?.ok) setStats(res);
    } catch (_) {
      /* ignore */
    }
  }, []);

  const loadBlockDetail = useCallback(async (height) => {
    if (!window.wattcoinHardware?.invoke) return;
    setBlockBusy(true);
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-block', { height });
      if (res?.ok) setSelectedBlockData(res.block);
    } catch (_) {
      /* ignore */
    }
    setBlockBusy(false);
  }, []);

  const loadAddress = useCallback(async (address) => {
    if (!window.wattcoinHardware?.invoke) return;
    setAddressBusy(true);
    setAddressData(null);
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-address', { address });
      if (res?.ok) setAddressData(res);
    } catch (_) {
      /* ignore */
    }
    setAddressBusy(false);
  }, []);

  const loadTx = useCallback(async (txid) => {
    if (!window.wattcoinHardware?.invoke) return;
    setTxBusy(true);
    setTxData(null);
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-tx-detail', { txid });
      if (res?.ok) setTxData(res.tx || res);
    } catch (_) {
      /* ignore */
    }
    setTxBusy(false);
  }, []);

  useEffect(() => {
    loadBlocks(0);
    loadStats();
  }, [loadBlocks, loadStats]);

  // Auto-refresh: poll stats every 30s, reload blocks when at offset 0
  useEffect(() => {
    const iv = setInterval(() => {
      loadStats();
      if (offset === 0) loadBlocks(0);
    }, 30_000);
    return () => clearInterval(iv);
  }, [loadStats, loadBlocks, offset]);

  function handleSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchBusy(true);
    setSearchResult(null);
    window.wattcoinHardware
      .invoke('wattcoin-explorer-search', { query: q })
      .then((res) => {
        setSearchResult(res);
        if (res?.type === 'block') {
          setSelectedBlock(res.block.height);
          setSelectedBlockData(res.block);
        } else if (res?.type === 'address') {
          setSubView('address');
          loadAddress(res.address);
        } else if (res?.type === 'tx') {
          setSubView('tx');
          setTxData(res.tx);
        }
      })
      .catch(() => setSearchResult({ type: 'not_found', message: 'Search failed.' }))
      .finally(() => setSearchBusy(false));
  }

  function handleJumpToHeight() {
    const h = parseInt(jumpHeight, 10);
    if (isNaN(h) || h < 0) return;
    setSearchQuery(String(h));
    setJumpHeight('');
    handleSearchRef.current = true;
  }

  const handleSearchRef = useRef(false);
  useEffect(() => {
    if (handleSearchRef.current) {
      handleSearchRef.current = false;
      handleSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  function handleSelectBlock(height) {
    if (selectedBlock === height) {
      setSelectedBlock(null);
      setSelectedBlockData(null);
      return;
    }
    setSelectedBlock(height);
    setSelectedBlockData(null);
    loadBlockDetail(height);
  }

  function handleAddressClick(address) {
    if (!address || address === 'genesis') return;
    setSubView('address');
    loadAddress(address);
  }

  function handleTxClick(txid) {
    if (!txid) return;
    setSubView('tx');
    loadTx(txid);
  }

  function handleBack() {
    setSubView('blocks');
    setAddressData(null);
    setTxData(null);
    setSearchResult(null);
  }

  const btnStyle = (disabled) => ({
    background: disabled ? '#1a2e1a' : '#1e3a1e',
    color: disabled ? '#456045' : '#b7f5bc',
    border: 'none',
    borderRadius: 6,
    padding: '5px 10px',
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 12,
  });

  // ── Address Detail view ─────────────────────────────────────────────
  function renderAddressDetail() {
    const d = addressData;
    if (addressBusy) return <div style={{ color: '#9ac79f', fontSize: 13 }}>Loading address…</div>;
    if (!d) return <div style={{ color: '#fca5a5', fontSize: 13 }}>No data.</div>;
    return (
      <div>
        <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 8 }}>Address Detail</div>
        <Row label="Address" value={d.address} mono />
        <Row label="Balance" value={`${(d.balance?.confirmed || 0).toLocaleString()} WTC`} />
        {d.balance?.unmatured > 0 && (
          <Row label="Unmatured" value={`${(d.balance?.unmatured || 0).toLocaleString()} WTC`} />
        )}
        <Row
          label="Mined"
          value={`${(d.minedStats?.totalWTC || 0).toLocaleString()} WTC (${d.minedStats?.totalBlocks || 0} blocks)`}
        />
        <Row label="Transactions" value={d.totalTransactions} />
        {d.minedBlocks?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Mined Blocks</div>
            {d.minedBlocks.map((mb) => (
              <div
                key={mb.height}
                onClick={() => {
                  setSubView('blocks');
                  handleSelectBlock(mb.height);
                }}
                style={{ cursor: 'pointer', fontSize: 11, color: '#60a5fa', fontFamily: 'monospace', marginBottom: 2 }}
              >
                #{mb.height} — {formatTs(mb.timestamp)} — +
                {(mb.rewardTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} WTC
              </div>
            ))}
          </div>
        )}
        {d.transactions?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Recent Transactions</div>
            {d.transactions.map((tx, i) => (
              <div
                key={tx.id || tx.txid || i}
                onClick={() => handleTxClick(tx.id || tx.txid)}
                style={{
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#60a5fa',
                  fontFamily: 'monospace',
                  marginBottom: 3,
                  wordBreak: 'break-all',
                }}
              >
                {tx.category === 'mine' ? '⛏ ' : ''}
                {(tx.id || tx.txid || '-').slice(0, 20)}… —{' '}
                {tx.amount != null ? `${Number(tx.amount).toLocaleString()} WTC` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Tx Detail view ──────────────────────────────────────────────────
  function renderTxDetail() {
    const tx = txData;
    if (txBusy) return <div style={{ color: '#9ac79f', fontSize: 13 }}>Loading transaction…</div>;
    if (!tx) return <div style={{ color: '#fca5a5', fontSize: 13 }}>No data.</div>;
    return (
      <div style={{ fontSize: 12, display: 'grid', gap: 5 }}>
        <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 4 }}>Transaction Detail</div>
        <Row label="ID" value={tx.id || tx.txid || '-'} mono />
        {tx.from !== undefined && <Row label="From" value={tx.from} mono />}
        {tx.to !== undefined && <Row label="To" value={tx.to} mono />}
        {tx.amount != null && (
          <Row
            label="Amount"
            value={`${Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC`}
          />
        )}
        {tx.fee != null && <Row label="Fee" value={`${Number(tx.fee).toLocaleString()} WTC`} />}
        {tx.nonce != null && <Row label="Nonce" value={tx.nonce} />}
        {tx.blockHeight != null && (
          <Row
            label="Block"
            value={
              <span
                onClick={() => {
                  setSubView('blocks');
                  handleSelectBlock(tx.blockHeight);
                }}
                style={{ color: '#60a5fa', cursor: 'pointer' }}
              >
                #{tx.blockHeight}
              </span>
            }
          />
        )}
        {tx.blockHash && <Row label="Block Hash" value={shortHash(tx.blockHash)} mono />}
        {tx.timestamp && <Row label="Time" value={formatTs(tx.timestamp)} />}
        {tx.type && <Row label="Type" value={tx.type} />}
        {tx.sig && (
          <div style={{ marginTop: 4 }}>
            <Row label="Signature" value={tx.sig} mono />
          </div>
        )}
      </div>
    );
  }

  // ── Stats Panel ─────────────────────────────────────────────────────
  function renderStats() {
    if (!stats || stats.height < 0) return null;
    const s = stats;
    let avgBlockTime = '-';
    let hashrate = '-';
    if (s.latestBlocks?.length >= 2) {
      const recent = s.latestBlocks;
      const oldest = recent[recent.length - 1];
      const newest = recent[0];
      const dt = (newest.timestamp - oldest.timestamp) / 1000;
      const n = recent.length - 1;
      if (dt > 0) {
        avgBlockTime = (dt / n).toFixed(1) + 's';
        hashrate = (n / (dt / 3600)).toFixed(1) + ' blk/h';
      }
    }
    return (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 16px',
          marginBottom: 10,
          fontSize: 12,
          color: '#9ac79f',
          background: '#0a150a',
          border: '1px solid #1e3a1e',
          borderRadius: 8,
          padding: '8px 12px',
        }}
      >
        <span>
          Height: <strong style={{ color: '#d7ffd9' }}>{s.height}</strong>
        </span>
        <span>
          Supply: <strong style={{ color: '#fbbf24' }}>{(s.totalSupply || 0).toLocaleString()} / 21,000,000 WTC</strong>
        </span>
        <span>
          Peers: <strong style={{ color: '#4ade80' }}>{s.peerCount}</strong>
        </span>
        <span>
          Block Time: <strong style={{ color: '#86efac' }}>{avgBlockTime}</strong>
        </span>
        <span>
          Rate: <strong style={{ color: '#86efac' }}>{hashrate}</strong>
        </span>
      </div>
    );
  }

  // ── Search + Jump bar ───────────────────────────────────────────────
  function renderSearchBar() {
    return (
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch();
          }}
          placeholder="Height / hash / address…"
          style={{
            flex: 1,
            minWidth: 160,
            background: '#0d1a0d',
            border: '1px solid #224022',
            borderRadius: 6,
            padding: '5px 10px',
            color: '#d7ffd9',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={handleSearch}
          disabled={searchBusy || !searchQuery.trim()}
          style={btnStyle(searchBusy || !searchQuery.trim())}
        >
          {searchBusy ? '…' : 'Search'}
        </button>
        <input
          value={jumpHeight}
          onChange={(e) => setJumpHeight(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleJumpToHeight();
          }}
          placeholder="Go to height…"
          style={{
            width: 110,
            background: '#0d1a0d',
            border: '1px solid #224022',
            borderRadius: 6,
            padding: '5px 10px',
            color: '#d7ffd9',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button onClick={handleJumpToHeight} disabled={!jumpHeight} style={btnStyle(!jumpHeight)}>
          Go
        </button>
      </div>
    );
  }

  // ── Search Result Banner ────────────────────────────────────────────
  function renderSearchResult() {
    if (!searchResult) return null;
    if (searchResult.type === 'not_found') {
      return (
        <div
          style={{
            marginBottom: 8,
            fontSize: 12,
            color: '#fca5a5',
            background: '#1a0d0d',
            border: '1px solid #5a2020',
            borderRadius: 6,
            padding: '6px 10px',
          }}
        >
          {searchResult.message}
          <button
            onClick={() => setSearchResult(null)}
            style={{
              marginLeft: 10,
              background: 'none',
              border: 'none',
              color: '#9ac79f',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return null;
  }

  // ── Block Row ───────────────────────────────────────────────────────
  function renderBlockRow(b) {
    const expanded = selectedBlock === b.height;
    return (
      <div key={b.height}>
        <div
          onClick={() => handleSelectBlock(b.height)}
          style={{
            background: expanded ? '#112a11' : '#0d1a0d',
            border: expanded ? '1px solid #4ade80' : '1px solid #224022',
            borderRadius: expanded && selectedBlockData ? '8px 8px 0 0' : 8,
            padding: '9px 12px',
            cursor: 'pointer',
            display: 'grid',
            gridTemplateColumns: '3.5rem 1fr auto',
            gap: '0 12px',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 700 }}>#{b.height}</span>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '1px 5px',
                borderRadius: 4,
                color: '#001008',
                background: proofColor(b.proofType),
              }}
            >
              {proofLabel(b.proofType)}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  fontSize: 11,
                  color: '#9ac79f',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {shortHash(b.hash)}
              </span>
              {b.hash && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(b.hash).catch(() => {});
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#708870',
                    cursor: 'pointer',
                    fontSize: 10,
                    padding: 0,
                    flexShrink: 0,
                  }}
                  title="Copy hash"
                >
                  📋
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#708870', marginTop: 2 }}>
              {formatTs(b.timestamp)} &nbsp;·&nbsp; {b.txCount} tx &nbsp;·&nbsp;
              {b.proposer === 'genesis' ? (
                'genesis'
              ) : (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddressClick(b.proposer);
                  }}
                  style={{ color: '#60a5fa', cursor: 'pointer' }}
                >
                  {b.proposer ? shortHash(b.proposer) : '-'}
                </span>
              )}
            </div>
          </div>
          <span style={{ fontSize: 12, color: '#86efac', fontWeight: 700, whiteSpace: 'nowrap' }}>
            +{(b.rewardTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} WTC
          </span>
        </div>

        {expanded && (
          <div
            style={{
              background: '#0a150a',
              border: '1px solid #4ade80',
              borderTop: 'none',
              borderRadius: '0 0 8px 8px',
              padding: '10px 14px',
            }}
          >
            {blockBusy ? (
              <div style={{ fontSize: 13, color: '#9ac79f' }}>Loading block…</div>
            ) : selectedBlockData ? (
              <BlockDetail block={selectedBlockData} onAddressClick={handleAddressClick} onTxClick={handleTxClick} />
            ) : (
              <div style={{ fontSize: 13, color: '#fca5a5' }}>Failed to load block detail.</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────
  if (subView === 'address') {
    return (
      <div style={{ marginTop: 4 }}>
        <button onClick={handleBack} style={{ ...btnStyle(false), marginBottom: 8 }}>
          ← Back to Explorer
        </button>
        {renderAddressDetail()}
      </div>
    );
  }

  if (subView === 'tx') {
    return (
      <div style={{ marginTop: 4 }}>
        <button onClick={handleBack} style={{ ...btnStyle(false), marginBottom: 8 }}>
          ← Back to Explorer
        </button>
        {renderTxDetail()}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>WTC Block Explorer</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => loadBlocks(offset + PAGE_SIZE)}
            disabled={busy || !hasPrev}
            style={btnStyle(busy || !hasPrev)}
          >
            ← Older
          </button>
          <button
            onClick={() => loadBlocks(Math.max(0, offset - PAGE_SIZE))}
            disabled={busy || !hasNext}
            style={btnStyle(busy || !hasNext)}
          >
            Newer →
          </button>
          <button
            onClick={() => loadBlocks(0)}
            disabled={busy}
            style={{
              background: busy ? '#275a2f' : '#4ade80',
              color: busy ? '#9fd4a8' : '#001008',
              border: 'none',
              borderRadius: 6,
              padding: '5px 10px',
              fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              fontSize: 12,
            }}
          >
            {busy ? 'Loading\u2026' : 'Latest'}
          </button>
        </div>
      </div>

      {renderStats()}
      {renderSearchBar()}
      {renderSearchResult()}

      {total > 0 && (
        <div style={{ fontSize: 12, color: '#9ac79f', marginBottom: 8 }}>
          Chain height: <strong style={{ color: '#d7ffd9' }}>{total - 1}</strong> &nbsp;·&nbsp; {total} block
          {total !== 1 ? 's' : ''}
        </div>
      )}

      {status && <div style={{ marginBottom: 8, fontSize: 13, color: '#fca5a5' }}>{status}</div>}

      <div style={{ display: 'grid', gap: 6 }}>
        {blocks.map(renderBlockRow)}
        {blocks.length === 0 && !busy && (
          <div style={{ fontSize: 13, color: '#9ac79f', padding: '12px 0' }}>No blocks yet.</div>
        )}
      </div>
    </div>
  );
}

function BlockDetail({ block, onAddressClick, onTxClick }) {
  const rewardEntries = block.rewardAddresses ? Object.entries(block.rewardAddresses) : [];
  const txs = block.transactions || [];
  const votes = block.votes ? Object.keys(block.votes) : [];

  function shortHash(h) {
    return h?.length >= 16 ? h.slice(0, 8) + '\u2026' + h.slice(-6) : h || '-';
  }

  const copyBtn = (val) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(val).catch(() => {});
      }}
      style={{
        background: 'none',
        border: 'none',
        color: '#708870',
        cursor: 'pointer',
        fontSize: 10,
        padding: 0,
        marginLeft: 4,
        verticalAlign: 'middle',
      }}
      title="Copy"
    >
      📋
    </button>
  );

  return (
    <div style={{ fontSize: 12, display: 'grid', gap: 5 }}>
      <Row label="Height" value={block.height} />
      <Row label="Hash" value={block.hash} mono extra={copyBtn(block.hash)} />
      <Row
        label="PrevHash"
        value={shortHash(block.prevHash)}
        mono
        extra={block.prevHash ? copyBtn(block.prevHash) : null}
      />
      <Row label="Time" value={formatTs(block.timestamp)} />
      <Row
        label="Proposer"
        value={
          block.proposer === 'genesis' ? (
            'genesis'
          ) : (
            <span onClick={() => onAddressClick?.(block.proposer)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
              {block.proposer}
            </span>
          )
        }
        mono
        extra={block.proposer && block.proposer !== 'genesis' ? copyBtn(block.proposer) : null}
      />
      <Row
        label="Energy"
        value={`${(block.energyWh || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} Wh`}
      />
      <Row
        label="Reward"
        value={`${(block.rewardTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC`}
      />
      {block.proofCommitment && (
        <Row label="Proof" value={shortHash(block.proofCommitment)} mono extra={copyBtn(block.proofCommitment)} />
      )}
      {rewardEntries.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 3 }}>Reward distribution</div>
          {rewardEntries.map(([addr, amt]) => (
            <div
              key={addr}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                color: '#9ac79f',
                fontFamily: 'monospace',
                fontSize: 11,
                wordBreak: 'break-all',
              }}
            >
              <span style={{ marginRight: 8, flex: 1 }}>
                <span onClick={() => onAddressClick?.(addr)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
                  {addr}
                </span>
              </span>
              <span style={{ whiteSpace: 'nowrap', color: '#86efac' }}>
                {amt.toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC
              </span>
            </div>
          ))}
        </div>
      )}
      {txs.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 3 }}>Transactions ({txs.length})</div>
          {txs.map((tx, i) => (
            <div
              key={tx.id || i}
              style={{
                background: '#0d1a0d',
                border: '1px solid #1e3a1e',
                borderRadius: 6,
                padding: '6px 10px',
                marginBottom: 4,
              }}
            >
              <div
                style={{
                  color: '#60a5fa',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  wordBreak: 'break-all',
                  cursor: 'pointer',
                }}
                onClick={() => onTxClick?.(tx.id || tx.txid)}
              >
                ID: {tx.id || tx.txid || '-'} {copyBtn(tx.id || tx.txid)}
              </div>
              <div style={{ color: '#708870', fontSize: 11, marginTop: 2 }}>
                {tx.from && (
                  <span>
                    From:{' '}
                    <span onClick={() => onAddressClick?.(tx.from)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
                      {tx.from}
                    </span>{' '}
                    &nbsp;
                  </span>
                )}
                {tx.to && (
                  <span>
                    To:{' '}
                    <span onClick={() => onAddressClick?.(tx.to)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
                      {tx.to}
                    </span>{' '}
                    &nbsp;
                  </span>
                )}
                {tx.amount != null && (
                  <span>Amount: {Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {votes.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 3 }}>BFT Votes ({votes.length})</div>
          {votes.map((v) => (
            <div key={v} style={{ fontSize: 10, color: '#708870', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {v}
              {copyBtn(v)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono, extra }) {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      <span style={{ color: '#9ac79f', minWidth: 70, flexShrink: 0 }}>{label}:</span>
      <span
        style={{
          color: '#d7ffd9',
          fontFamily: mono ? 'monospace' : undefined,
          fontSize: mono ? 11 : 12,
          wordBreak: 'break-all',
        }}
      >
        {String(value ?? '-')}
      </span>
      {extra || null}
    </div>
  );
}

// ─── Sale constants ──────────────────────────────────────────────────────────
const _SALE_ADDRESS = 'wtc1qd6dqez6rvh3ak2xw9jtsz3h8na0ssyepjgec3t';
const SALE_TOTAL = 333_333;
const SALE_TIER_SIZE = 111_111;
const SALE_TIERS = [
  { idx: 0, label: 'Tier 1', fraction: 1 / 3, start: 0, end: 111_111 },
  { idx: 1, label: 'Tier 2', fraction: 2 / 3, start: 111_111, end: 222_222 },
  { idx: 2, label: 'Tier 3', fraction: 3 / 3, start: 222_222, end: 333_333 },
];

// ─── Wallet Pay Modal ────────────────────────────────────────────────────────
function WalletPayModal({ orderId, usdcRequired, wtcAmount, onPaid, onManual, onClose }) {
  const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const SELLER = '0x0ca8cc23d85e5c988828076978c4ca65aa4293e8';
  const [step, setStep] = React.useState('pick'); // pick|connecting|confirm|done|error
  const [errorMsg, setErrorMsg] = React.useState('');
  const [txHash, setTxHash] = React.useState('');
  const [walletLabel, setWalletLabel] = React.useState('');

  // EIP-681 payment request URI — opens in MetaMask, Trust Wallet, Coinbase, etc.
  const _eip681 = `ethereum:${USDC_CONTRACT}@1/transfer?address=${SELLER}&uint256=${Math.round(usdcRequired * 1_000_000)}`;

  function detectInjected() {
    try {
      const eth = window.ethereum;
      if (!eth) return null;
      if (eth.isFrame) return 'Frame';
      if (eth.isCoinbaseWallet) return 'Coinbase Wallet';
      if (eth.isTrust) return 'Trust Wallet';
      if (eth.isMetaMask) return 'MetaMask';
      return 'Browser Wallet';
    } catch (_) {
      return null;
    }
  }

  function encodeTransfer(to, amountUsdc) {
    // transfer(address,uint256) selector = 0xa9059cbb; USDC has 6 decimals
    const amt = BigInt(Math.round(amountUsdc * 1_000_000));
    const toHex = to.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const amtHex = amt.toString(16).padStart(64, '0');
    return '0xa9059cbb' + toHex + amtHex;
  }

  async function handleInjected() {
    const eth = window.ethereum;
    if (!eth) {
      setErrorMsg('No injected wallet detected.');
      return;
    }
    const label = detectInjected() || 'Browser Wallet';
    setWalletLabel(label);
    setStep('connecting');
    try {
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      if (!accounts || !accounts[0]) throw new Error('No account returned from wallet');
      const chainId = await eth.request({ method: 'eth_chainId' });
      if (chainId !== '0x1') {
        await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      }
      setStep('confirm');
      const hash = await eth.request({
        method: 'eth_sendTransaction',
        params: [{ from: accounts[0], to: USDC_CONTRACT, value: '0x0', data: encodeTransfer(SELLER, usdcRequired) }],
      });
      setTxHash(hash);
      if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
        await window.wattcoinHardware.invoke('wattcoin-sale-confirm-payment', { orderId, txHash: hash });
      }
      setStep('done');
      setTimeout(() => onPaid(hash), 1600);
    } catch (e) {
      if (e && e.code === 4001) {
        setStep('pick');
        setErrorMsg('Transaction cancelled.');
      } else {
        setStep('error');
        setErrorMsg(e && e.message ? e.message : 'Unknown error');
      }
    }
  }

  function handleEip681() {
    if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
      window.wattcoinHardware.invoke('wattcoin-open-pay-page', {
        usdcRequired,
        wtcAmount,
        sellerAddress: SELLER,
      });
    }
    onManual();
  }

  const injected = detectInjected();
  const btn = {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    width: '100%',
    padding: '14px 16px',
    borderRadius: 12,
    cursor: 'pointer',
    color: '#e8f5e8',
    textAlign: 'left',
    background: '#0a1a0a',
    border: '1px solid #2d4a2d',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,6,0,0.84)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        style={{
          background: '#0d1a0d',
          border: '1px solid #2d4a2d',
          borderRadius: 18,
          padding: '28px 28px',
          maxWidth: 400,
          width: '100%',
          position: 'relative',
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 12,
            right: 16,
            background: 'none',
            border: 'none',
            color: '#4a6a4a',
            fontSize: 22,
            cursor: 'pointer',
            lineHeight: 1,
          }}
        >
          ×
        </button>

        {step === 'pick' && (
          <>
            <div style={{ fontSize: 15, color: '#4ade80', fontWeight: 700, marginBottom: 4 }}>Pay with USDC</div>
            <div style={{ fontSize: 13, color: '#6b9b6b', marginBottom: 20 }}>
              Send <span style={{ color: '#fcd34d', fontWeight: 700 }}>${usdcRequired.toFixed(2)} USDC</span> to receive{' '}
              <span style={{ color: '#a7ffb0', fontWeight: 700 }}>{wtcAmount?.toLocaleString()} WTC</span>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              {injected && (
                <button onClick={handleInjected} style={{ ...btn, border: '1px solid #4ade8050' }}>
                  <span style={{ fontSize: 22, minWidth: 28, textAlign: 'center' }}>🦊</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{injected}</div>
                    <div style={{ fontSize: 11, color: '#6b9b6b' }}>Detected — sign directly in app</div>
                  </div>
                </button>
              )}
              <button onClick={handleEip681} style={{ ...btn }}>
                <span style={{ fontSize: 22, minWidth: 28, textAlign: 'center' }}>🔗</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Open in Wallet App</div>
                  <div style={{ fontSize: 11, color: '#6b9b6b' }}>MetaMask · Trust Wallet · Coinbase · Base</div>
                </div>
              </button>
            </div>
            {errorMsg && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 12 }}>{errorMsg}</div>}
          </>
        )}

        {(step === 'connecting' || step === 'confirm') && (
          <div style={{ textAlign: 'center', padding: '28px 0' }}>
            <div style={{ fontSize: 36, marginBottom: 14 }}>{step === 'connecting' ? '🔌' : '✍️'}</div>
            <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 8 }}>
              {step === 'connecting' ? `Connecting to ${walletLabel}…` : `Confirm in ${walletLabel}`}
            </div>
            <div style={{ fontSize: 12, color: '#6b9b6b' }}>
              {step === 'connecting'
                ? 'Approve the connection in your wallet'
                : `Review and confirm the $${usdcRequired.toFixed(2)} USDC transfer`}
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <div style={{ fontSize: 15, color: '#4ade80', fontWeight: 700, marginBottom: 6 }}>Payment Submitted!</div>
            <div style={{ fontSize: 12, color: '#6b9b6b', marginBottom: 10 }}>
              Your WTC will appear in your wallet once the batch of 10,101 WTC is queued.
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#3d5c3d', wordBreak: 'break-all' }}>
              {txHash}
            </div>
          </div>
        )}

        {step === 'error' && (
          <>
            <div style={{ fontSize: 14, color: '#fca5a5', fontWeight: 700, marginBottom: 8 }}>Payment Failed</div>
            <div style={{ fontSize: 12, color: '#6b9b6b', marginBottom: 16, lineHeight: 1.5 }}>{errorMsg}</div>
            <button
              onClick={() => {
                setStep('pick');
                setErrorMsg('');
              }}
              style={{
                background: '#1e3a1e',
                color: '#b7f5bc',
                border: 'none',
                borderRadius: 8,
                padding: '9px 18px',
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Try Again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── StakingView ───────────────────────────────────────────────────────────────
function StakingView({ selectedWalletAddress, walletBalance, queuedWtc = 0 }) {
  const [status, setStatus] = React.useState(null); // pool info
  const [myEntries, setMyEntries] = React.useState([]);
  const [stakeAmount, setStakeAmount] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [msgOk, setMsgOk] = React.useState(true);

  const address = selectedWalletAddress || '';

  // ── load status + my entries ────────────────────────────────────────────────
  const refresh = React.useCallback(async () => {
    try {
      const s = await window.wattcoinHardware.invoke('wattcoin-staking-status');
      if (s.ok) setStatus(s);
    } catch (_) {
      /* istanbul ignore next */
    }
    if (address) {
      try {
        const r = await window.wattcoinHardware.invoke('wattcoin-staking-get-my-entries', address);
        if (r.ok) setMyEntries(r.entries || []);
      } catch (_) {
        /* istanbul ignore next */
      }
    }
  }, [address]);

  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── place stake ─────────────────────────────────────────────────────────────
  async function handleStake() {
    setMsg('');
    const amt = parseFloat(stakeAmount);
    if (!address) {
      setMsg('No wallet address selected.');
      setMsgOk(false);
      return;
    }
    if (!Number.isFinite(amt) || amt < (status ? status.minStake : 100)) {
      setMsg(`Minimum stake is ${status ? status.minStake : 100} WTC.`);
      setMsgOk(false);
      return;
    }
    const totalAvailable = (walletBalance || 0) + (queuedWtc || 0);
    if (totalAvailable > 0 && Math.floor(amt) > totalAvailable) {
      setMsg(`Insufficient balance. You have ${totalAvailable.toLocaleString()} WTC in your wallet.`);
      setMsgOk(false);
      return;
    }
    setBusy(true);
    try {
      const r = await window.wattcoinHardware.invoke('wattcoin-staking-stake', {
        fromAddress: address,
        wtcAmount: Math.floor(amt),
      });
      if (r.ok) {
        setMsg(
          r.alreadyExists
            ? 'You already have a pending staking entry.'
            : 'Stake submitted! Reward will be paid when queue reaches the flush threshold.',
        );
        setMsgOk(true);
        setStakeAmount('');
        await refresh();
      } else {
        setMsg(r.error || 'Failed to submit stake.');
        setMsgOk(false);
      }
    } catch (e) {
      setMsg('Error: ' + (e.message || e));
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  // ── cancel entry ─────────────────────────────────────────────────────────────
  async function handleCancel(entryId) {
    setBusy(true);
    try {
      const r = await window.wattcoinHardware.invoke('wattcoin-staking-cancel', entryId);
      setMsg(r.ok ? 'Staking entry cancelled.' : r.error || 'Failed to cancel.');
      setMsgOk(r.ok);
      await refresh();
    } catch (e) {
      setMsg('Error: ' + (e.message || e));
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  const hasPending = myEntries.some((e) => e.status === 'pending');
  const poolBal = status ? status.poolBalance : null;
  const apy = status ? status.currentApy : 0;
  const totalStaked = status ? status.totalStaked : 0;
  const _flushThreshold = status ? status.flushThreshold : 10000;

  return (
    <div style={{ padding: '18px 0' }}>
      {/* ── Wallet balance ── */}
      <div
        style={{
          background: '#071507',
          border: '1px solid #1a3a1a',
          borderRadius: 10,
          padding: '11px 18px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em' }}>
          YOUR WALLET BALANCE
        </div>
        <div
          style={{
            color: walletBalance + queuedWtc > 0 ? '#4ade80' : '#9ca3af',
            fontSize: 16,
            fontWeight: 800,
            marginLeft: 'auto',
          }}
        >
          {(walletBalance + queuedWtc).toLocaleString()} WTC
        </div>
        {queuedWtc > 0 && walletBalance > 0 && (
          <div style={{ width: '100%', textAlign: 'right', fontSize: 11, color: '#6b9a6b', fontFamily: 'monospace' }}>
            {walletBalance.toLocaleString()} mined + {queuedWtc.toLocaleString()} queued for delivery
          </div>
        )}
        {queuedWtc > 0 && walletBalance === 0 && (
          <div style={{ width: '100%', textAlign: 'right', fontSize: 11, color: '#fbbf24', fontFamily: 'monospace' }}>
            {queuedWtc.toLocaleString()} WTC queued for delivery
          </div>
        )}
      </div>
      {/* ── Pool info bar ── */}
      <div
        style={{
          background: '#0d2710',
          borderRadius: 10,
          padding: '14px 18px',
          marginBottom: 18,
          display: 'flex',
          gap: 32,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>COINS LEFT TO EARN</div>
          <div style={{ color: '#4ade80', fontSize: 20, fontWeight: 800 }}>
            {poolBal !== null ? poolBal.toLocaleString() + ' WTC' : '—'}
          </div>
        </div>
        <div>
          <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>TOTAL CURRENTLY STAKED</div>
          <div style={{ color: '#e2f5e5', fontSize: 20, fontWeight: 700 }}>{totalStaked.toLocaleString()} WTC</div>
        </div>
        <div>
          <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>CURRENT APY</div>
          <div style={{ color: apy > 0 ? '#4ade80' : '#9ca3af', fontSize: 20, fontWeight: 700 }}>{apy.toFixed(2)}%</div>
        </div>
      </div>

      <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
        Stake WTC to earn rewards. Every <strong style={{ color: '#b7f5bc' }}>100&nbsp;WTC</strong> in the queue adds{' '}
        <strong style={{ color: '#b7f5bc' }}>0.01% APY</strong>. Staking will end when the total supply of{' '}
        <strong style={{ color: '#b7f5bc' }}>166,667&nbsp;WTC</strong> has been distributed.
      </div>

      {/* ── Stake form ── */}
      {!hasPending ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <input
            type="number"
            min={status ? status.minStake : 100}
            step="1"
            placeholder={`Amount (min ${status ? status.minStake : 100} WTC)`}
            value={stakeAmount}
            onChange={(e) => setStakeAmount(e.target.value)}
            disabled={busy}
            style={{
              background: '#0d2710',
              border: '1.5px solid #265b2e',
              borderRadius: 8,
              color: '#e2f5e5',
              padding: '9px 13px',
              fontSize: 14,
              width: 220,
              outline: 'none',
            }}
          />
          <button
            onClick={handleStake}
            disabled={busy || !address}
            style={{
              background: busy || !address ? '#265b2e' : '#4ade80',
              color: busy || !address ? '#9ca3af' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '9px 22px',
              fontWeight: 700,
              fontSize: 14,
              cursor: busy || !address ? 'default' : 'pointer',
            }}
          >
            {busy ? 'Submitting…' : 'Stake WTC'}
          </button>
        </div>
      ) : (
        <div
          style={{
            background: '#0d2710',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 14,
            color: '#4ade80',
            fontSize: 13,
          }}
        >
          You have a pending staking entry. Cancel it below to stake a different amount.
        </div>
      )}

      {msg && (
        <div
          style={{
            background: msgOk ? '#0d2710' : '#2a1010',
            border: `1px solid ${msgOk ? '#4ade80' : '#f87171'}`,
            borderRadius: 8,
            padding: '9px 13px',
            marginBottom: 14,
            color: msgOk ? '#4ade80' : '#f87171',
            fontSize: 13,
          }}
        >
          {msg}
        </div>
      )}

      {/* ── My staking entries ── */}
      {myEntries.length > 0 && (
        <div>
          <div style={{ color: '#6ee688', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>My Staking Entries</div>
          {myEntries.map((entry) => (
            <div
              key={entry.id}
              style={{
                background: '#0d2710',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 8,
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 15 }}>
                  {entry.wtcAmount.toLocaleString()} WTC
                </div>
                <div style={{ color: '#9ca3af', fontSize: 11 }}>{new Date(entry.createdAtMs).toLocaleString()}</div>
              </div>
              <div style={{ minWidth: 80 }}>
                <span
                  style={{
                    background:
                      entry.status === 'pending' ? '#1a3a2a' : entry.status === 'rewarded' ? '#0d2710' : '#2a1a1a',
                    color: entry.status === 'pending' ? '#4ade80' : entry.status === 'rewarded' ? '#86efac' : '#f87171',
                    borderRadius: 5,
                    padding: '3px 9px',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {entry.status.toUpperCase()}
                </span>
              </div>
              {entry.status === 'rewarded' && entry.rewardAmount !== null && (
                <div style={{ color: '#86efac', fontSize: 13 }}>
                  +{entry.rewardAmount.toLocaleString()} WTC reward @ {entry.apyAtFlush}% APY
                </div>
              )}
              {entry.status === 'pending' && (
                <button
                  onClick={() => handleCancel(entry.id)}
                  disabled={busy}
                  style={{
                    background: 'none',
                    border: '1px solid #f87171',
                    color: '#f87171',
                    borderRadius: 6,
                    padding: '5px 12px',
                    cursor: busy ? 'default' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SaleView({
  selectedWalletAddress,
  setQueuedSaleOrders,
  orderId,
  setOrderId,
  orderStatus,
  setOrderStatus,
  orderPollRef,
  startOrderPoll,
}) {
  const [soldWtc, setSoldWtc] = React.useState(null);
  const [electricityPrice, setElectricityPrice] = React.useState(null);
  const [electricitySource, setElectricitySource] = React.useState(null);
  const [busy, setBusy] = React.useState(true);
  const [status, setStatus] = React.useState('');
  const [lastEtherscanPoll, setLastEtherscanPoll] = React.useState(null);

  // Buy form
  const [buyAmount, setBuyAmount] = React.useState('');
  const [usdcRequired, setUsdcRequired] = React.useState(null);
  const [priceLoading, setPriceLoading] = React.useState(false);
  const [orderMsg, setOrderMsg] = React.useState('');
  const [orderError, setOrderError] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [buyToAddress, setBuyToAddress] = React.useState(selectedWalletAddress || '');
  const [localAddresses, setLocalAddresses] = React.useState([]);
  const [showWalletModal, setShowWalletModal] = React.useState(false);
  const [optimisticPaid, setOptimisticPaid] = React.useState(false);
  const [buyerEthAddress, setBuyerEthAddress] = React.useState(''); // ETH address buyer will send USDC from

  // Sync buyToAddress with prop on first load
  React.useEffect(() => {
    if (selectedWalletAddress) setBuyToAddress((prev) => prev || selectedWalletAddress);
  }, [selectedWalletAddress]);

  // Load wallet addresses for the delivery address picker
  React.useEffect(() => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    window.wattcoinHardware
      .invoke('wattcoin-get-addresses')
      .then((res) => {
        if (res && res.ok && Array.isArray(res.addresses) && res.addresses.length > 0) {
          setLocalAddresses(res.addresses);
          setBuyToAddress((prev) => prev || res.addresses[0]);
        }
      })
      .catch(() => {});
  }, []);

  const SELLER_USDC = '0x0ca8cc23d85e5c988828076978c4ca65aa4293e8';
  const MIN_BUY = 1;

  // Coins sold = from sale-status IPC (on-chain sent + queued/paid)
  const soldRaw = soldWtc;
  const sold = soldRaw === null ? null : Math.max(0, Math.min(SALE_TOTAL, Number(soldRaw) || 0));

  const activeTierIdx =
    sold === null ? 0 : sold >= SALE_TOTAL ? -1 : sold < SALE_TIER_SIZE ? 0 : sold < 2 * SALE_TIER_SIZE ? 1 : 2;

  // ── Load sale status & electricity price ─────────────────────────────────
  const loadSaleData = useCallback(async () => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setStatus('Wallet API unavailable.');
      setBusy(false);
      return;
    }
    try {
      const [elRes, saleRes] = await Promise.all([
        window.wattcoinHardware.invoke('wattcoin-get-electricity-price'),
        window.wattcoinHardware.invoke('wattcoin-sale-status'),
      ]);
      if (saleRes && saleRes.ok) {
        setSoldWtc(saleRes.sold ?? 0);
      } else {
        setStatus('Could not load sale data.');
      }
      if (elRes && elRes.ok && elRes.price != null) {
        setElectricityPrice(elRes.price);
        setElectricitySource(elRes.source || null);
      }
      if (saleRes && saleRes.ok && saleRes.lastEtherscanPoll) {
        setLastEtherscanPoll(saleRes.lastEtherscanPoll);
      }
    } catch (e) {
      setStatus('Error loading sale data.');
    }
    setBusy(false);
  }, []);

  React.useEffect(() => {
    loadSaleData();
    return () => {
      if (orderPollRef.iv) clearInterval(orderPollRef.iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount (and whenever the delivery address is resolved), check for any existing
  // active order for this address — covers web-wallet orders that were synced by the
  // miner node but the Electron Buy tab never knew about.
  const _checkedOrderAddr = React.useRef(null);
  React.useEffect(() => {
    if (!buyToAddress || orderStatus || _checkedOrderAddr.current === buyToAddress) return;
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    _checkedOrderAddr.current = buyToAddress;
    window.wattcoinHardware
      .invoke('wattcoin-sale-get-my-orders', buyToAddress)
      .then((res) => {
        if (!res || !res.ok || !Array.isArray(res.orders) || res.orders.length === 0) return;
        // Only restore orders that still need user action (awaiting or submitted payment).
        // Queued/fulfilled/cancelled orders have already been acted on — don't re-show them.
        const actionable = res.orders.filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted');
        if (actionable.length === 0) return;
        const sorted = [...actionable].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        const existing = sorted[0];
        setOrderId(existing.id);
        setOrderStatus(existing);
        startOrderPoll(existing.id, {
          onConfirmed: () => {
            loadSaleData();
            setOrderMsg('');
            setOrderError('');
            setBuyAmount('');
            setUsdcRequired(null);
            setOptimisticPaid(false);
            setShowWalletModal(false);
          },
          onFulfilled: () => {
            loadSaleData();
            setOrderMsg('Payment received and WTC sent! Check your wallet balance.');
          },
          onFailed: () => {
            setOrderError('Fulfillment failed — please contact support with your order ID.');
          },
          onExpired: () => {
            setOrderError('Order expired (no payment received within 24 h). Please try again.');
          },
        });
      })
      .catch(() => {});
  }, [buyToAddress, orderStatus, setOrderId, setOrderStatus, startOrderPoll, loadSaleData]);

  // ── Recompute price when amount or electricity changes ─────────────────
  React.useEffect(() => {
    setUsdcRequired(null);
    if (!buyAmount || !electricityPrice) return;
    const amount = Number(buyAmount);
    if (!Number.isFinite(amount) || amount < MIN_BUY) return;

    setPriceLoading(true);
    window.wattcoinHardware
      .invoke('wattcoin-sale-compute-price', {
        wtcAmount: amount,
        electricityPricePerKwh: electricityPrice,
      })
      .then((r) => {
        if (r && r.ok) setUsdcRequired(r.usdcRequired);
      })
      .catch(() => {})
      .finally(() => setPriceLoading(false));
  }, [buyAmount, electricityPrice]);

  // ── Poll order status after placing ──────────────────────────────────────
  // (moved to WalletTab)
  // ── Place order ───────────────────────────────────────────────────────────
  async function handlePlaceOrder() {
    if (!buyToAddress) {
      setOrderError('No wallet address selected.');
      return;
    }
    const amount = Number(buyAmount);
    if (!Number.isFinite(amount) || amount < MIN_BUY) {
      setOrderError(`Minimum purchase is ${MIN_BUY} WTC.`);
      return;
    }
    if (!usdcRequired) {
      setOrderError('Price not loaded yet. Please wait a moment.');
      return;
    }
    setOrderError('');
    setOrderMsg('');
    try {
      const r = await window.wattcoinHardware.invoke('wattcoin-sale-place-order', {
        wtcAddress: buyToAddress,
        wtcAmount: amount,
        usdcRequired: usdcRequired,
        buyerEthAddress: buyerEthAddress || null,
      });
      if (r && r.ok) {
        loadSaleData();
        setOrderId(r.orderId);
        setOrderMsg('');
        if (r.alreadyExists) {
          // An existing order was returned — fetch its real current status immediately
          // to avoid flashing stale payment instructions (e.g. old $6 USDC for a queued order).
          let resolvedStatus = r.existingStatus || 'pending_payment';
          try {
            const ord = await window.wattcoinHardware.invoke('wattcoin-sale-get-order', r.orderId);
            if (ord && ord.ok && ord.order) {
              setOrderStatus(ord.order);
              resolvedStatus = ord.order.status;
            } else {
              setOrderStatus({
                status: resolvedStatus,
                wtcAmount: r.wtcAmount || amount,
                usdcRequired: r.usdcRequired,
                id: r.orderId,
              });
            }
          } catch (_) {
            setOrderStatus({
              status: resolvedStatus,
              wtcAmount: r.wtcAmount || amount,
              usdcRequired: r.usdcRequired,
              id: r.orderId,
            });
          }
          // Only open payment modal if genuinely awaiting payment
          if (resolvedStatus === 'pending_payment') setShowWalletModal(true);
        } else {
          setOrderStatus({ status: 'pending_payment', wtcAmount: amount, usdcRequired: r.usdcRequired, id: r.orderId });
          setShowWalletModal(true);
        }
        startOrderPoll(r.orderId, {
          onConfirmed: () => {
            loadSaleData();
            setOrderMsg('');
            setOrderError('');
            setBuyAmount('');
            setUsdcRequired(null);
            setOptimisticPaid(false);
            setShowWalletModal(false);
          },
          onFulfilled: () => {
            loadSaleData();
            setOrderMsg('Payment received and WTC sent! Check your wallet balance.');
          },
          onFailed: () => {
            setOrderError('Fulfillment failed — please contact support with your order ID.');
          },
          onExpired: () => {
            setOrderError('Order expired (no payment received within 24 h). Please try again.');
          },
        });
      } else {
        setOrderError(r && r.error ? r.error : 'Failed to place order.');
      }
    } catch (e) {
      setOrderError(e && e.message ? e.message : 'Unexpected error.');
    }
  }

  function handleCancelOrder() {
    if (!orderId) return;
    const cancellingId = orderId;
    window.wattcoinHardware
      .invoke('wattcoin-sale-cancel-order', cancellingId)
      .then((r) => {
        if (r && r.ok) {
          loadSaleData();
          if (orderPollRef.iv) {
            clearInterval(orderPollRef.iv);
            orderPollRef.iv = null;
          }
          setOrderId(null);
          setOrderStatus(null);
          setOrderMsg('Order cancelled.');
          setQueuedSaleOrders((prev) => prev.filter((o) => o.id !== cancellingId));
        }
      })
      .catch(() => {});
  }

  function copyUsdc() {
    navigator.clipboard
      .writeText(SELLER_USDC)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  const ENERGY_PER_WTC_KWH = TIER1_ENERGY / 1000; // 20 kWh

  return (
    <div style={{ marginTop: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>WTC Sale</div>
        {lastEtherscanPoll &&
          lastEtherscanPoll.at &&
          (() => {
            const ok = lastEtherscanPoll.result === 'ok';
            const d = new Date(lastEtherscanPoll.at);
            const timeStr =
              d.getFullYear() +
              '-' +
              String(d.getMonth() + 1).padStart(2, '0') +
              '-' +
              String(d.getDate()).padStart(2, '0') +
              ' ' +
              String(d.getHours()).padStart(2, '0') +
              ':' +
              String(d.getMinutes()).padStart(2, '0') +
              ':' +
              String(d.getSeconds()).padStart(2, '0');
            const label = ok ? 'OK' : lastEtherscanPoll.result || 'ERR';
            return (
              <div
                title={`Last Etherscan USDC check: ${label}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 10,
                  color: '#4a6a4a',
                  fontFamily: 'monospace',
                }}
              >
                <span style={{ color: ok ? '#4ade80' : '#fca5a5' }}>{ok ? '\u25cf' : '\u25cf'}</span>
                <span>Etherscan {timeStr}</span>
                <span style={{ color: ok ? '#4ade80' : '#fca5a5' }}>{label}</span>
              </div>
            );
          })()}
        {electricityPrice !== null && (
          <div
            title={electricitySource === 'live' ? 'Live global average - globalpetrolprices.com' : 'Estimated/cached'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              background: '#0a1f0a',
              border: '1px solid #1e3a1e',
              borderRadius: 6,
              padding: '4px 10px',
              cursor: 'default',
            }}
          >
            <span style={{ fontSize: 11, color: electricitySource === 'live' ? '#4ade80' : '#6b9b6b' }}>&#9889;</span>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#a7ffb0' }}>
              ${electricityPrice.toFixed(3)}
              <span style={{ color: '#4a6a4a' }}>/kWh</span>
            </span>
            <span style={{ fontSize: 9, color: electricitySource === 'live' ? '#4ade80' : '#4a6a4a', marginLeft: 2 }}>
              {electricitySource === 'live' ? '\u25cf' : '\u25cb'}
            </span>
            {(() => {
              const costPerWtc = electricityPrice * ENERGY_PER_WTC_KWH;
              return (
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b9b6b', marginLeft: 4 }}>
                  mining cost {costPerWtc >= 1 ? `$${costPerWtc.toFixed(2)}` : `$${costPerWtc.toFixed(4)}`}/WTC
                </span>
              );
            })()}
          </div>
        )}
      </div>

      {status && <div style={{ color: '#fca5a5', fontSize: 13, marginBottom: 12 }}>{status}</div>}
      {busy && !status && <div style={{ color: '#6b9b6b', fontSize: 13, marginBottom: 12 }}>Loading...</div>}

      {/* Overall progress bar */}
      {sold !== null && (
        <div style={{ marginBottom: 22 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: '#6b9b6b',
              marginBottom: 5,
            }}
          >
            <span>{sold.toLocaleString()} WTC sold</span>
            <span>{Math.max(0, SALE_TOTAL - sold).toLocaleString()} WTC remaining</span>
          </div>
          <div
            style={{
              height: 10,
              background: '#122612',
              borderRadius: 999,
              overflow: 'hidden',
              border: '1px solid #1e3a1e',
              position: 'relative',
            }}
          >
            {[1 / 3, 2 / 3].map((frac) => (
              <div
                key={frac}
                style={{
                  position: 'absolute',
                  left: `${frac * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: '#4ade8040',
                  zIndex: 1,
                }}
              />
            ))}
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, (sold / SALE_TOTAL) * 100)}%`,
                background: 'linear-gradient(90deg, #4ade80, #22c55e)',
                transition: 'width 0.4s ease',
                borderRadius: 999,
              }}
            />
          </div>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#4a6a4a', marginTop: 3 }}
          >
            <span>0</span>
            <span>111,111</span>
            <span>222,222</span>
            <span>333,333</span>
          </div>
        </div>
      )}

      {/* Tier cards */}
      <div style={{ display: 'grid', gap: 10, marginBottom: 24 }}>
        {SALE_TIERS.map((t) => {
          const isActive = sold !== null && activeTierIdx >= 0 && t.idx === activeTierIdx;
          const isCompleted = sold !== null && sold >= t.end;
          const tierSold = sold === null ? 0 : Math.min(SALE_TIER_SIZE, Math.max(0, sold - t.start));
          const tierPct = Math.min(100, (tierSold / SALE_TIER_SIZE) * 100);
          const priceLabel = t.idx === 0 ? '1/3 mining cost' : t.idx === 1 ? '2/3 mining cost' : 'Full mining cost';
          const usdPrice = electricityPrice !== null ? electricityPrice * ENERGY_PER_WTC_KWH * t.fraction : null;

          return (
            <div
              key={t.idx}
              style={{
                background: isActive ? '#0a1f0a' : '#0d160d',
                border: `1px solid ${isActive ? '#4ade80' : isCompleted ? '#2d4a2d' : '#1e3a1e'}`,
                borderRadius: 12,
                padding: '14px 16px',
                opacity: isCompleted ? 0.65 : 1,
                transition: 'border-color 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: isActive ? '#4ade80' : '#9ac79f' }}>
                    {t.label}
                  </span>
                  {isActive && (
                    <span
                      style={{
                        fontSize: 10,
                        background: '#4ade80',
                        color: '#001008',
                        borderRadius: 999,
                        padding: '2px 7px',
                        fontWeight: 700,
                      }}
                    >
                      ACTIVE
                    </span>
                  )}
                  {isCompleted && (
                    <span
                      style={{
                        fontSize: 10,
                        background: '#2d4a2d',
                        color: '#4a9a4a',
                        borderRadius: 999,
                        padding: '2px 7px',
                        fontWeight: 700,
                      }}
                    >
                      SOLD OUT
                    </span>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#fcd34d', fontWeight: 700 }}>
                    {usdPrice !== null
                      ? usdPrice >= 1
                        ? `~$${usdPrice.toFixed(2)}`
                        : `~$${usdPrice.toFixed(4)}`
                      : `${Math.round(t.fraction * 100)}%`}
                  </span>
                  <span style={{ fontSize: 10, color: '#6b9b6b', marginLeft: 4 }}>/WTC</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#6b9b6b', marginBottom: 8 }}>
                {t.start.toLocaleString()} – {t.end.toLocaleString()} WTC &nbsp;&middot;&nbsp; {priceLabel}
              </div>
              <div
                style={{
                  height: 6,
                  background: '#122612',
                  borderRadius: 999,
                  overflow: 'hidden',
                  border: '1px solid #1e3a1e',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${tierPct}%`,
                    background: isCompleted ? '#2d4a2d' : 'linear-gradient(90deg, #4ade80, #22c55e)',
                    transition: 'width 0.4s ease',
                    borderRadius: 999,
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10,
                  color: '#4a6a4a',
                  marginTop: 3,
                }}
              >
                <span>{tierSold.toLocaleString()} sold</span>
                <span>{Math.max(0, SALE_TIER_SIZE - tierSold).toLocaleString()} left</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Buy form / order status ─────────────────────────────────────── */}
      {!orderStatus ? (
        <div style={{ background: '#0a1f0a', border: '1px solid #1e3a1e', borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 14 }}>Buy WTC</div>

          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                display: 'block',
                marginBottom: 6,
                fontSize: 11,
                color: '#9ac79f',
                letterSpacing: '0.06em',
                fontFamily: 'monospace',
              }}
            >
              DELIVER WTC TO
            </label>
            {localAddresses.length > 1 ? (
              <select
                value={buyToAddress}
                onChange={(e) => setBuyToAddress(e.target.value)}
                style={{
                  width: 'auto',
                  background: '#0d160d',
                  border: '1px solid #2d4a2d',
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: '#a7ffb0',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                {localAddresses.map((addr) => (
                  <option key={addr} value={addr}>
                    {addr}
                  </option>
                ))}
              </select>
            ) : (
              <div
                style={{
                  display: 'inline-block',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: buyToAddress ? '#a7ffb0' : '#fca5a5',
                  background: '#0d160d',
                  border: `1px solid ${buyToAddress ? '#1e3a1e' : '#4a1a1a'}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                }}
              >
                {buyToAddress || 'No wallet address found. Create a wallet first.'}
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                display: 'block',
                marginBottom: 6,
                fontSize: 11,
                color: '#9ac79f',
                letterSpacing: '0.06em',
                fontFamily: 'monospace',
              }}
            >
              YOUR USDC WALLET ADDRESS <span style={{ color: '#fbbf24' }}>(required)</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="text"
                value={buyerEthAddress}
                onChange={(e) => setBuyerEthAddress(e.target.value.trim())}
                placeholder="0x..."
                spellCheck={false}
                style={{
                  width: '44ch',
                  background: '#0d160d',
                  border: `1px solid ${buyerEthAddress && (!buyerEthAddress.startsWith('0x') || buyerEthAddress.length < 40) ? '#4a1a1a' : '#2d4a2d'}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: '#a7ffb0',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  outline: 'none',
                }}
              />
              <button
                onClick={() =>
                  navigator.clipboard
                    .readText()
                    .then((t) => setBuyerEthAddress(t.trim()))
                    .catch(() => {})
                }
                style={{
                  background: '#1e3a1e',
                  color: '#a7ffb0',
                  border: '1px solid #2d4a2d',
                  borderRadius: 8,
                  padding: '9px 12px',
                  fontSize: 11,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Paste
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#4a6a4a', marginTop: 4 }}>
              The Ethereum address you will send USDC from — used to match your payment automatically.
            </div>
          </div>

          <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: '#9ac79f' }}>
            Amount (WTC) — minimum {MIN_BUY}
          </label>
          <input
            type="number"
            min={MIN_BUY}
            step="1"
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
            placeholder={`e.g. 500`}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: '#0d160d',
              border: '1px solid #2d4a2d',
              borderRadius: 8,
              padding: '10px 12px',
              color: '#a7ffb0',
              fontFamily: 'monospace',
              fontSize: 14,
              outline: 'none',
            }}
          />

          {/* Price preview */}
          <div style={{ marginTop: 10, marginBottom: 14, minHeight: 28 }}>
            {priceLoading && <span style={{ fontSize: 12, color: '#6b9b6b' }}>Computing price...</span>}
            {!priceLoading && usdcRequired !== null && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: '#fcd34d', fontFamily: 'monospace' }}>
                  ${usdcRequired.toFixed(2)}
                </span>
                <span style={{ fontSize: 12, color: '#6b9b6b' }}>USDC</span>
                <span style={{ fontSize: 11, color: '#4a6a4a', marginLeft: 4 }}>
                  (${(usdcRequired / Number(buyAmount || 1)).toFixed(4)}/WTC)
                </span>
              </div>
            )}
          </div>

          {orderError && <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: 10 }}>{orderError}</div>}
          {orderMsg && <div style={{ color: '#4ade80', fontSize: 12, marginBottom: 10 }}>{orderMsg}</div>}

          {usdcRequired && (
            <div
              style={{
                fontSize: 11,
                color: '#6b9b6b',
                marginBottom: 10,
                lineHeight: 1.5,
                background: '#0d160d',
                border: '1px solid #1e3a1e',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              WTC will be sent to your wallet once 10,101 WTC is queued.
            </div>
          )}

          <button
            disabled={
              !usdcRequired ||
              !buyToAddress ||
              priceLoading ||
              !buyerEthAddress ||
              !buyerEthAddress.startsWith('0x') ||
              buyerEthAddress.length < 40
            }
            onClick={handlePlaceOrder}
            style={{
              width: '100%',
              padding: '12px 0',
              borderRadius: 10,
              border: 'none',
              background:
                !usdcRequired ||
                !buyToAddress ||
                priceLoading ||
                !buyerEthAddress ||
                !buyerEthAddress.startsWith('0x') ||
                buyerEthAddress.length < 40
                  ? '#1e3a1e'
                  : '#4ade80',
              color:
                !usdcRequired ||
                !buyToAddress ||
                priceLoading ||
                !buyerEthAddress ||
                !buyerEthAddress.startsWith('0x') ||
                buyerEthAddress.length < 40
                  ? '#4a6a4a'
                  : '#001008',
              fontWeight: 700,
              fontSize: 14,
              cursor:
                !usdcRequired ||
                !buyToAddress ||
                priceLoading ||
                !buyerEthAddress ||
                !buyerEthAddress.startsWith('0x') ||
                buyerEthAddress.length < 40
                  ? 'not-allowed'
                  : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {priceLoading
              ? 'Computing...'
              : !buyerEthAddress
                ? 'Enter your USDC wallet address'
                : usdcRequired
                  ? `Place Order — Pay $${usdcRequired.toFixed(2)} USDC`
                  : 'Enter amount to see price'}
          </button>
        </div>
      ) : (
        /* ── Active order card ─────────────────────────────────────────── */
        <div
          style={{
            background: '#0a1f0a',
            border: `1px solid ${orderStatus.status === 'fulfilled' ? '#4ade80' : optimisticPaid || orderStatus.status === 'payment_submitted' ? '#a7ffb0' : '#fbbf24'}`,
            borderRadius: 14,
            padding: '18px 20px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color:
                  orderStatus.status === 'fulfilled'
                    ? '#4ade80'
                    : optimisticPaid || orderStatus.status === 'payment_submitted'
                      ? '#a7ffb0'
                      : '#fbbf24',
              }}
            >
              {(optimisticPaid || orderStatus.status === 'payment_submitted') &&
                orderStatus.status !== 'queued' &&
                orderStatus.status !== 'fulfilled' &&
                'Payment Submitted — Pending Delivery'}
              {!optimisticPaid && orderStatus.status === 'pending_payment' && 'Awaiting Payment'}
              {orderStatus.status === 'queued' && 'Payment Received — Queued'}
              {orderStatus.status === 'fulfilled' && 'Complete!'}
              {orderStatus.status === 'failed' && 'Failed'}
              {orderStatus.status === 'expired' && 'Expired'}
            </div>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#4a6a4a' }}>{orderStatus.id}</span>
          </div>

          <div style={{ fontSize: 13, color: '#9ac79f', marginBottom: 14 }}>
            {orderStatus.wtcAmount?.toLocaleString()} WTC &rarr;{' '}
            <span style={{ fontFamily: 'monospace' }}>{orderStatus.wtcAddress || selectedWalletAddress}</span>
          </div>

          {orderStatus.status === 'pending_payment' && !optimisticPaid && (
            <>
              <div
                style={{
                  padding: '12px 14px',
                  background: '#091409',
                  border: '1px solid #2d4a2d',
                  borderRadius: 10,
                  marginBottom: 14,
                }}
              >
                <div style={{ fontSize: 13, color: '#fde68a', fontWeight: 700, marginBottom: 4 }}>
                  {orderStatus.wtcAmount?.toLocaleString()} WTC awaiting payment
                </div>
                <div style={{ fontSize: 11, color: '#6b9b6b', marginBottom: 8 }}>
                  Send exactly{' '}
                  <span style={{ color: '#fcd34d', fontWeight: 700 }}>
                    ${orderStatus.usdcRequired?.toFixed(2)} USDC
                  </span>{' '}
                  (Ethereum mainnet ERC-20) to:
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: '#0d160d',
                    border: '1px solid #2d4a2d',
                    borderRadius: 6,
                    padding: '7px 10px',
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{ fontFamily: 'monospace', fontSize: 11, color: '#a7ffb0', wordBreak: 'break-all', flex: 1 }}
                  >
                    {SELLER_USDC}
                  </span>
                  <button
                    onClick={copyUsdc}
                    style={{
                      background: copied ? '#4ade80' : '#1e3a1e',
                      color: copied ? '#001008' : '#b7f5bc',
                      border: 'none',
                      borderRadius: 6,
                      padding: '3px 8px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#4a6a4a' }}>Payment detected automatically within ~10 minutes.</div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setShowWalletModal(true)}
                  style={{
                    background: '#1e3a1e',
                    color: '#a7ffb0',
                    border: '1px solid #4ade80',
                    borderRadius: 8,
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Pay with Wallet
                </button>
                <button
                  onClick={handleCancelOrder}
                  style={{
                    background: 'transparent',
                    color: '#6b9b6b',
                    border: '1px solid #2d4a2d',
                    borderRadius: 8,
                    padding: '9px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel Order
                </button>
              </div>
            </>
          )}

          {(orderStatus.status === 'queued' ||
            orderStatus.status === 'payment_submitted' ||
            (optimisticPaid && orderStatus.status === 'pending_payment')) && (
            <div style={{ padding: '12px 14px', background: '#091409', border: '1px solid #2d4a2d', borderRadius: 10 }}>
              <div style={{ fontSize: 13, color: '#a7ffb0', fontWeight: 700, marginBottom: 4 }}>
                {orderStatus.wtcAmount?.toLocaleString()} WTC pending delivery
              </div>
              <div style={{ fontSize: 11, color: '#6b9b6b' }}>
                Payment confirmed — WTC will be sent once 10,101 WTC is queued network-wide.
              </div>
              {(orderStatus.status === 'payment_submitted' ||
                (optimisticPaid && orderStatus.status === 'pending_payment')) && (
                <div style={{ fontSize: 11, color: '#7a6a3a', marginTop: 4 }}>
                  Payment detection may take up to 10 minutes.
                </div>
              )}
            </div>
          )}

          {orderMsg && <div style={{ marginTop: 12, fontSize: 13, color: '#4ade80', fontWeight: 600 }}>{orderMsg}</div>}
          {orderError && <div style={{ marginTop: 12, fontSize: 13, color: '#fca5a5' }}>{orderError}</div>}

          {(orderStatus.status === 'queued' ||
            orderStatus.status === 'payment_submitted' ||
            (optimisticPaid && orderStatus.status === 'pending_payment') ||
            orderStatus.status === 'fulfilled' ||
            orderStatus.status === 'failed' ||
            orderStatus.status === 'expired' ||
            orderStatus.status === 'cancelled') && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button
                onClick={() => {
                  if (orderPollRef.iv) {
                    clearInterval(orderPollRef.iv);
                    orderPollRef.iv = null;
                  }
                  setOrderId(null);
                  setOrderStatus(null);
                  setOrderMsg('');
                  setOrderError('');
                  setBuyAmount('');
                  setUsdcRequired(null);
                  setOptimisticPaid(false);
                  setShowWalletModal(false);
                }}
                style={{
                  background: '#1e3a1e',
                  color: '#b7f5bc',
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 18px',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {orderStatus.status === 'queued' ||
                orderStatus.status === 'payment_submitted' ||
                (optimisticPaid && orderStatus.status === 'pending_payment')
                  ? 'Place New Order'
                  : 'Place Another Order'}
              </button>
              {(orderStatus.status === 'queued' ||
                orderStatus.status === 'payment_submitted' ||
                (optimisticPaid && orderStatus.status === 'pending_payment')) && (
                <button
                  onClick={handleCancelOrder}
                  style={{
                    background: 'transparent',
                    color: '#6b9b6b',
                    border: '1px solid #2d4a2d',
                    borderRadius: 8,
                    padding: '9px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel Order
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: '#4a6a4a', lineHeight: 1.5 }}>
        Prices are in USD based on live global average electricity cost to mine WTC.
      </div>

      {showWalletModal && orderStatus && (
        <WalletPayModal
          orderId={orderId}
          usdcRequired={orderStatus.usdcRequired || 0}
          wtcAmount={orderStatus.wtcAmount}
          onPaid={() => {
            setOptimisticPaid(true);
            setShowWalletModal(false);
          }}
          onManual={() => {
            setOptimisticPaid(true);
            setShowWalletModal(false);
          }}
          onClose={() => setShowWalletModal(false)}
        />
      )}
    </div>
  );
}

// ─── NFT Tier Status Bar ──────────────────────────────────────────────────────
const NFT_TIER_BRONZE = 5_000;
const NFT_TIER_SILVER = 15_000;
const NFT_TIER_GOLD = 25_000;

function NftTierStatusBar({ purchasedWtc = 0 }) {
  const [animPct, setAnimPct] = React.useState(0);
  React.useEffect(() => {
    const pct = (Math.min(Math.max(0, purchasedWtc), NFT_TIER_GOLD) / NFT_TIER_GOLD) * 100;
    const t = setTimeout(() => setAnimPct(pct), 80);
    return () => clearTimeout(t);
  }, [purchasedWtc]);

  const hasBronze = purchasedWtc >= NFT_TIER_BRONZE;
  const hasSilver = purchasedWtc >= NFT_TIER_SILVER;
  const hasGold = purchasedWtc >= NFT_TIER_GOLD;

  // Gradient spanning the full bar (0–25 000 WTC):
  // 0 % = 0 WTC, 20 % = 5 000 (Bronze), 60 % = 15 000 (Silver), 100 % = 25 000 (Gold)
  const fillGradient = 'linear-gradient(90deg, #d97706 0%, #c47a12 20%, #9ca3af 60%, #fbbf24 100%)';
  const glowColor = hasGold ? '#fbbf24' : hasSilver ? '#9ca3af' : '#d97706';

  let toGo = null;
  let toGoTier = '';
  let toGoColor = '#d97706';
  if (!hasBronze) {
    toGo = NFT_TIER_BRONZE - purchasedWtc;
    toGoTier = 'Bronze';
    toGoColor = '#d97706';
  } else if (!hasSilver) {
    toGo = NFT_TIER_SILVER - purchasedWtc;
    toGoTier = 'Silver';
    toGoColor = '#9ca3af';
  } else if (!hasGold) {
    toGo = NFT_TIER_GOLD - purchasedWtc;
    toGoTier = 'Gold';
    toGoColor = '#fbbf24';
  }

  const badges = [
    { label: 'Bronze', color: '#d97706', bg: '#2a1500', reached: hasBronze },
    { label: 'Silver', color: '#9ca3af', bg: '#1a1a1e', reached: hasSilver },
    { label: 'Gold', color: '#fbbf24', bg: '#2d2200', reached: hasGold },
  ];

  return (
    <div
      style={{
        background: '#0a140a',
        border: '1px solid #1e3a1e',
        borderRadius: 12,
        padding: '11px 16px',
        marginBottom: 14,
      }}
    >
      {/* Header row: label + amount + badges | thresholds */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 9,
              color: '#4ade80',
              letterSpacing: '0.1em',
              whiteSpace: 'nowrap',
            }}
          >
            PURCHASED WTC
          </span>
          <span
            style={{ fontSize: 15, fontWeight: 700, color: '#e8f5e8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}
          >
            {Math.floor(purchasedWtc).toLocaleString()}
          </span>
          <div style={{ display: 'flex', gap: 5 }}>
            {badges.map((b) => (
              <span
                key={b.label}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 99,
                  color: b.reached ? b.color : '#3a4a3a',
                  background: b.reached ? b.bg : '#111a11',
                  border: `1px solid ${b.reached ? b.color : '#1e3a1e'}`,
                  boxShadow: b.reached ? `0 0 7px ${b.color}55` : 'none',
                  transition: 'all 0.5s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {b.label}
              </span>
            ))}
          </div>
        </div>
        {/* Tier thresholds — always visible top-right */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            fontSize: 9,
            fontFamily: "'DM Mono', monospace",
            flexShrink: 0,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          <span style={{ color: hasBronze ? '#d97706' : '#5a3a10' }}>Bronze&nbsp;5,000</span>
          <span style={{ color: hasSilver ? '#9ca3af' : '#3a3a45' }}>Silver&nbsp;15,000</span>
          <span style={{ color: hasGold ? '#fbbf24' : '#5a4a10' }}>Gold&nbsp;25,000</span>
        </div>
      </div>

      {/* Animated progress bar */}
      <div style={{ height: 7, background: '#172a17', borderRadius: 99, overflow: 'hidden', position: 'relative' }}>
        {/* Tier marker lines */}
        <div
          style={{
            position: 'absolute',
            left: '20%',
            top: 0,
            bottom: 0,
            width: 1,
            background: '#d97706',
            opacity: 0.45,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '60%',
            top: 0,
            bottom: 0,
            width: 1,
            background: '#9ca3af',
            opacity: 0.45,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
        {/* Fill */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${animPct}%`,
            background: fillGradient,
            borderRadius: 99,
            transition: 'width 1.3s ease-out',
            boxShadow: animPct > 0 ? `0 0 7px ${glowColor}88` : 'none',
          }}
        />
      </div>

      {/* Bottom row: X WTC to go */}
      <div style={{ marginTop: 5, fontSize: 11, minHeight: 16 }}>
        {toGo !== null ? (
          <>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: toGoColor }}>
              {Math.ceil(toGo).toLocaleString()}
            </span>
            <span style={{ color: '#5a7a5a', marginLeft: 4 }}>WTC to {toGoTier}</span>
          </>
        ) : (
          <span style={{ color: '#fbbf24', fontWeight: 700 }}>✦ Gold tier reached</span>
        )}
      </div>
    </div>
  );
}

function WalletTab({
  coins,
  maturedCoins,
  unmaturedCoins,
  energy: _energy,
  selectedWalletAddress,
  walletSyncState,
  refreshBalances,
  onAddressChange,
  purchasedWtc = 0,
}) {
  const [walletView, setWalletView] = React.useState('sale');
  const [networkInfo, setNetworkInfo] = React.useState({ network: 'regtest', explorerBaseUrl: '' });
  const [betaPolicy, setBetaPolicy] = React.useState({
    loading: true,
    betaMode: false,
    withdrawalsEnabled: true,
    resetWipePolicy: false,
    policyMessage: '',
  });
  const walletReadiness =
    walletSyncState && walletSyncState.walletReadiness
      ? walletSyncState.walletReadiness
      : createDefaultWalletReadiness();
  const [sentTxHistory, setSentTxHistory] = React.useState(() => loadPersistedSentTransactions());
  const [transactions, setTransactions] = React.useState([]);
  const [transactionsBusy, setTransactionsBusy] = React.useState(false);
  const [transactionsStatus, setTransactionsStatus] = React.useState('');
  const [withdrawAddress, setWithdrawAddress] = React.useState('');
  const [withdrawAmount, setWithdrawAmount] = React.useState('');
  const [subtractFeeFromAmount, setSubtractFeeFromAmount] = React.useState(false);
  const [withdrawBusy, setWithdrawBusy] = React.useState(false);
  const [withdrawMessage, setWithdrawMessage] = React.useState('');
  const [withdrawTxid, setWithdrawTxid] = React.useState('');
  const [withdrawPending, setWithdrawPending] = React.useState(false); // true while polling for confirmation
  const txStatusPollRef = React.useRef(null); // interval id
  const txStatusTimeoutRef = React.useRef(null); // timeout id
  // Address validation state
  const [addrValidation, setAddrValidation] = React.useState({ state: 'empty', reason: '' }); // 'empty'|'checking'|'valid'|'invalid'
  const addrValidationTimer = React.useRef(null);
  const [showSendConfirm, setShowSendConfirm] = React.useState(false);
  const [queuedSaleOrders, setQueuedSaleOrders] = React.useState([]);
  const [orderId, setOrderId] = React.useState(null);
  const [orderStatus, setOrderStatus] = React.useState(null);
  const [orderPollRef] = React.useState({ iv: null });
  // Vortex NFT state
  const [nfts, setNfts] = React.useState([]);
  const [nftsBusy, setNftsBusy] = React.useState(false);
  const [nftTransferTarget, setNftTransferTarget] = React.useState(null);
  const [nftTransferAddress, setNftTransferAddress] = React.useState('');
  const [nftTransferMsg, setNftTransferMsg] = React.useState('');

  const nodeMatured = Math.max(0, Number(maturedCoins) || 0);
  const nodeUnmatured = Math.max(0, Number(unmaturedCoins) || 0);
  const nodeTotal = Math.max(Number(coins) || 0, nodeMatured + nodeUnmatured);
  const displayTotal = Math.max(0, nodeTotal);
  const displayMatured = Math.max(0, nodeMatured);
  const displayUnmatured = Math.max(0, nodeUnmatured);

  const formatTxTime = React.useCallback((unixSeconds) => {
    const ts = Number(unixSeconds) || 0;
    if (!ts) return '-';
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch (_) {
      return '-';
    }
  }, []);

  // ── Poll order status after placing ──────────────────────────────────────
  const startOrderPoll = useCallback(
    (id, callbacks = {}) => {
      if (orderPollRef.iv) clearInterval(orderPollRef.iv);
      orderPollRef.iv = setInterval(async () => {
        try {
          const r = await window.wattcoinHardware.invoke('wattcoin-sale-get-order', id);
          if (r && r.ok && r.order) {
            setOrderStatus(r.order);
            if (r.order.status === 'queued' || r.order.status === 'delivery_pending') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              setOrderId(null);
              setOrderStatus(null);
              setQueuedSaleOrders((prev) => prev.filter((o) => o.id !== id));
              if (callbacks.onConfirmed) callbacks.onConfirmed();
            } else if (r.order.status === 'fulfilled') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              if (callbacks.onFulfilled) callbacks.onFulfilled();
            } else if (r.order.status === 'failed') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              if (callbacks.onFailed) callbacks.onFailed();
            } else if (r.order.status === 'expired') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              if (callbacks.onExpired) callbacks.onExpired();
            }
          }
        } catch (_) {
          /* istanbul ignore next */
        }
      }, 10_000);
    },
    [orderPollRef],
  );

  React.useEffect(() => {
    try {
      const compact = Array.isArray(sentTxHistory) ? sentTxHistory.slice(0, MAX_PERSISTED_SENT_TXS) : [];
      localStorage.setItem(SENT_TX_HISTORY_STORAGE_KEY, JSON.stringify(compact));
    } catch (_) {
      // Ignore storage errors in restricted environments.
    }
  }, [sentTxHistory]);

  const loadTransactions = React.useCallback(async () => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setTransactionsStatus('Wallet API unavailable.');
      return;
    }
    setTransactionsBusy(true);
    setTransactionsStatus('Loading transactions...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-list-transactions', {
        selectedAddress: selectedWalletAddress || '',
        count: 50,
      });
      if (res && res.ok) {
        const rows = Array.isArray(res.transactions) ? res.transactions : [];
        const filteredLocalHistory = sentTxHistory.filter((tx) => {
          if (!tx || typeof tx !== 'object') return false;
          if (tx.network !== networkInfo.network) return false;
          if (!selectedWalletAddress) return true;
          return !tx.selectedAddress || tx.selectedAddress === selectedWalletAddress;
        });

        const chainTxIds = new Set(rows.map((tx) => tx && tx.txid).filter(Boolean));
        const merged = [...rows];
        filteredLocalHistory.forEach((tx) => {
          if (!chainTxIds.has(tx.txid)) {
            merged.push(tx);
          }
        });
        merged.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));

        setTransactions(merged);
        setTransactionsStatus(merged.length === 0 ? 'No transactions yet.' : '');

        if (chainTxIds.size > 0) {
          setSentTxHistory((prev) => {
            const next = prev.filter((tx) => !chainTxIds.has(tx.txid));
            return next.length === prev.length ? prev : next;
          });
        }
      } else {
        setTransactions([]);
        setTransactionsStatus(`Failed to load transactions: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setTransactions([]);
      setTransactionsStatus(`Failed to load transactions: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setTransactionsBusy(false);
  }, [networkInfo.network, selectedWalletAddress, sentTxHistory]);

  React.useEffect(() => {
    if (walletView !== 'transactions') return;
    loadTransactions();
  }, [walletView, loadTransactions]);

  // Load Vortex NFTs owned by the selected address
  const loadNfts = React.useCallback(() => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    setNftsBusy(true);
    setNftTransferMsg('');
    if (!selectedWalletAddress) {
      setNftsBusy(false);
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-nft-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setNfts(res.nfts || []);
      })
      .catch(() => {})
      .finally(() => setNftsBusy(false));
  }, [selectedWalletAddress]);

  React.useEffect(() => {
    if (walletView !== 'nfts') return;
    loadNfts();
  }, [walletView, loadNfts]);

  React.useEffect(() => {
    let cancelled = false;
    async function loadBetaPolicy() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
        if (!cancelled) {
          setBetaPolicy({
            loading: false,
            betaMode: false,
            withdrawalsEnabled: true,
            resetWipePolicy: false,
            policyMessage: '',
          });
        }
        return;
      }
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-beta-policy');
        if (!cancelled && res && res.ok) {
          setBetaPolicy({
            loading: false,
            betaMode: !!res.betaMode,
            withdrawalsEnabled: !!res.withdrawalsEnabled,
            resetWipePolicy: !!res.resetWipePolicy,
            policyMessage: typeof res.policyMessage === 'string' ? res.policyMessage : '',
          });
        }
      } catch (_) {
        if (!cancelled) {
          setBetaPolicy({
            loading: false,
            betaMode: false,
            withdrawalsEnabled: true,
            resetWipePolicy: false,
            policyMessage: '',
          });
        }
      }
    }
    async function loadNetworkInfo() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-network-info');
        if (!cancelled && res && res.ok) {
          setNetworkInfo({
            network: typeof res.network === 'string' ? res.network : 'regtest',
            explorerBaseUrl: typeof res.explorerBaseUrl === 'string' ? res.explorerBaseUrl : '',
          });
        }
      } catch (_) {
        // Keep default network info.
      }
    }
    loadBetaPolicy();
    loadNetworkInfo();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load queued/pending sale orders for this address — also restores orderStatus on app restart
  const orderStatusRestoredRef = React.useRef(false);
  React.useEffect(() => {
    if (!selectedWalletAddress || !(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    let cancelled = false;
    function loadQueued() {
      window.wattcoinHardware
        .invoke('wattcoin-sale-get-my-orders', selectedWalletAddress)
        .then((res) => {
          if (cancelled || !res || !res.ok || !Array.isArray(res.orders)) return;
          setQueuedSaleOrders(res.orders);
          // Restore orderStatus if it was lost (app restart / tab switch)
          if (!orderStatusRestoredRef.current && res.orders.length > 0) {
            orderStatusRestoredRef.current = true;
            // Pick the most recent active order
            const active = res.orders.slice().sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0))[0];
            setOrderStatus((prev) => {
              if (prev) return prev; // already set
              return active;
            });
            setOrderId((prev) => prev || active.id);
            startOrderPoll(active.id);
          }
        })
        .catch(() => {});
    }
    loadQueued();
    const iv = setInterval(loadQueued, 15_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [selectedWalletAddress, startOrderPoll]);

  function handleWithdrawAddressChange(raw) {
    setWithdrawAddress(raw);
    setWithdrawMessage('');
    setWithdrawTxid('');
    const trimmed = raw.trim();
    if (!trimmed) {
      setAddrValidation({ state: 'empty', reason: '' });
      return;
    }
    setAddrValidation({ state: 'checking', reason: '' });
    if (addrValidationTimer.current) clearTimeout(addrValidationTimer.current);
    addrValidationTimer.current = setTimeout(async () => {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
        setAddrValidation({ state: 'invalid', reason: 'API unavailable' });
        return;
      }
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-validate-address', trimmed);
        if (res && res.ok) {
          setAddrValidation({ state: res.valid ? 'valid' : 'invalid', reason: res.reason || '' });
        } else {
          setAddrValidation({ state: 'invalid', reason: 'Validation failed' });
        }
      } catch (_) {
        setAddrValidation({ state: 'invalid', reason: 'Validation error' });
      }
    }, 350);
  }

  function _stopTxPoll() {
    if (txStatusPollRef.current) {
      clearInterval(txStatusPollRef.current);
      txStatusPollRef.current = null;
    }
    if (txStatusTimeoutRef.current) {
      clearTimeout(txStatusTimeoutRef.current);
      txStatusTimeoutRef.current = null;
    }
  }

  function _startTxConfirmPoll(txid) {
    _stopTxPoll();
    setWithdrawPending(true);

    let unknownCount = 0; // grace counter for 'unknown' status

    // Poll every 5 s — tx confirms in the next naturally-mined block
    txStatusPollRef.current = setInterval(async () => {
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-tx-status', { txid });
        if (res && res.status === 'confirmed') {
          _stopTxPoll();
          setWithdrawPending(false);
          setWithdrawMessage('Transaction confirmed.');
          if (typeof refreshBalances === 'function') refreshBalances();
          if (walletView === 'transactions') loadTransactions();
          if (walletView === 'nfts') loadNfts();
          return;
        }
        // 'pending' — tx is in mempool, waiting for next block → keep polling
        if (res && res.status === 'pending') {
          unknownCount = 0; // reset if it was briefly unknown
          return;
        }
        // 'unknown' — tx is not in mempool or chain; allow 3 consecutive unknowns
        // before declaring failure (brief network hiccup protection)
        if (res && res.status === 'unknown') {
          unknownCount++;
          if (unknownCount >= 3) {
            _stopTxPoll();
            setWithdrawPending(false);
            setWithdrawMessage('Transaction not found in mempool. It may have been dropped — please try again.');
          }
        }
      } catch (_) {
        /* ignore transient errors, keep polling */
      }
    }, 5000);

    // Soft timeout — just stop spinning after 1 day, don't declare failure
    // (mining may be slow; user can check the Explorer)
    txStatusTimeoutRef.current = setTimeout(
      () => {
        _stopTxPoll();
        setWithdrawPending(false);
        setWithdrawMessage('Transaction submitted — check the Explorer to confirm it landed in a block.');
      },
      24 * 60 * 60 * 1000,
    ); // 1 day
  }

  async function executeWithdrawal() {
    setShowSendConfirm(false);
    const toAddress = (withdrawAddress || '').trim();
    const amount = Number(withdrawAmount);
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setWithdrawTxid('');
      setWithdrawMessage('Wallet API unavailable.');
      return;
    }
    setWithdrawBusy(true);
    setWithdrawTxid('');
    setWithdrawMessage('Sending transaction...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-send', {
        toAddress,
        amount,
        subtractFeeFromAmount,
        selectedAddress: selectedWalletAddress || '',
      });
      if (res && res.ok) {
        setSentTxHistory((prev) =>
          [
            {
              txid: res.txid || '',
              category: 'send',
              direction: 'out',
              amount: -Math.abs(Number(res.amount) || amount),
              confirmations: 0,
              address: toAddress,
              time: Math.floor(Date.now() / 1000),
              network: networkInfo.network,
              selectedAddress: selectedWalletAddress || '',
              localOnly: true,
            },
            ...prev.filter((tx) => tx && tx.txid !== res.txid),
          ].slice(0, MAX_PERSISTED_SENT_TXS),
        );
        setWithdrawTxid(res.txid || '');
        setWithdrawMessage('Transaction sent. Waiting to be included in next block…');
        setWithdrawAddress('');
        setWithdrawAmount('');
        setAddrValidation({ state: 'empty', reason: '' });
        _startTxConfirmPoll(res.txid || '');
      } else {
        setWithdrawTxid('');
        setWithdrawMessage(`Withdrawal failed: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setWithdrawTxid('');
      setWithdrawMessage(`Withdrawal failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setWithdrawBusy(false);
  }

  function submitWithdrawal() {
    if (!walletReadiness.spendReady) {
      setWithdrawTxid('');
      setWithdrawMessage('Withdrawals are disabled until wallet sync is ready.');
      return;
    }
    if (betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled) {
      setWithdrawTxid('');
      setWithdrawMessage(betaPolicy.policyMessage || 'Withdrawals are disabled during closed beta.');
      return;
    }
    const toAddress = (withdrawAddress || '').trim();
    const amount = Number(withdrawAmount);

    if (!toAddress) {
      setWithdrawTxid('');
      setWithdrawMessage('Recipient address is required.');
      return;
    }
    if (addrValidation.state === 'invalid') {
      setWithdrawTxid('');
      setWithdrawMessage(`Invalid address: ${addrValidation.reason || 'does not pass validation'}`);
      return;
    }
    if (addrValidation.state !== 'valid') {
      setWithdrawTxid('');
      setWithdrawMessage('Please wait for address validation to complete.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawTxid('');
      setWithdrawMessage('Amount must be greater than 0.');
      return;
    }
    if (!subtractFeeFromAmount && amount > displayMatured) {
      setWithdrawTxid('');
      setWithdrawMessage(`Amount exceeds matured balance (${displayMatured.toFixed(8)} WTC).`);
      return;
    }
    // Show confirmation modal — actual send happens in executeWithdrawal()
    setShowSendConfirm(true);
  }

  return (
    <div
      style={{
        color: '#e8f5e8',
        fontFamily: "'DM Mono', monospace",
        fontSize: 22,
        maxWidth: 640,
        margin: '60px auto 0 auto',
        background: '#122612',
        borderRadius: 18,
        boxShadow: '0 2px 16px #0008',
        padding: '36px 36px 28px 36px',
        border: '2px solid #1e3a1e',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'nowrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 28, color: '#4ade80', fontWeight: 700, lineHeight: 1 }}>Wallet</div>
          <span
            style={{
              fontSize: 11,
              color: networkInfo.network === 'testnet' ? '#fbbf24' : '#9ac79f',
              background: '#1e3a1e',
              borderRadius: 999,
              padding: '4px 8px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {networkInfo.network}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={() => setWalletView('explorer')}
            style={{
              background: walletView === 'explorer' ? '#4ade80' : '#1e3a1e',
              color: walletView === 'explorer' ? '#001008' : '#b7f5bc',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Explorer
          </button>
          <button
            onClick={() => setWalletView('sale')}
            style={{
              background: walletView === 'sale' ? '#4ade80' : '#1e3a1e',
              color: walletView === 'sale' ? '#001008' : '#b7f5bc',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Buy
          </button>
          <button
            onClick={() => setWalletView('staking')}
            style={{
              background: walletView === 'staking' ? '#4ade80' : '#1e3a1e',
              color: walletView === 'staking' ? '#001008' : '#b7f5bc',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Staking
          </button>
          <button
            onClick={() => setWalletView('overview')}
            style={{
              background: walletView === 'overview' ? '#4ade80' : '#1e3a1e',
              color: walletView === 'overview' ? '#001008' : '#b7f5bc',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Overview
          </button>
          <button
            onClick={() => setWalletView('transactions')}
            style={{
              background: walletView === 'transactions' ? '#4ade80' : '#1e3a1e',
              color: walletView === 'transactions' ? '#001008' : '#b7f5bc',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            Transactions
          </button>
          <button
            onClick={() => setWalletView('nfts')}
            style={{
              background: walletView === 'nfts' ? '#4ade80' : '#1e3a1e',
              color: walletView === 'nfts' ? '#001008' : '#b7f5bc',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            NFTs
          </button>
        </div>
      </div>
      <WalletAddressDisplay
        selectedWalletAddress={selectedWalletAddress}
        walletSyncState={walletSyncState}
        onAddressChange={onAddressChange}
      />
      <NftTierStatusBar purchasedWtc={purchasedWtc} />
      {betaPolicy.betaMode && (
        <div
          style={{
            marginTop: 10,
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 10,
            background: '#2a180c',
            border: '1px solid #7c4a18',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>Closed Beta Policy</div>
          <div style={{ fontSize: 12, color: '#fde68a', marginBottom: 4 }}>
            {betaPolicy.policyMessage || 'Balances are test-only and withdrawals are disabled during beta.'}
          </div>
          {betaPolicy.resetWipePolicy && (
            <div style={{ fontSize: 11, color: '#fcd34d' }}>Beta balances may be reset or wiped at any time.</div>
          )}
        </div>
      )}

      {queuedSaleOrders.filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted').length >
        0 && (
        <div
          style={{
            marginTop: 8,
            marginBottom: 4,
            padding: '10px 14px',
            background: '#12100a',
            border: '1px solid #3d3000',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#fbbf24', letterSpacing: '0.1em' }}>
            SALE QUEUE
          </span>
          <span style={{ fontFamily: 'monospace', fontSize: 15, color: '#fcd34d', fontWeight: 700 }}>
            +
            {queuedSaleOrders
              .filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted')
              .reduce((s, o) => s + (o.wtcAmount || 0), 0)
              .toLocaleString()}{' '}
            WTC
          </span>
          <span style={{ fontSize: 11, color: '#7a6a3a' }}>
            {queuedSaleOrders.some((o) => o.status === 'payment_submitted')
              ? 'paid — awaiting confirmation (up to 10 min)'
              : 'awaiting payment — up to 10 min to detect'}
          </span>
        </div>
      )}

      {walletView === 'overview' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#a7ffb0', fontWeight: 600 }}>Total mined coins:</span>
            <span
              style={{
                fontFamily: 'monospace',
                marginLeft: 12,
                fontSize: 20,
                background: '#1e3a1e',
                padding: '4px 10px',
                borderRadius: 8,
              }}
            >
              {`${displayTotal.toLocaleString(undefined, { maximumFractionDigits: 6 })} WTC`}
            </span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#a7ffb0', fontWeight: 600 }}>Matured coins:</span>
            <span
              style={{
                fontFamily: 'monospace',
                marginLeft: 12,
                fontSize: 20,
                background: '#1e3a1e',
                padding: '4px 10px',
                borderRadius: 8,
              }}
            >
              {`${displayMatured.toLocaleString(undefined, { maximumFractionDigits: 6 })} WTC`}
            </span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#a7ffb0', fontWeight: 600 }}>Unmatured coins:</span>
            <span
              style={{
                fontFamily: 'monospace',
                marginLeft: 12,
                fontSize: 20,
                background: '#1e3a1e',
                padding: '4px 10px',
                borderRadius: 8,
              }}
            >
              {`${displayUnmatured.toLocaleString(undefined, { maximumFractionDigits: 6 })} WTC`}
            </span>
          </div>
          {(() => {
            const queuedWtc = queuedSaleOrders
              .filter((o) => o.status === 'queued' || o.status === 'delivery_pending')
              .reduce((s, o) => s + (o.wtcAmount || 0), 0);
            if (!queuedWtc) return null;
            return (
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: '#fcd34d', fontWeight: 600 }}>Queued for delivery:</span>
                <span
                  style={{
                    fontFamily: 'monospace',
                    marginLeft: 12,
                    fontSize: 20,
                    background: '#12100a',
                    border: '1px solid #3d3000',
                    padding: '4px 10px',
                    borderRadius: 8,
                    color: '#fcd34d',
                  }}
                >
                  {`+${queuedWtc.toLocaleString()} WTC`}
                </span>
                <span style={{ marginLeft: 8, fontSize: 11, color: '#7a6a3a' }}>purchased — pending batch send</span>
              </div>
            );
          })()}
          <div style={{ marginTop: 10, fontSize: 14, color: '#9ac79f' }}>
            Source: backend round-ledger (node-side accounting)
          </div>

          <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid #1e3a1e' }}>
            <div style={{ fontSize: 18, color: '#4ade80', marginBottom: 10, fontWeight: 700 }}>Withdraw WTC</div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ color: '#a7ffb0', fontWeight: 600, fontSize: 14 }}>Recipient address</div>
                {addrValidation.state === 'checking' && (
                  <span style={{ fontSize: 11, color: '#9ac79f' }}>Validating…</span>
                )}
                {addrValidation.state === 'valid' && (
                  <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>✓ Valid WTC address</span>
                )}
                {addrValidation.state === 'invalid' && (
                  <span style={{ fontSize: 11, color: '#f87171', fontWeight: 700 }}>
                    ✕ {addrValidation.reason || 'Invalid address'}
                  </span>
                )}
              </div>
              <input
                type="text"
                value={withdrawAddress}
                onChange={(e) => handleWithdrawAddressChange(e.target.value)}
                placeholder="wtc1q…"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  background: '#0d1a0d',
                  color: '#d7ffd9',
                  border: `1px solid ${addrValidation.state === 'valid' ? '#4ade80' : addrValidation.state === 'invalid' ? '#f87171' : '#2a4a2a'}`,
                  borderRadius: 8,
                  padding: '9px 10px',
                }}
                disabled={
                  withdrawBusy || betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled || !walletReadiness.spendReady
                }
              />
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ color: '#a7ffb0', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>Amount (WTC)</div>
              <input
                type="number"
                min="0"
                step="0.00000001"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00000000"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  background: '#0d1a0d',
                  color: '#d7ffd9',
                  border: '1px solid #2a4a2a',
                  borderRadius: 8,
                  padding: '9px 10px',
                }}
                disabled={
                  withdrawBusy || betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled || !walletReadiness.spendReady
                }
              />
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                color: '#9ac79f',
                marginBottom: 12,
                cursor: withdrawBusy ? 'default' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={subtractFeeFromAmount}
                onChange={(e) => setSubtractFeeFromAmount(e.target.checked)}
                disabled={
                  withdrawBusy || betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled || !walletReadiness.spendReady
                }
              />
              Subtract network fee from sent amount
            </label>

            <button
              onClick={submitWithdrawal}
              disabled={
                withdrawBusy ||
                betaPolicy.betaMode ||
                !betaPolicy.withdrawalsEnabled ||
                !walletReadiness.spendReady ||
                addrValidation.state !== 'valid'
              }
              style={{
                background:
                  withdrawBusy ||
                  betaPolicy.betaMode ||
                  !betaPolicy.withdrawalsEnabled ||
                  !walletReadiness.spendReady ||
                  addrValidation.state !== 'valid'
                    ? '#275a2f'
                    : '#4ade80',
                color:
                  withdrawBusy ||
                  betaPolicy.betaMode ||
                  !betaPolicy.withdrawalsEnabled ||
                  !walletReadiness.spendReady ||
                  addrValidation.state !== 'valid'
                    ? '#9fd4a8'
                    : '#001008',
                border: 'none',
                borderRadius: 8,
                padding: '9px 14px',
                fontWeight: 700,
                cursor:
                  withdrawBusy ||
                  betaPolicy.betaMode ||
                  !betaPolicy.withdrawalsEnabled ||
                  !walletReadiness.spendReady ||
                  addrValidation.state !== 'valid'
                    ? 'default'
                    : 'pointer',
                fontSize: 13,
              }}
            >
              {betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled
                ? 'Withdrawals Disabled In Beta'
                : !walletReadiness.spendReady
                  ? 'Withdrawals Locked Until Sync Ready'
                  : withdrawBusy
                    ? 'Sending...'
                    : 'Send Withdrawal'}
            </button>

            {withdrawMessage && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  color: withdrawMessage.startsWith('Transaction confirmed')
                    ? '#4ade80'
                    : withdrawMessage.startsWith('Transaction failed')
                      ? '#fca5a5'
                      : '#fcd34d',
                }}
              >
                {withdrawPending && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 11,
                      height: 11,
                      borderRadius: '50%',
                      border: '2px solid #fcd34d',
                      borderTopColor: 'transparent',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                )}
                {withdrawMessage}
              </div>
            )}

            {withdrawTxid && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#9ac79f', wordBreak: 'break-all' }}>
                TXID: {withdrawTxid}
              </div>
            )}
          </div>

          {/* Send confirmation modal */}
          {showSendConfirm && (
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,0.82)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 3000,
              }}
            >
              <div
                style={{
                  background: '#0f1f0f',
                  border: '2px solid #f59e0b',
                  borderRadius: 14,
                  padding: 28,
                  minWidth: 360,
                  maxWidth: 520,
                  color: '#fef3c7',
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color: '#f59e0b', marginBottom: 14 }}>
                  ⚠ Confirm Withdrawal
                </div>
                <div style={{ fontSize: 13, color: '#d1fae5', marginBottom: 6 }}>You are about to send:</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#4ade80', marginBottom: 12 }}>
                  {Number(withdrawAmount).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC
                </div>
                <div style={{ fontSize: 12, color: '#9ac79f', marginBottom: 4 }}>To address:</div>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: 'monospace',
                    color: '#d7ffd9',
                    background: '#0d1a0d',
                    border: '1px solid #2a4a2a',
                    borderRadius: 6,
                    padding: '8px 10px',
                    wordBreak: 'break-all',
                    marginBottom: 14,
                  }}
                >
                  {(withdrawAddress || '').trim()}
                </div>
                {subtractFeeFromAmount && (
                  <div style={{ fontSize: 12, color: '#fcd34d', marginBottom: 10 }}>
                    Network fee will be subtracted from the sent amount.
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 18 }}>
                  This transaction is irreversible. Double-check the address above before confirming.
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowSendConfirm(false)}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 7,
                      border: '1px solid #7c2d12',
                      background: 'transparent',
                      color: '#fcd34d',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={executeWithdrawal}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 7,
                      border: 'none',
                      background: '#f59e0b',
                      color: '#1f1100',
                      cursor: 'pointer',
                      fontWeight: 700,
                      fontSize: 13,
                    }}
                  >
                    Confirm Send
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {walletView === 'explorer' && <ExplorerView />}

      {walletView === 'sale' && (
        <SaleView
          selectedWalletAddress={selectedWalletAddress}
          setQueuedSaleOrders={setQueuedSaleOrders}
          orderId={orderId}
          setOrderId={setOrderId}
          orderStatus={orderStatus}
          setOrderStatus={setOrderStatus}
          orderPollRef={orderPollRef}
          startOrderPoll={startOrderPoll}
        />
      )}

      {walletView === 'staking' && (
        <StakingView
          selectedWalletAddress={selectedWalletAddress}
          walletBalance={maturedCoins}
          queuedWtc={queuedSaleOrders
            .filter((o) => o.status === 'queued' || o.status === 'delivery_pending')
            .reduce((s, o) => s + (o.wtcAmount || 0), 0)}
        />
      )}

      {walletView === 'transactions' && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>Recent Transactions</div>
            <button
              onClick={loadTransactions}
              disabled={transactionsBusy}
              style={{
                background: transactionsBusy ? '#275a2f' : '#4ade80',
                color: transactionsBusy ? '#9fd4a8' : '#001008',
                border: 'none',
                borderRadius: 8,
                padding: '7px 12px',
                fontWeight: 700,
                cursor: transactionsBusy ? 'default' : 'pointer',
                fontSize: 12,
              }}
            >
              {transactionsBusy ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {transactionsStatus && (
            <div
              style={{
                marginBottom: 10,
                fontSize: 13,
                color: transactionsStatus.startsWith('Failed') ? '#fca5a5' : '#9ac79f',
              }}
            >
              {transactionsStatus}
            </div>
          )}

          <div style={{ display: 'grid', gap: 8 }}>
            {transactions.map((tx, idx) => {
              const amount = Number(tx.amount) || 0;
              const outgoing = amount < 0;
              return (
                <div
                  key={`${tx.txid || 'tx'}-${idx}`}
                  style={{ background: '#0d1a0d', border: '1px solid #224022', borderRadius: 8, padding: '10px 12px' }}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}
                  >
                    <span style={{ fontSize: 12, color: outgoing ? '#fca5a5' : '#86efac', fontWeight: 700 }}>
                      {outgoing ? 'Sent' : 'Received'}
                    </span>
                    <span
                      style={{ fontSize: 12, color: '#d7ffd9', fontWeight: 700 }}
                    >{`${amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC`}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#9ac79f', marginBottom: 3 }}>Category: {tx.category || '-'}</div>
                  <div style={{ fontSize: 11, color: '#9ac79f', marginBottom: 3 }}>
                    Confirmations: {Math.max(0, Number(tx.confirmations) || 0)}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ac79f', marginBottom: 3 }}>Time: {formatTxTime(tx.time)}</div>
                  <div style={{ fontSize: 11, color: '#9ac79f', wordBreak: 'break-all' }}>TXID: {tx.txid || '-'}</div>
                  {!!(networkInfo.explorerBaseUrl && tx.txid) && (
                    <button
                      onClick={() => {
                        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
                          window.wattcoinHardware.invoke(
                            'wattcoin-open-external-url',
                            `${networkInfo.explorerBaseUrl}/tx/${tx.txid}`,
                          );
                        }
                      }}
                      style={{
                        display: 'inline-block',
                        marginTop: 6,
                        fontSize: 11,
                        color: '#60a5fa',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        textDecoration: 'underline',
                      }}
                    >
                      Open in explorer
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {walletView === 'nfts' && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>Wattcoin Vortex NFTs</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={loadNfts}
                disabled={nftsBusy}
                style={{
                  background: nftsBusy ? '#275a2f' : '#4ade80',
                  color: nftsBusy ? '#9fd4a8' : '#001008',
                  border: 'none',
                  borderRadius: 8,
                  padding: '7px 12px',
                  fontWeight: 700,
                  cursor: nftsBusy ? 'default' : 'pointer',
                  fontSize: 12,
                }}
              >
                {nftsBusy ? 'Loading...' : 'Refresh'}
              </button>
            </div>
          </div>

          {nftTransferMsg && (
            <div
              style={{
                marginBottom: 10,
                fontSize: 13,
                color: /^(Failed|Error|Init failed|Init error|Transfer failed|Transfer error)/.test(nftTransferMsg)
                  ? '#fca5a5'
                  : '#86efac',
              }}
            >
              {nftTransferMsg}
            </div>
          )}

          {nfts.length === 0 && !nftsBusy && (
            <div style={{ fontSize: 14, color: '#9ac79f', textAlign: 'center', marginTop: 32 }}>
              No Wattcoin Vortex NFTs found for this address.
            </div>
          )}

          {(() => {
            const TIER_COLORS = { gold: '#fbbf24', silver: '#9ca3af', bronze: '#d97706' };
            const TIER_BG = { gold: '#2d2200', silver: '#1a1a1e', bronze: '#1e0e00' };
            const TIER_LABELS = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
            const NFT_IMGS = {
              gold: nftImgGold,
              silver: nftImgSilver,
              bronze: nftImgBronze,
            };
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                {nfts.map((nft) => {
                  const tier = (nft.metadata && nft.metadata.tier) || 'bronze';
                  const name = (nft.metadata && nft.metadata.name) || nft.nftId;
                  const shares = (nft.metadata && nft.metadata.shares) || 0;
                  const isTransferring = nftTransferTarget === nft.nftId;
                  return (
                    <div
                      key={nft.nftId}
                      style={{
                        background: TIER_BG[tier] || '#0d1a0d',
                        border: `1px solid ${TIER_COLORS[tier] || '#224022'}`,
                        borderRadius: 12,
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <img
                        src={NFT_IMGS[tier] || NFT_IMGS.bronze}
                        alt={name}
                        style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                      <div style={{ padding: '10px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#d7ffd9' }}>{name}</span>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: TIER_COLORS[tier],
                              background: `${TIER_COLORS[tier]}22`,
                              borderRadius: 6,
                              padding: '2px 7px',
                            }}
                          >
                            {TIER_LABELS[tier] || tier}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: '#9ac79f' }}>
                          {shares} profit {shares === 1 ? 'share' : 'shares'}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b8f6b', wordBreak: 'break-all' }}>ID: {nft.nftId}</div>
                        {!isTransferring ? (
                          <button
                            onClick={() => {
                              setNftTransferTarget(nft.nftId);
                              setNftTransferAddress('');
                              setNftTransferMsg('');
                            }}
                            style={{
                              marginTop: 6,
                              background: '#1e3a1e',
                              color: '#4ade80',
                              border: '1px solid #4ade80',
                              borderRadius: 8,
                              padding: '6px 10px',
                              fontWeight: 700,
                              cursor: 'pointer',
                              fontSize: 12,
                            }}
                          >
                            Transfer
                          </button>
                        ) : (
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <input
                              value={nftTransferAddress}
                              onChange={(e) => setNftTransferAddress(e.target.value)}
                              placeholder="Recipient wtc1q..."
                              style={{
                                fontSize: 11,
                                padding: '5px 8px',
                                borderRadius: 6,
                                border: '1px solid #224022',
                                background: '#0d1a0d',
                                color: '#d7ffd9',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            />
                            <div style={{ display: 'flex', gap: 5 }}>
                              <button
                                onClick={() => {
                                  if (!nftTransferAddress.trim()) {
                                    setNftTransferMsg('Please enter a recipient address.');
                                    return;
                                  }
                                  setNftTransferMsg('');
                                  setNftsBusy(true);
                                  window.wattcoinHardware
                                    .invoke('wattcoin-nft-transfer', {
                                      nftId: nft.nftId,
                                      fromAddress: selectedWalletAddress,
                                      toAddress: nftTransferAddress.trim(),
                                    })
                                    .then((res) => {
                                      if (res && res.ok) {
                                        setNftTransferMsg(`Submitted. TXID: ${res.txid || ''}`);
                                        setNftTransferTarget(null);
                                        setNftTransferAddress('');
                                        loadNfts();
                                      } else {
                                        setNftTransferMsg(`Failed: ${(res && res.error) || 'unknown error'}`);
                                      }
                                    })
                                    .catch((e) => {
                                      setNftTransferMsg(`Error: ${e && e.message}`);
                                    })
                                    .finally(() => setNftsBusy(false));
                                }}
                                disabled={nftsBusy}
                                style={{
                                  flex: 1,
                                  background: '#4ade80',
                                  color: '#001008',
                                  border: 'none',
                                  borderRadius: 6,
                                  padding: '6px 0',
                                  fontWeight: 700,
                                  cursor: nftsBusy ? 'default' : 'pointer',
                                  fontSize: 11,
                                }}
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => {
                                  setNftTransferTarget(null);
                                  setNftTransferAddress('');
                                }}
                                style={{
                                  flex: 1,
                                  background: '#1e3a1e',
                                  color: '#b7f5bc',
                                  border: 'none',
                                  borderRadius: 6,
                                  padding: '6px 0',
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  fontSize: 11,
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
