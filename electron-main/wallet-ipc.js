'use strict';

const { ALLOWED_SENDER_ADDRESSES } = require('./protocol-constants');
const saleQueue = require('./wtc-sale-queue');

const ELECTRICITY_PRICE_FALLBACK = 0.174;
const ELECTRICITY_PRICE_CACHE_MS = 24 * 60 * 60 * 1000;
let _electricityCache = { price: null, fetchedAt: 0 };

function registerWalletIpcHandlers(deps) {
  const {
    ipcMain,
    getWtcNode,
    walletAddressCache,
    enforceEndpointRateLimit,
    https,
    getBetaPolicy,
    logAbuseEvent,
    refreshWalletSyncState,
  } = deps;

  // Get WTC balances reconstructed from mined block history for a specific mining address.
  ipcMain.handle('wattcoin-get-node-mined-coins', (_, selectedAddress) => {
    // -- WTC native chain fast-path ---------------------------------------
    if (getWtcNode()) {
      try {
        const addr =
          typeof selectedAddress === 'string' && selectedAddress.trim()
            ? selectedAddress.trim()
            : getWtcNode().getPrimaryAddress();
        const bal = getWtcNode().getBalance(addr);
        const stats = getWtcNode().getMinedStats(addr);
        return {
          ok: true,
          address: addr,
          blocks: getWtcNode().getHeight(),
          minedCoins: stats.totalWTC,
          maturedMinedCoins: bal.confirmed,
          unmaturedMinedCoins: bal.unmatured,
          totalMinedCoins: stats.totalWTC,
          totalMinedBlocks: stats.totalBlocks,
          maturedMinedBlocks: stats.maturedBlocks,
          unmaturedMinedBlocks: Math.max(0, stats.totalBlocks - stats.maturedBlocks),
          maturityDepth: 100,
        };
      } catch (e) {
        return { ok: false, code: 'BALANCE_READ_FAILED', message: e && e.message ? e.message : 'Failed' };
      }
    }
  });

  ipcMain.handle('wattcoin-send', async (_, payload = {}) => {
    const _walletName = 'wattminer';
    const betaPolicy = getBetaPolicy();
    if (!betaPolicy.withdrawalsEnabled) {
      await logAbuseEvent({
        type: 'withdrawal-blocked-beta',
        endpoint: 'wattcoin-send',
        actorId: 'local-client',
        metadata: {
          selectedAddress: payload && payload.selectedAddress ? String(payload.selectedAddress) : '',
        },
      });
      return { ok: false, code: 'BETA_WITHDRAWALS_DISABLED', message: betaPolicy.policyMessage };
    }

    // -- Sender whitelist (hardcoded - cannot be overridden by config) ---------
    const fromAddr = payload && typeof payload.selectedAddress === 'string' ? payload.selectedAddress.trim() : '';
    if (!fromAddr || !ALLOWED_SENDER_ADDRESSES.has(fromAddr)) {
      return { ok: false, code: 'SENDER_NOT_ALLOWED', message: 'Withdrawals are not available for this address.' };
    }
    const actorId =
      payload && typeof payload.selectedAddress === 'string' && payload.selectedAddress.trim()
        ? payload.selectedAddress.trim()
        : 'local-client';
    const rateLimit = await enforceEndpointRateLimit('wattcoin-send', actorId, {
      toAddress: payload && payload.toAddress ? String(payload.toAddress) : '',
      amount: Number(payload && payload.amount) || 0,
    });
    if (!rateLimit.ok) {
      return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
    }
    const toAddress = typeof payload.toAddress === 'string' ? payload.toAddress.trim() : '';
    const amount = Number(payload.amount);
    const subtractFeeFromAmount = !!(payload && payload.subtractFeeFromAmount);

    if (!toAddress) {
      return { ok: false, code: 'INVALID_ADDRESS', message: 'Recipient address is required.' };
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, code: 'INVALID_AMOUNT', message: 'Amount must be greater than 0.' };
    }

    // -- WTC native chain path -------------------------------------------------
    if (getWtcNode()) {
      try {
        const fromAddress =
          payload && typeof payload.selectedAddress === 'string'
            ? payload.selectedAddress.trim()
            : getWtcNode().getPrimaryAddress();
        const result = getWtcNode().send({ fromAddress, toAddress, amount, subtractFeeFromAmount });
        // Transaction is now in the mempool - it will be included in the next
        // naturally mined block. No flush block is triggered here.
        return { ok: true, txid: result.txid, toAddress, amount: result.amount, subtractFeeFromAmount };
      } catch (e) {
        return { ok: false, code: 'SEND_FAILED', message: e && e.message ? e.message : 'Send failed' };
      }
    }
  });

  ipcMain.handle('wattcoin-get-tx-status', (_, payload = {}) => {
    const txid = typeof payload.txid === 'string' ? payload.txid.trim() : '';
    if (!txid) return { ok: false, code: 'MISSING_TXID', message: 'txid required' };
    if (getWtcNode()) {
      const { status } = getWtcNode().getTxStatus(txid);
      return { ok: true, txid, status };
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
  });

  ipcMain.handle('wattcoin-list-transactions', async (_, payload = {}) => {
    const _walletName = 'wattminer';
    const actorId =
      payload && typeof payload.selectedAddress === 'string' && payload.selectedAddress.trim()
        ? payload.selectedAddress.trim()
        : 'local-client';
    const rateLimit = await enforceEndpointRateLimit('wattcoin-list-transactions', actorId, {
      selectedAddress: actorId,
    });
    if (!rateLimit.ok) {
      return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
    }
    const countRaw = Number(payload && payload.count);
    const count = Math.min(200, Math.max(1, Number.isFinite(countRaw) ? Math.floor(countRaw) : 50));
    const selectedAddress = typeof payload.selectedAddress === 'string' ? payload.selectedAddress.trim() : '';

    // -- WTC native chain path -------------------------------------------------
    if (getWtcNode()) {
      const txs = getWtcNode().listTransactions(selectedAddress || getWtcNode().getPrimaryAddress(), count);
      return { ok: true, selectedAddress, count: txs.length, transactions: txs };
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
  });

  // Get all addresses with their labels
  ipcMain.handle('wattcoin-get-addresses', () => {
    if (getWtcNode()) {
      const addresses = getWtcNode().getAddresses();
      return { ok: true, addresses };
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
  });

  // Create a new mining address
  ipcMain.handle('wattcoin-create-address', () => {
    if (getWtcNode()) {
      try {
        const { address } = getWtcNode().createAddress();
        getWtcNode().setPrimaryAddress(address);
        walletAddressCache.address = address;
        walletAddressCache.at = Date.now();
        const allAddresses = getWtcNode().getAddresses();
        refreshWalletSyncState('create-address', { force: true }).catch(() => {});
        return { ok: true, address, allAddresses };
      } catch (e) {
        return { ok: false, code: 'CREATE_FAILED', message: e && e.message ? e.message : 'Failed to create address' };
      }
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node not initialised yet.' };
  });

  ipcMain.handle('wattcoin-delete-address', (_, targetAddress) => {
    const address = typeof targetAddress === 'string' ? targetAddress.trim() : '';
    if (!address) {
      return { ok: false, code: 'INVALID_ADDRESS', message: 'No address selected for deletion.' };
    }
    if (getWtcNode()) {
      try {
        if (getWtcNode().getPrimaryAddress() === address) {
          const remaining = getWtcNode()
            .getAddresses()
            .filter((entry) => entry !== address);
          if (remaining.length === 0) {
            return { ok: false, code: 'DELETE_FAILED', message: 'Cannot delete the only wallet address.' };
          }
          getWtcNode().setPrimaryAddress(remaining[0]);
        }
        getWtcNode().deleteAddress(address);
        const nextPrimary = getWtcNode().getPrimaryAddress();
        walletAddressCache.address = nextPrimary || '';
        walletAddressCache.at = nextPrimary ? Date.now() : 0;
        refreshWalletSyncState('delete-address', { force: true }).catch(() => {});
        return { ok: true, deletedAddress: address, allAddresses: getWtcNode().getAddresses() };
      } catch (e) {
        return { ok: false, code: 'DELETE_FAILED', message: e && e.message ? e.message : 'Delete failed' };
      }
    }
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
  });

  // Get wallet seed phrase or backup guidance.
  ipcMain.handle('wattcoin-get-seed', () => {
    return { ok: false, code: 'NOT_SUPPORTED', message: 'Seed phrases are not available for WTC native wallets.' };
  });

  // --- Global average electricity price (USD/kWh) ------------------------------
  // Fetches from GlobalPetrolPrices.com. Cached for 24 h. Falls back to the
  // widely-cited 2024 global average of $0.165/kWh if the fetch or parse fails.
  ipcMain.handle('wattcoin-get-electricity-price', () => {
    if (_electricityCache.price !== null && Date.now() - _electricityCache.fetchedAt < ELECTRICITY_PRICE_CACHE_MS) {
      saleQueue.setElectricityPrice(_electricityCache.price);
      return Promise.resolve({ ok: true, price: _electricityCache.price, source: 'cache' });
    }

    return new Promise((resolve) => {
      const fallback = (source) => {
        const price = _electricityCache.price || ELECTRICITY_PRICE_FALLBACK;
        saleQueue.setElectricityPrice(price);
        resolve({ ok: true, price, source });
      };

      try {
        const req = https.get(
          'https://www.globalpetrolprices.com/electricity_prices/',
          {
            timeout: 12_000,
            headers: {
              Accept: 'text/html,application/xhtml+xml,*/*',
              'Accept-Language': 'en-US,en;q=0.9',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
          },
          (res) => {
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
              total += chunk.length;
              if (total > 3 * 1024 * 1024) {
                req.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => {
              try {
                const html = Buffer.concat(chunks).toString('utf8');
                // GlobalPetrolPrices embeds a JS data array.  The world-average row
                // typically looks like: ["World","-","0.165",-]
                // Try several patterns in order of reliability.
                const patterns = [
                  // prose text in article body
                  /electricity price in the world is USD ([0-9]+\.[0-9]+)/i,
                  // JS data array formats
                  /"World"\s*,\s*"[^"]*"\s*,\s*"([0-9]+\.[0-9]+)"/i,
                  /'World'\s*,\s*([0-9]+\.[0-9]+)/i,
                  /"World"\s*,\s*([0-9]+\.[0-9]+)/i,
                  /arrData\.push\(\["World"[^\]]*?,(\d+\.\d+)/,
                  // HTML table cell
                  /World[^<]{0,120}<\/td>\s*<td[^>]*>\s*([0-9]+\.[0-9]+)/i,
                ];
                for (const re of patterns) {
                  const m = html.match(re);
                  if (m) {
                    const p = parseFloat(m[1]);
                    if (p > 0.01 && p < 5) {
                      _electricityCache = { price: p, fetchedAt: Date.now() };
                      saleQueue.setElectricityPrice(p);
                      return resolve({ ok: true, price: p, source: 'live' });
                    }
                  }
                }
                fallback('fallback-parse');
              } catch (_) {
                fallback('fallback-error');
              }
            });
          },
        );
        req.on('error', () => fallback('fallback-network'));
        req.on('timeout', () => {
          req.destroy();
          fallback('fallback-timeout');
        });
      } catch (_) {
        fallback('fallback-exception');
      }
    });
  });
}

module.exports = { registerWalletIpcHandlers };
