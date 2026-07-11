export const LOG_STORAGE_KEY = 'wattcoin-mining-log-v3';
export const MAX_PERSISTED_LOG_ENTRIES = 2000;
export const BALANCE_STORAGE_KEY = 'wattcoin-wallet-balances';
export const ENERGY_STORAGE_KEY = 'wattcoin-mining-energy-wh';
export const ENERGY_BY_ADDRESS_STORAGE_KEY = 'wattcoin-mining-energy-by-address-v1';
export const SENT_TX_HISTORY_STORAGE_KEY = 'wattcoin-sent-transaction-history-v1';
export const MAX_PERSISTED_SENT_TXS = 200;
export const MINER_UNLOCK_STORAGE_KEY = 'wattcoin-miner-unlocked-v1';

export function loadPersistedLog() {
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

export function loadPersistedBalances() {
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

export function loadPersistedEnergy() {
  try {
    const raw = localStorage.getItem(ENERGY_STORAGE_KEY);
    const parsed = Number(raw);
    return Math.max(0, Number.isFinite(parsed) ? parsed : 0);
  } catch (_) {
    return 0;
  }
}

export function loadPersistedEnergyByAddress() {
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

export function loadPersistedSentTransactions() {
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

export function loadPersistedMinerUnlock() {
  try {
    return localStorage.getItem(MINER_UNLOCK_STORAGE_KEY) === '1';
  } catch (_) {
    return false;
  }
}

export function createDefaultWalletReadiness() {
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

export function createDefaultWalletSyncState() {
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
