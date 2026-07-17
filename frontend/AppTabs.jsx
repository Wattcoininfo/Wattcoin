import { useState, useRef, useEffect, useCallback } from 'react';
import Wattcoin from './Wattcoin.jsx';
import Miner from './Miner.jsx';
import MiningLog from './MiningLog.jsx';
import Governance from './Governance.jsx';
import WalletTab from './wallet/WalletTab.jsx';
import { TOTAL_SUPPLY } from './wattcoin/wattcoinConstants.js';
import {
  LOG_STORAGE_KEY,
  MAX_PERSISTED_LOG_ENTRIES,
  BALANCE_STORAGE_KEY,
  ENERGY_STORAGE_KEY,
  ENERGY_BY_ADDRESS_STORAGE_KEY,
  MINER_UNLOCK_STORAGE_KEY,
  loadPersistedLog,
  loadPersistedBalances,
  loadPersistedEnergy,
  loadPersistedEnergyByAddress,
  loadPersistedMinerUnlock,
  createDefaultWalletReadiness,
  createDefaultWalletSyncState,
} from './storage.js';

const tabs = [
  { label: 'Dashboard', key: 'dashboard' },
  { label: 'Log', key: 'log' },
  { label: 'Wallet', key: 'wallet' },
  { label: 'Governance', key: 'governance' },
  { label: 'Whitepaper', key: 'whitepaper' },
];

const TAB_BAR_HEIGHT_PX = 74;
const MINER_PROTECTED_TABS = new Set([]);

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
    // Poll the actual ledger value every 500ms so the Energy Used card shows
    // the authoritative (clamped) contribution in real time, not an optimistic sum.
    const ledgerPollId = setInterval(() => {
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
    }, 500);
    return () => {
      clearInterval(miningRef.current);
      clearInterval(ledgerPollId);
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
        // Item 1: coordinator-side CPU proof re-verification fields.
        cpuSpeedInitialSeed: Number(minedInfo && minedInfo.cpuSpeedInitialSeed) || 0,
        cpuSpeedProof: String((minedInfo && minedInfo.cpuSpeedProof) || ''),
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
    if (coins >= TOTAL_SUPPLY && mining) setMining(false);
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
                  setHardwareLookupResetNonce((value) => value + 1);
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
                    if (previousFingerprint.memType || previousFingerprint.memSticks) {
                      parts.push(
                        `Memory ${previousFingerprint.memType || 'unknown'} x${previousFingerprint.memSticks || 0}`,
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
