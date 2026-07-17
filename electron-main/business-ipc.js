'use strict';

const crypto = require('crypto');
const { dialog, ipcMain } = require('electron');
const { getFocusedWindow } = require('./electron-utils');
const saleQueue = require('./wtc-sale-queue');
const stakingQueue = require('./wtc-staking-queue');
const { isValidAddress: isValidWtcAddress } = require('./wtc-address');

function userHasVhpn1(wtcNode, address) {
  if (!wtcNode || !address) return false;
  const nft = wtcNode.getNft('vhpn-1');
  return nft && nft.owner === address;
}

function userHasAnyNft(wtcNode, address) {
  if (!wtcNode || !address) return false;
  const nfts = wtcNode.getNftsForAddress(address);
  return nfts.length > 0;
}

function userOwnsNft(wtcNode, address, nftId) {
  if (!wtcNode || !address || !nftId) return false;
  const nft = wtcNode.getNft(nftId);
  return nft && nft.owner === address;
}

function userOwnedNftIds(wtcNode, address) {
  if (!wtcNode || !address) return new Set();
  const nfts = wtcNode.getNftsForAddress(address);
  return new Set(nfts.map((n) => n.nftId));
}

function registerBusinessIpcHandlers(deps) {
  const { wtcNode, persistence, getActivePeers, getLedgerNetworkSettings, broadcastTeamDocsToPeers } = deps;

  const _wtcNode = () => (typeof wtcNode === 'function' ? wtcNode() : wtcNode);
  const _persistence = persistence;

  function readTeamData() {
    return _persistence.readTeamData();
  }

  function writeTeamData(members) {
    _persistence.writeTeamData(members);
  }

  function readDocsData() {
    return _persistence.readDocsData();
  }

  function writeDocsData(docs) {
    _persistence.writeDocsData(docs);
  }

  ipcMain.handle('wattcoin-validate-address', (_event, addr) => {
    if (typeof addr !== 'string') return { ok: false, valid: false, reason: 'not a string' };
    const trimmed = addr.trim();
    if (!trimmed) return { ok: true, valid: false, reason: 'empty' };
    if (!trimmed.startsWith('wtc1q')) return { ok: true, valid: false, reason: 'must start with wtc1q' };
    if (trimmed.length !== 43) return { ok: true, valid: false, reason: `expected 43 chars, got ${trimmed.length}` };
    try {
      const valid = isValidWtcAddress(trimmed);
      return { ok: true, valid, reason: valid ? null : 'invalid checksum' };
    } catch (e) {
      return { ok: true, valid: false, reason: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-sale-status', async (_event) => {
    const soldRaw = await saleQueue.refreshSoldWTC();
    const sold = Math.max(0, Math.min(saleQueue.SALE_TOTAL, Number(soldRaw) || 0));
    const poll = saleQueue.getLastPollStatus();
    return {
      ok: true,
      sellerUsdcAddress: saleQueue.SELLER_USDC_ADDRESS,
      saleWtcAddress: saleQueue.SALE_WTC_ADDRESS,
      sold: sold,
      remaining: Math.max(0, saleQueue.SALE_TOTAL - sold),
      total: saleQueue.SALE_TOTAL,
      tierSize: saleQueue.SALE_TIER_SIZE,
      tiers: saleQueue.SALE_TIERS,
      minBuy: saleQueue.MIN_BUY_WTC,
      lastEtherscanPoll: poll,
    };
  });

  ipcMain.handle('wattcoin-sale-compute-price', async (_event, { wtcAmount, electricityPricePerKwh }) => {
    const amount = Number(wtcAmount);
    const elPrice = Number(electricityPricePerKwh);
    if (!Number.isFinite(amount) || amount < saleQueue.MIN_BUY_WTC) {
      return { ok: false, error: `Minimum ${saleQueue.MIN_BUY_WTC} WTC` };
    }
    if (!Number.isFinite(elPrice) || elPrice <= 0) {
      return { ok: false, error: 'Invalid electricity price' };
    }
    await saleQueue.refreshSoldWTC();
    const usdcRequired = saleQueue.computeUsdcRequired(amount, elPrice);
    return { ok: true, usdcRequired: Math.round(usdcRequired * 1e6) / 1e6 };
  });

  ipcMain.handle(
    'wattcoin-sale-place-order',
    async (_event, { wtcAddress, wtcAmount, usdcRequired, buyerEthAddress }) => {
      const addr = typeof wtcAddress === 'string' ? wtcAddress.trim() : '';
      const amount = Number(wtcAmount);
      const usdc = Number(usdcRequired);

      if (!addr || !addr.startsWith('wtc1q') || addr.length !== 43) {
        return { ok: false, error: 'Invalid WTC address' };
      }
      const confirmResult = await dialog.showMessageBox(getFocusedWindow(), {
        type: 'warning',
        buttons: ['Cancel', 'Confirm Purchase'],
        defaultId: 0,
        cancelId: 0,
        title: 'Confirm Sale Order',
        message: `Place sale order for ${amount.toLocaleString()} WTC at ${usdc.toLocaleString()} USDC?`,
        detail: `Buyer address: ${addr}`,
      });
      if (confirmResult.response !== 1) return { ok: false, code: 'CANCELED', message: 'Purchase order canceled.' };
      return saleQueue.placeSaleOrder({
        wtcAddress: addr,
        wtcAmount: amount,
        usdcRequired: usdc,
        buyerEthAddress: typeof buyerEthAddress === 'string' ? buyerEthAddress.trim() : null,
      });
    },
  );

  ipcMain.handle('wattcoin-sale-get-order', (_event, orderId) => {
    const order = saleQueue.getOrder(String(orderId || ''));
    if (!order) return { ok: false, error: 'Order not found' };
    return { ok: true, order };
  });

  ipcMain.handle('wattcoin-sale-cancel-order', (_event, orderId) => {
    return saleQueue.cancelOrder(String(orderId || ''));
  });

  ipcMain.handle('wattcoin-sale-get-my-orders', (_event, wtcAddress) => {
    const addr = typeof wtcAddress === 'string' ? wtcAddress.trim() : '';
    return { ok: true, orders: saleQueue.getOrdersForAddress(addr) };
  });

  ipcMain.handle('wattcoin-sale-get-purchase-total', (_event, wtcAddress) => {
    const addr = typeof wtcAddress === 'string' ? wtcAddress.trim() : '';
    return { ok: true, total: saleQueue.getPurchaseTotalForAddress(addr) };
  });

  ipcMain.handle('wattcoin-sale-confirm-payment', (_event, payload) => {
    const orderId = typeof (payload && payload.orderId) === 'string' ? payload.orderId.trim() : '';
    const txHash = typeof (payload && payload.txHash) === 'string' ? payload.txHash.trim() : '';
    if (!orderId || !txHash) return { ok: false, error: 'orderId and txHash required' };
    return saleQueue.setOrderTxHash(orderId, txHash);
  });

  ipcMain.handle('wattcoin-staking-status', (_event) => {
    return {
      ok: true,
      poolAddress: stakingQueue.STAKING_POOL_ADDRESS,
      poolBalance: stakingQueue.poolBalance(),
      totalStaked: stakingQueue.totalPendingWtc(),
      currentApy: stakingQueue.currentApy(),
      flushThreshold: stakingQueue.FLUSH_THRESHOLD_WTC,
      minStake: stakingQueue.MIN_STAKE_WTC,
    };
  });

  ipcMain.handle('wattcoin-staking-stake', async (_event, { fromAddress, wtcAmount }) => {
    const addr = typeof fromAddress === 'string' ? fromAddress.trim() : '';
    const amount = Number(wtcAmount);
    if (!addr || !addr.startsWith('wtc1q') || addr.length !== 43) {
      return { ok: false, error: 'Invalid WTC address' };
    }
    if (!Number.isFinite(amount)) {
      return { ok: false, error: 'Invalid WTC amount' };
    }
    const node = _wtcNode();
    if (node) {
      try {
        const bal = node.getBalance(addr);
        const available = (bal.confirmed || 0) + (bal.unmatured || 0);
        if (Math.floor(amount) > available) {
          return {
            ok: false,
            error: `Insufficient balance. You have ${available.toLocaleString()} WTC in your wallet.`,
          };
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[BusinessIpc] Caught:', String(_.message || _).slice(0, 80));
      }
    }
    const confirmResult = await dialog.showMessageBox(getFocusedWindow(), {
      type: 'warning',
      buttons: ['Cancel', 'Confirm Stake'],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm Stake',
      message: `Stake ${amount.toLocaleString()} WTC from address ${addr.slice(0, 12)}...?`,
      detail: `These tokens will be locked for the staking period. Staking rewards are paid in WTC.`,
    });
    if (confirmResult.response !== 1) return { ok: false, code: 'CANCELED', message: 'Staking canceled.' };
    return stakingQueue.stakeWtc({ fromAddress: addr, wtcAmount: amount });
  });

  ipcMain.handle('wattcoin-staking-get-entry', (_event, entryId) => {
    const entry = stakingQueue.getEntry(String(entryId || ''));
    if (!entry) return { ok: false, error: 'Entry not found' };
    return { ok: true, entry };
  });

  ipcMain.handle('wattcoin-staking-get-my-entries', (_event, address) => {
    const addr = typeof address === 'string' ? address.trim() : '';
    return { ok: true, entries: stakingQueue.getEntryForAddress(addr) };
  });

  ipcMain.handle('wattcoin-staking-cancel', (_event, entryId) => {
    return stakingQueue.cancelEntry(String(entryId || ''));
  });

  ipcMain.handle('wattcoin-nft-list', (_event, address) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, nfts: [] };
      const addr = typeof address === 'string' ? address.trim() : '';
      return { ok: true, nfts: node.getNftsForAddress(addr) };
    } catch (e) {
      return { ok: false, nfts: [], error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-nft-get', (_event, nftId) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, nft: null };
      const nft = node.getNft(String(nftId || ''));
      if (!nft) return { ok: false, error: 'NFT not found' };
      return { ok: true, nft };
    } catch (e) {
      return { ok: false, nft: null, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-nft-collection', (_event) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, nfts: [] };
      return { ok: true, nfts: node.getAllNfts() };
    } catch (e) {
      return { ok: false, nfts: [], error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-nft-transfer', async (_event, { nftId, fromAddress, toAddress }) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };
      const id = typeof nftId === 'string' ? nftId.trim() : '';
      const from = typeof fromAddress === 'string' ? fromAddress.trim() : '';
      const to = typeof toAddress === 'string' ? toAddress.trim() : '';
      if (!id || !from || !to) return { ok: false, error: 'nftId, fromAddress, toAddress required' };
      const confirmResult = await dialog.showMessageBox(getFocusedWindow(), {
        type: 'warning',
        buttons: ['Cancel', 'Confirm Transfer'],
        defaultId: 0,
        cancelId: 0,
        title: 'Confirm NFT Transfer',
        message: `Transfer NFT #${id} from ${from.slice(0, 12)}... to ${to.slice(0, 12)}...?`,
        detail: `This action cannot be undone. The NFT will be permanently moved to the recipient address.`,
      });
      if (confirmResult.response !== 1) return { ok: false, code: 'CANCELED', message: 'NFT transfer canceled.' };
      return node.transferNft({ nftId: id, fromAddress: from, toAddress: to });
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-governance-status', (_event) => {
    try {
      const node = _wtcNode();
      if (!node) {
        return {
          ok: false,
          distributedPower: 0,
          passThreshold: 0,
          totalPossible: 140,
          governanceWallet: { confirmed: 0, pending: 0, address: 'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw' },
        };
      }
      const status = node.getGovernanceStatus();
      const walletBal = node.getGovernanceWalletBalance();
      return {
        ok: true,
        ...status,
        governanceWallet: walletBal,
        governanceWalletAddress: 'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw',
      };
    } catch (e) {
      return { ok: false, distributedPower: 0, passThreshold: 0, totalPossible: 140, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-governance-list', (_event) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, proposals: [] };
      return { ok: true, proposals: node.getGovernanceProposals() };
    } catch (e) {
      return { ok: false, proposals: [], error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-governance-get-vote', (_event, pipId, address) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, vote: null };
      return { ok: true, vote: node.getGovernanceVote(pipId, address) };
    } catch (e) {
      return { ok: false, vote: null, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-governance-get-tallies', (_event, pipId) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, tallies: { for: 0, against: 0, totalPower: 0 } };
      return { ok: true, tallies: node.getGovernanceTallies(pipId) };
    } catch (e) {
      return { ok: false, tallies: { for: 0, against: 0, totalPower: 0 }, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-governance-propose', (_event, proposal) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };

      const addrs = node.getAddresses();
      let creator = addrs[0] || '';
      let creatorNftId = '';
      let creatorTier = 'bronze';
      for (const addr of addrs) {
        const nfts = node.getNftsForAddress(addr);
        if (nfts && nfts.length > 0) {
          creator = addr;
          const best = node.getGovernanceVotingPower(addr);
          for (const nft of nfts) {
            const t = (nft.metadata && nft.metadata.tier) || 'bronze';
            if (t === best.bestTier) {
              creatorNftId = nft.nftId;
              creatorTier = best.bestTier;
              break;
            }
          }
          break;
        }
      }

      const votingDurationWeeks = Math.max(2, Math.min(10, Math.floor(Number(proposal.votingDurationWeeks) || 2)));
      const commentPeriodWeeks = Math.max(1, Math.min(4, Math.floor(Number(proposal.commentPeriodWeeks) || 2)));
      const pipId = node.generateGovernancePipId();
      const enriched = {
        title: proposal.title,
        description: proposal.description || '',
        creator,
        creatorNftId,
        creatorTier,
        pipId,
        createdAt: Date.now(),
        votingDurationWeeks,
        commentPeriodWeeks,
      };

      if (proposal.transferTo && proposal.transferAmount) {
        const govKey = node.hasAddress('wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw');
        if (!govKey) {
          return {
            ok: false,
            error: 'Governance wallet key not available on this node - cannot submit treasury transfer proposals.',
          };
        }
        const bal = node.getGovernanceWalletBalance();
        const minReserve = 10000;
        if (bal.confirmed - Number(proposal.transferAmount) < minReserve) {
          return {
            ok: false,
            error: `Governance treasury must retain at least ${minReserve.toLocaleString()} WTC. Current balance: ${bal.confirmed.toLocaleString()} WTC.`,
          };
        }
        enriched.transferTo = String(proposal.transferTo).trim();
        enriched.transferAmount = Number(proposal.transferAmount);
        enriched.transferPurpose = String(proposal.transferPurpose || '').trim();
      }

      const result = node.addGovernanceProposal(enriched);
      if (!result.ok) return result;
      return { ok: true, pipId };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-governance-vote', async (_event, pipId, voteData) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };

      const vp = node.getGovernanceVotingPower(voteData.voter);
      if (!vp.hasNft) return { ok: false, error: `${voteData.voter.slice(0, 12)}... does not own any Vortex NFTs` };

      const confirmResult = await dialog.showMessageBox(getFocusedWindow(), {
        type: 'warning',
        buttons: ['Cancel', 'Confirm Vote'],
        defaultId: 0,
        cancelId: 0,
        title: 'Confirm Governance Vote',
        message: `Vote "${String(voteData.vote || '').toUpperCase()}" on PIP-${pipId}?`,
        detail: `Voter: ${voteData.voter.slice(0, 12)}... | Voting power: ${vp.bestPower} (${vp.bestTier} tier)`,
      });
      if (confirmResult.response !== 1) return { ok: false, code: 'CANCELED', message: 'Vote canceled.' };

      const timestamp = Date.now();
      const message = `${pipId}|${voteData.voter}|${voteData.vote}|${vp.bestPower}|${vp.bestTier}|${timestamp}`;
      const signed = node.signMessage(voteData.voter, message);

      const result = node.addGovernanceVote(pipId, {
        voter: voteData.voter,
        vote: voteData.vote,
        power: vp.bestPower,
        nftTier: vp.bestTier,
        timestamp,
        signature: signed.signature,
      });
      return result;
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-team-list', (_event, address) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, members: [], error: 'Node not ready' };
      if (!userHasAnyNft(node, address)) return { ok: false, members: [], error: 'Not authorized' };
      return { ok: true, members: readTeamData() };
    } catch (e) {
      return { ok: false, members: [], error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-team-add', (_event, address, member) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, error: 'Node not ready' };
      if (!userHasAnyNft(node, address)) return { ok: false, error: 'Not authorized' };
      if (!member || !member.name || !member.name.trim()) return { ok: false, error: 'Name is required' };
      const nftId = member.nftId;
      if (!nftId) return { ok: false, error: 'NFT ID is required' };
      if (!userOwnsNft(node, address, nftId)) return { ok: false, error: 'You do not own this NFT' };
      const members = readTeamData();
      const isVhpn1 = nftId === 'vhpn-1';
      const existingForNft = members.find((m) => m.nftId === nftId);
      if (existingForNft) return { ok: false, error: 'This NFT already has a team member entry' };
      if (!isVhpn1 && nftId !== 'vhpn-1') {
        const existingAny = members.find((m) => {
          const owned = userOwnedNftIds(node, address);
          return owned.has(m.nftId);
        });
        if (existingAny) return { ok: false, error: 'You have already added a team member with one of your NFTs' };
      }
      const entry = {
        id: `tm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        nftId,
        name: member.name.trim(),
        role: (member.role || '').trim(),
        description: (member.description || '').trim(),
        picture: (member.picture || '').trim(),
        address,
        addedBy: address,
        addedAt: Date.now(),
      };
      members.push(entry);
      writeTeamData(members);
      if (typeof broadcastTeamDocsToPeers === 'function') broadcastTeamDocsToPeers();
      return { ok: true, member: entry };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-team-edit', (_event, address, memberId, updates) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, error: 'Node not ready' };
      const members = readTeamData();
      const idx = members.findIndex((m) => m.id === memberId);
      if (idx === -1) return { ok: false, error: 'Member not found' };
      const targetNftId = members[idx].nftId;
      const isVhpn1 = userHasVhpn1(node, address);
      const ownsNft = targetNftId && userOwnsNft(node, address, targetNftId);
      if (!isVhpn1 && !ownsNft) return { ok: false, error: 'Not authorized to edit this member' };
      members[idx] = {
        ...members[idx],
        ...updates,
        id: members[idx].id,
        nftId: members[idx].nftId,
        address: members[idx].address,
        addedBy: members[idx].addedBy,
        addedAt: members[idx].addedAt,
      };
      writeTeamData(members);
      if (typeof broadcastTeamDocsToPeers === 'function') broadcastTeamDocsToPeers();
      return { ok: true, member: members[idx] };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-team-delete', (_event, address, memberId) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, error: 'Node not ready' };
      const members = readTeamData();
      const idx = members.findIndex((m) => m.id === memberId);
      if (idx === -1) return { ok: false, error: 'Member not found' };
      const targetNftId = members[idx].nftId;
      const isVhpn1 = userHasVhpn1(node, address);
      const ownsNft = targetNftId && userOwnsNft(node, address, targetNftId);
      if (!isVhpn1 && !ownsNft) return { ok: false, error: 'Not authorized to delete this member' };
      members.splice(idx, 1);
      writeTeamData(members);
      if (typeof broadcastTeamDocsToPeers === 'function') broadcastTeamDocsToPeers();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-docs-list', (_event, address) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, docs: [], error: 'Node not ready' };
      if (!userHasAnyNft(node, address)) return { ok: false, docs: [], error: 'Not authorized' };
      return { ok: true, docs: readDocsData() };
    } catch (e) {
      return { ok: false, docs: [], error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-docs-upload', (_event, address, doc) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, error: 'Node not ready' };
      if (!userHasVhpn1(node, address)) return { ok: false, error: 'Only vhpn-1 holder can upload documentation' };
      if (!doc || !doc.title || !doc.title.trim()) return { ok: false, error: 'Title is required' };
      if (!doc || !doc.content || !doc.content.trim()) return { ok: false, error: 'Content is required' };
      const docs = readDocsData();
      const entry = {
        id: `doc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
        title: doc.title.trim(),
        content: doc.content.trim(),
        category: (doc.category || '').trim(),
        addedBy: address,
        addedAt: Date.now(),
        lastEdited: Date.now(),
      };
      docs.push(entry);
      writeDocsData(docs);
      if (typeof broadcastTeamDocsToPeers === 'function') broadcastTeamDocsToPeers();
      return { ok: true, doc: entry };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-docs-delete', (_event, address, docId) => {
    try {
      const node = _wtcNode();
      if (!node || !address) return { ok: false, error: 'Node not ready' };
      if (!userHasVhpn1(node, address)) return { ok: false, error: 'Only vhpn-1 holder can delete documentation' };
      let docs = readDocsData();
      docs = docs.filter((d) => d.id !== docId);
      writeDocsData(docs);
      if (typeof broadcastTeamDocsToPeers === 'function') broadcastTeamDocsToPeers();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-explorer-get-blocks', (_event, { offset = 0, limit = 20 } = {}) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, blocks: [], total: 0 };
      const height = node.getHeight();
      if (height < 0) return { ok: true, blocks: [], total: 0 };
      const total = height + 1;
      const start = Math.max(0, height - offset - limit + 1);
      const end = Math.max(-1, height - offset);
      const blocks = [];
      for (let h = end; h >= start; h--) {
        const b = node.getBlock(h);
        if (!b) continue;
        let proofType = 'cpu';
        if (b.gpuProof) proofType = 'gpu';
        blocks.push({
          height: b.height,
          hash: b.hash,
          prevHash: b.prevHash,
          timestamp: b.timestamp,
          proposer: b.proposer,
          energyWh: b.energyWh,
          proofCommitment: b.proofCommitment || '',
          rewardTotal: b.rewardTotal,
          txCount: (b.transactions || []).length,
          voterCount: b.votes ? Object.keys(b.votes).length : 0,
          proofType,
        });
      }
      return { ok: true, blocks, total };
    } catch (e) {
      return { ok: false, blocks: [], total: 0, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-explorer-get-block', (_event, { height } = {}) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, block: null };
      const b = node.getBlock(height);
      if (!b) return { ok: false, block: null };
      return { ok: true, block: b };
    } catch (e) {
      return { ok: false, block: null, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-explorer-get-stats', () => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };
      const height = node.getHeight();
      if (height < 0) return { ok: true, height: -1, totalSupply: 0, peerCount: 0, latestBlocks: [] };

      const peerCount = (typeof getActivePeers === 'function' ? getActivePeers(getLedgerNetworkSettings()) : []).length;

      const { cumulativeSupplyAtHeight } = require('./wtc-chain');
      const totalSupply = cumulativeSupplyAtHeight(height);

      const latestBlocks = [];
      const start = Math.max(0, height - 19);
      for (let h = height; h >= start; h--) {
        const b = node.getBlock(h);
        if (!b) continue;
        latestBlocks.push({
          height: b.height,
          timestamp: b.timestamp,
          proposer: b.proposer,
          rewardTotal: b.rewardTotal,
          txCount: (b.transactions || []).length,
          energyWh: b.energyWh,
          proofCommitment: b.proofCommitment || '',
          hasCpuProof: !!b.cpuSpeedProof,
          hasGpuProof: !!b.gpuProof,
        });
      }

      return { ok: true, height, totalSupply, peerCount, latestBlocks };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-explorer-get-address', (_event, { address } = {}) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };
      if (!address || typeof address !== 'string') return { ok: false, error: 'Invalid address' };

      const bal = node.getBalance(address);
      const stats = node.getMinedStats(address);
      const height = node.getHeight();
      const txs = node.listTransactions(address, 50);
      const minedBlocks = [];
      for (let h = 0; h <= height; h++) {
        const b = node.getBlock(h);
        if (b && b.proposer === address) {
          minedBlocks.push({
            height: b.height,
            hash: b.hash,
            timestamp: b.timestamp,
            rewardTotal: b.rewardTotal,
            txCount: (b.transactions || []).length,
          });
        }
      }

      return {
        ok: true,
        address,
        balance: bal ? { confirmed: bal.confirmed, unmatured: bal.unmatured } : { confirmed: 0, unmatured: 0 },
        minedStats: stats || { totalBlocks: 0, totalWTC: 0, maturedBlocks: 0 },
        totalTransactions: txs.length,
        transactions: txs.slice(0, 20),
        minedBlocks: minedBlocks.slice(-20).reverse(),
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-explorer-search', (_event, { query } = {}) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };
      if (!query || typeof query !== 'string') return { ok: false, error: 'Invalid query' };
      const trimmed = query.trim();

      const heightNum = Number(trimmed);
      if (Number.isInteger(heightNum) && heightNum >= 0) {
        const b = node.getBlock(heightNum);
        if (b) {
          return { ok: true, type: 'block', block: b };
        }
        return { ok: true, type: 'not_found', message: `Block at height ${heightNum} not found.` };
      }

      if (/^[0-9a-f]{64}$/i.test(trimmed)) {
        const b = node.getBlockByHash(trimmed.toLowerCase());
        if (b) return { ok: true, type: 'block', block: b };
        return { ok: true, type: 'not_found', message: 'Block with that hash not found.' };
      }

      if (/^wtc1q[a-z0-9]{38}$/i.test(trimmed)) {
        const addr = trimmed.toLowerCase();
        const bal = node.getBalance(addr);
        if (bal && (bal.confirmed > 0 || bal.unmatured > 0)) {
          return { ok: true, type: 'address', address: addr };
        }
        const s = node.getMinedStats(addr);
        if (s && s.totalBlocks > 0) {
          return { ok: true, type: 'address', address: addr };
        }
        return { ok: true, type: 'not_found', message: 'Address not found on chain.' };
      }

      return {
        ok: true,
        type: 'not_found',
        message: 'Unrecognised search format. Use block height, 64-char hex hash, or wtc1q address.',
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });

  ipcMain.handle('wattcoin-explorer-get-tx-detail', (_event, { txid } = {}) => {
    try {
      const node = _wtcNode();
      if (!node) return { ok: false, error: 'Node not ready' };
      if (!txid || typeof txid !== 'string') return { ok: false, error: 'Invalid txid' };
      const height = node.getHeight();
      for (let h = 0; h <= height; h++) {
        const b = node.getBlock(h);
        if (!b || !b.transactions) continue;
        const tx = b.transactions.find((t) => t.txid === txid || t.txid === txid.toLowerCase());
        if (tx) {
          return { ok: true, transaction: { ...tx, blockHeight: b.height, blockHash: b.hash, timestamp: b.timestamp } };
        }
      }
      return { ok: false, error: 'Transaction not found' };
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    }
  });
}

module.exports = { registerBusinessIpcHandlers };
