'use strict';

const assert = require('assert');
const os     = require('os');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const sq = require('../wtc-staking-queue');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-staking-test-'));
}

function entriesPath(dir) {
  return path.join(dir, 'staking-entries.json');
}

function initQueue(dir, mockNode) {
  sq.init(dir, mockNode !== undefined ? mockNode : null);
}

function captureWarns(fn) {
  const msgs = [];
  const orig = console.warn;
  console.warn = (...args) => msgs.push(args.map(String).join(' '));
  try { fn(); } finally { console.warn = orig; }
  return msgs;
}

// Silence console.log and console.warn for the duration of fn().
function silenceLogs(fn) {
  const origLog  = console.log;
  const origWarn = console.warn;
  console.log  = () => {};
  console.warn = () => {};
  try { fn(); } finally { console.log = origLog; console.warn = origWarn; }
}

async function silenceLogsAsync(fn) {
  const origLog  = console.log;
  const origWarn = console.warn;
  console.log  = () => {};
  console.warn = () => {};
  try { await fn(); } finally { console.log = origLog; console.warn = origWarn; }
}

/**
 * Returns a mock wtcNode with configurable pool balance and send behaviour.
 * node._calls contains the arguments of every send() invocation.
 */
function makeMockNode({ poolWtc = 1_000_000, stakerWtc = null, sendTxid = 'mock-txid', sendThrows = null } = {}) {
  const calls = [];
  return {
    getBalance: (_addr) => {
      if (_addr === 'wtc1q-alice' && stakerWtc !== null) return { confirmed: stakerWtc, unmatured: 0 };
      return { confirmed: poolWtc, unmatured: 0 };
    },
    send: (opts) => {
      calls.push({ ...opts });
      if (sendThrows) throw new Error(sendThrows);
      return { txid: sendTxid };
    },
    _calls: calls,
  };
}

// ─── APY computation ─────────────────────────────────────────────────────────

function testApyZeroWithNoEntries() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.strictEqual(sq.currentApy(), 0, 'APY must be 0 when no WTC is staked');
}

function testApyFractionalBelowOldThreshold() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  // round(5 000 / 10 000 * 100) / 100 = round(50) / 100 = 0.50
  assert.strictEqual(sq.currentApy(), 0.5, '5 000 WTC should yield 0.5% APY');
}

function testApyOnePercentAt10k() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  assert.strictEqual(sq.currentApy(), 1, '10 000 WTC should yield 1% APY');
}

function testApyMinimumNonZeroAt100Wtc() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100 });
  });
  // round(100 / 10 000 * 100) / 100 = round(1) / 100 = 0.01
  assert.strictEqual(sq.currentApy(), 0.01, '100 WTC should yield 0.01% APY (minimum non-zero)');
}

function testApyFormula() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 110_000 });
  });
  // floor(110 000 / 10 000) = 11
  assert.strictEqual(sq.currentApy(), 11, '110 000 WTC should yield 11% APY');
}

function testApyCappedAt100Percent() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 1_200_000 });
  });
  assert.strictEqual(sq.currentApy(), 100, 'APY must be capped at 100%');
}

function testApyIgnoresCancelledEntries() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 100_000 });
    sq.cancelEntry(r.entryId);
  });
  // Only Bob's 100 000 is pending → APY = 10%
  assert.strictEqual(sq.currentApy(), 10, 'cancelled entries must not contribute to APY');
}

// ─── stakeWtc ─────────────────────────────────────────────────────────────────

function testStakeRejectsEmptyAddress() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  const r = sq.stakeWtc({ fromAddress: '', wtcAmount: 500 });
  assert.strictEqual(r.ok, false, 'empty fromAddress must be rejected');
  assert.ok(r.error, 'error message must be present');
}

function testStakeRejectsUndefinedAddress() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  const r = sq.stakeWtc({ fromAddress: undefined, wtcAmount: 500 });
  assert.strictEqual(r.ok, false, 'undefined fromAddress must be rejected');
}

function testStakeRejectsBelowMinimum() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  const r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 99 });
  assert.strictEqual(r.ok, false, 'stake below MIN_STAKE_WTC must be rejected');
  assert.ok(r.error.includes('100'), 'error must mention the minimum amount');
}

function testStakeRejectsNonFiniteAmount() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.strictEqual(sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: NaN }).ok,       false);
  assert.strictEqual(sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: Infinity }).ok,  false);
  assert.strictEqual(sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: -100 }).ok,      false);
}

function testStakeAtExactMinimum() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  const r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100 });
  assert.strictEqual(r.ok, true, 'stake at exact MIN_STAKE_WTC must succeed');
  assert.ok(r.entryId, 'entryId must be returned');
}

function testStakeCreatesEntryWithCorrectFields() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  let result;
  silenceLogs(() => { result = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 }); });
  assert.strictEqual(result.ok, true);
  const entry = sq.getEntry(result.entryId);
  assert.ok(entry,                                     'entry must exist after stake');
  assert.strictEqual(entry.fromAddress, 'wtc1q-alice');
  assert.strictEqual(entry.wtcAmount,   5_000);
  assert.strictEqual(entry.status,      'pending');
  assert.ok(entry.createdAtMs > 0,                     'createdAtMs must be set');
  assert.strictEqual(entry.rewardAtMs,   null);
  assert.strictEqual(entry.rewardAmount, null);
  assert.strictEqual(entry.rewardTxId,   null);
  assert.strictEqual(entry.apyAtFlush,   null);
  assert.strictEqual(entry.failReason,   null);
}

function testStakeAmountIsFloored() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  let result;
  silenceLogs(() => { result = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000.9 }); });
  const entry = sq.getEntry(result.entryId);
  assert.strictEqual(entry.wtcAmount, 5_000, 'fractional WTC must be floored on entry');
}

function testStakeDuplicateAddressReturnsSameEntry() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  let r1, r2;
  silenceLogs(() => {
    r1 = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
    r2 = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 9_000 });
  });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.alreadyExists, true,        'second stake from same address must set alreadyExists');
  assert.strictEqual(r1.entryId, r2.entryId,        'both calls must return the same entryId');
  assert.strictEqual(sq.getAllEntries().length, 1,   'duplicate entry must not be created');
}

function testStakeAllowsDifferentAddresses() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 5_000 });
  });
  assert.strictEqual(sq.getAllEntries().length, 2, 'different addresses must each get their own entry');
}

// ─── totalPendingWtc ──────────────────────────────────────────────────────────

function testTotalPendingWtcSumsAllPending() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 3_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 7_000 });
  });
  assert.strictEqual(sq.totalPendingWtc(), 10_000);
}

function testTotalPendingWtcIgnoresCancelledEntries() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 5_000 });
    sq.cancelEntry(r.entryId);
  });
  assert.strictEqual(sq.totalPendingWtc(), 5_000, 'cancelled entries must be excluded from total');
}

function testTotalPendingWtcZeroWithNoEntries() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.strictEqual(sq.totalPendingWtc(), 0);
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function testEntriesPersistedToDisk() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  // Re-init from same directory — entry must survive
  silenceLogs(() => initQueue(dir));
  const entries = sq.getAllEntries();
  assert.strictEqual(entries.length, 1,               'entry must survive re-init');
  assert.strictEqual(entries[0].fromAddress, 'wtc1q-alice');
  assert.strictEqual(entries[0].status,      'pending');
}

function testHmacTamperDetectedResetsQueue() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  assert.strictEqual(sq.getAllEntries().length, 1, 'precondition: one entry saved');

  // Corrupt the _sig in the saved file.
  const raw = JSON.parse(fs.readFileSync(entriesPath(dir), 'utf8'));
  raw._sig = 'a'.repeat(64);
  fs.writeFileSync(entriesPath(dir), JSON.stringify(raw), 'utf8');

  const warns = captureWarns(() => sq.init(dir, null));
  assert.ok(
    warns.some(m => m.includes('Tampered')),
    'tampered file must produce a warning containing "Tampered"'
  );
  assert.strictEqual(sq.getAllEntries().length, 0, 'queue must be reset after HMAC tamper detection');
}

function testLegacyPlainArrayFileMigrates() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));

  // Write a legacy plain-array file (no { entries, _sig } wrapper).
  const legacyEntries = [{
    id:           'legacy-entry-1',
    fromAddress:  'wtc1q-legacy',
    wtcAmount:    5_000,
    status:       'pending',
    createdAtMs:  Date.now(),
    rewardAtMs:   null,
    rewardAmount: null,
    rewardTxId:   null,
    apyAtFlush:   null,
    failReason:   null,
  }];
  fs.writeFileSync(entriesPath(dir), JSON.stringify(legacyEntries), 'utf8');

  silenceLogs(() => initQueue(dir));
  const entries = sq.getAllEntries();
  assert.strictEqual(entries.length,    1,                  'legacy plain-array format must be loaded');
  assert.strictEqual(entries[0].id,     'legacy-entry-1');
  assert.strictEqual(entries[0].status, 'pending');
}

function testSaveUsesAtomicTmpRename() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  // .tmp file must NOT linger after save completes
  assert.strictEqual(fs.existsSync(entriesPath(dir) + '.tmp'), false, '.tmp file must not linger after save');
  assert.ok(fs.existsSync(entriesPath(dir)),                          'entries file must exist after save');
}

function testEmptyDirLoadsAsEmptyQueue() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.strictEqual(sq.getAllEntries().length,  0);
  assert.strictEqual(sq.totalPendingWtc(),       0);
  assert.strictEqual(sq.shouldFlush(),           false);
}

// ─── cancelEntry ─────────────────────────────────────────────────────────────

function testCancelPendingEntry() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  const cr = sq.cancelEntry(r.entryId);
  assert.strictEqual(cr.ok, true, 'cancel must succeed for a pending entry');
  assert.strictEqual(sq.getEntry(r.entryId).status, 'cancelled');
}

function testCancelPersistsToDisk() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  sq.cancelEntry(r.entryId);

  silenceLogs(() => initQueue(dir));
  assert.strictEqual(sq.getEntry(r.entryId).status, 'cancelled', 'cancelled status must survive re-init');
}

function testCancelAlreadyCancelledEntryFails() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  sq.cancelEntry(r.entryId);
  const r2 = sq.cancelEntry(r.entryId);
  assert.strictEqual(r2.ok, false, 'cancelling an already-cancelled entry must fail');
  assert.ok(r2.error,               'error message must be present');
}

function testCancelUnknownIdFails() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  const r = sq.cancelEntry('nonexistent-entry-id');
  assert.strictEqual(r.ok, false,    'cancelling a nonexistent entry must fail');
  assert.ok(r.error,                 'error message must be present');
}

function testCancelReducesTotalPendingWtc() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
  });
  assert.strictEqual(sq.totalPendingWtc(), 5_000);
  sq.cancelEntry(r.entryId);
  assert.strictEqual(sq.totalPendingWtc(), 0, 'totalPendingWtc must decrease after cancel');
}

// ─── shouldFlush ─────────────────────────────────────────────────────────────

function testShouldFlushFalseBeforeThreshold() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 9_999 });
  });
  assert.strictEqual(sq.shouldFlush(), false, 'shouldFlush must be false below 10 000 WTC');
}

function testShouldFlushTrueAtThreshold() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  assert.strictEqual(sq.shouldFlush(), true, 'shouldFlush must be true at exactly 10 000 WTC');
}

function testShouldFlushTrueAboveThreshold() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 50_000 });
  });
  assert.strictEqual(sq.shouldFlush(), true, 'shouldFlush must be true above the threshold');
}

// ─── poolBalance ─────────────────────────────────────────────────────────────

function testPoolBalanceNullWithoutNode() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir, null));
  assert.strictEqual(sq.poolBalance(), null, 'poolBalance must be null without a wtcNode');
}

function testPoolBalanceQueriesNode() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 500_000 });
  silenceLogs(() => initQueue(dir, node));
  assert.strictEqual(sq.poolBalance(), 500_000, 'poolBalance must return the node getBalance result');
}

// ─── flushStakingQueue ────────────────────────────────────────────────────────

async function testFlushNoNodeDoesNothing() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir, null);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  // Must not throw; entries stay pending
  await silenceLogsAsync(() => sq.flushStakingQueue());
  assert.strictEqual(
    sq.getAllEntries()[0].status, 'pending',
    'entries must remain pending when no wtcNode is configured'
  );
}

async function testFlushEmptyBatchDoesNothing() {
  const dir = makeTmpDir();
  const node = makeMockNode();
  silenceLogs(() => initQueue(dir, node));
  await silenceLogsAsync(() => sq.flushStakingQueue());
  assert.strictEqual(node._calls.length, 0, 'send must not be called when there are no pending entries');
}

async function testFlushZeroRewardForSmallStake() {
  const dir = makeTmpDir();
  const node = makeMockNode();
  silenceLogs(() => {
    initQueue(dir, node);
    // 100 WTC → APY = 0.01% → reward = floor(100 × 0.01 / 100) = floor(0.01) = 0
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());
  const entry = sq.getAllEntries()[0];
  assert.strictEqual(entry.status,       'rewarded', 'entry must be rewarded even when reward rounds to 0');
  assert.strictEqual(entry.rewardAmount,  0,         'reward amount must be 0 when stake × APY < 1 WTC');
  assert.strictEqual(entry.apyAtFlush,    0.01);
  assert.strictEqual(node._calls.length,  0,         'send must not be called when reward is 0');
}

async function testFlushPaysCorrectRewardSingleStaker() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000, sendTxid: 'test-txid-1' });
  silenceLogs(() => {
    initQueue(dir, node);
    // 100 000 WTC → APY = 10% → reward = floor(100 000 × 10 / 100) = 10 000
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());

  assert.strictEqual(node._calls.length, 1, 'send must be called exactly once');
  assert.strictEqual(node._calls[0].toAddress,   'wtc1q-alice');
  assert.strictEqual(node._calls[0].fromAddress,  sq.STAKING_POOL_ADDRESS);
  assert.strictEqual(node._calls[0].amount,        10_000);

  const entry = sq.getAllEntries()[0];
  assert.strictEqual(entry.status,       'rewarded');
  assert.strictEqual(entry.rewardAmount,  10_000);
  assert.strictEqual(entry.rewardTxId,   'test-txid-1');
  assert.strictEqual(entry.apyAtFlush,    10);
  assert.ok(entry.rewardAtMs > 0, 'rewardAtMs must be set after flush');
}

async function testFlushRewardAmountIsFloored() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000 });
  silenceLogs(() => {
    initQueue(dir, node);
    // 15 000 WTC → APY = round(15 000 / 10 000 * 100) / 100 = 1.50%
    // reward = floor(15 000 × 1.50 / 100) = floor(225) = 225
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 15_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());
  assert.strictEqual(sq.getAllEntries()[0].rewardAmount, 225, 'reward must be floor(15 000 × 1.50%)');
}

async function testFlushPaysMultipleStakers() {
  const dir = makeTmpDir();
  const calls = [];
  let txCount = 0;
  const node = {
    getBalance: () => ({ confirmed: 1_000_000, unmatured: 0 }),
    send: (opts) => {
      calls.push({ ...opts });
      txCount++;
      return { txid: `mock-txid-${txCount}` };
    },
  };
  silenceLogs(() => {
    initQueue(dir, node);
    // Total = 200 000 WTC → APY = 20%
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 100_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());

  assert.strictEqual(calls.length, 2, 'send must be called for each staker');

  const aliceTx = calls.find(c => c.toAddress === 'wtc1q-alice');
  const bobTx   = calls.find(c => c.toAddress === 'wtc1q-bob');
  assert.ok(aliceTx, 'Alice must receive a reward tx');
  assert.ok(bobTx,   'Bob must receive a reward tx');
  // 100 000 × 20% = 20 000 each
  assert.strictEqual(aliceTx.amount, 20_000);
  assert.strictEqual(bobTx.amount,   20_000);

  const entries = sq.getAllEntries();
  assert.ok(entries.every(e => e.status === 'rewarded'), 'all entries must be marked rewarded');
}

async function testFlushSkipsWhenPoolBalanceIsZero() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 0, stakerWtc: 10_000 });
  const warnMsgs = [];
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  const origWarn = console.warn;
  console.warn = (...args) => warnMsgs.push(args.map(String).join(' '));
  try {
    await sq.flushStakingQueue();
  } finally {
    console.warn = origWarn;
  }
  assert.ok(
    warnMsgs.some(m => m.includes('pool balance is 0')),
    'zero pool balance must produce a warning'
  );
  assert.strictEqual(node._calls.length, 0, 'send must not be called when pool balance is 0');
  assert.strictEqual(
    sq.getAllEntries()[0].status, 'pending',
    'entries must remain pending when pool is empty'
  );
}

async function testFlushMarksFailedWhenPoolInsufficient() {
  const dir = makeTmpDir();
  // Pool has 500 WTC but reward for 100 000 staked @ 10% APY = 10 000
  const node = makeMockNode({ poolWtc: 500, stakerWtc: 100_000 });
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());

  const entry = sq.getAllEntries()[0];
  assert.strictEqual(entry.status,     'failed',           'entry must be failed when pool cannot cover reward');
  assert.strictEqual(entry.failReason, 'pool_insufficient');
  assert.strictEqual(node._calls.length, 0,                'send must not be called when pool is insufficient');
}

async function testFlushSendExceptionMarksEntryFailed() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000, sendThrows: 'insufficient funds' });
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());

  const entry = sq.getAllEntries()[0];
  assert.strictEqual(entry.status, 'failed', 'entry must be failed when send throws');
  assert.ok(
    entry.failReason && entry.failReason.includes('insufficient funds'),
    'failReason must capture the error message'
  );
  assert.ok(entry.rewardAtMs > 0, 'rewardAtMs must be set even on failure');
  assert.ok(entry.apyAtFlush !== null, 'apyAtFlush must be set even on failure');
}

async function testFlushContinuesAfterOneEntryFails() {
  const dir = makeTmpDir();
  let callCount = 0;
  const node = {
    getBalance: () => ({ confirmed: 1_000_000, unmatured: 0 }),
    send: (opts) => {
      callCount++;
      if (opts.toAddress === 'wtc1q-alice') throw new Error('alice node error');
      return { txid: 'bob-txid' };
    },
  };
  silenceLogs(() => {
    initQueue(dir, node);
    // Total = 200 000 → APY = 20%
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 100_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 100_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());

  const alice = sq.getAllEntries().find(e => e.fromAddress === 'wtc1q-alice');
  const bob   = sq.getAllEntries().find(e => e.fromAddress === 'wtc1q-bob');
  assert.strictEqual(alice.status, 'failed',   'Alice entry must be marked failed');
  assert.strictEqual(bob.status,   'rewarded', 'Bob entry must be rewarded despite Alice failing');
  assert.strictEqual(callCount, 2,             'send must be attempted for each entry');
}

async function testFlushPersistsResultsToDisk() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000 });
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());

  // Re-init from disk — rewarded status and txid must survive
  silenceLogs(() => initQueue(dir));
  const entries = sq.getAllEntries();
  assert.strictEqual(entries[0].status, 'rewarded', 'rewarded status must survive re-init');
  assert.ok(entries[0].rewardTxId,                  'rewardTxId must survive re-init');
  assert.ok(entries[0].rewardAmount > 0,             'rewardAmount must survive re-init');
}

async function testFlushDoesNotReprocessRewardedEntries() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000 });
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  await silenceLogsAsync(() => sq.flushStakingQueue());
  const callsAfterFirst = node._calls.length;

  // Second flush — nothing is pending
  await silenceLogsAsync(() => sq.flushStakingQueue());
  assert.strictEqual(
    node._calls.length, callsAfterFirst,
    'second flush must not re-process already-rewarded entries'
  );
}

async function testConcurrentFlushDoesNotDoublePayRewards() {
  // JavaScript is single-threaded: with a synchronous send(), the first flush
  // runs its entire loop synchronously before the second flush's batch is even
  // evaluated.  This test documents that invariant and will catch regression if
  // send() is ever changed to be async without adding a guard.
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000 });
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  await silenceLogsAsync(() => Promise.all([
    sq.flushStakingQueue(),
    sq.flushStakingQueue(),
  ]));
  assert.strictEqual(node._calls.length, 1, 'concurrent flushes must not double-pay rewards');
}

// ─── Query API ────────────────────────────────────────────────────────────────

function testGetEntryReturnsNullForUnknownId() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.strictEqual(sq.getEntry('no-such-id'), null);
}

function testGetEntryReturnsShallowClone() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  let r;
  silenceLogs(() => { r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 }); });
  const entry = sq.getEntry(r.entryId);
  // Mutating the returned clone must not affect internal state
  entry.fromAddress = 'hacked';
  assert.strictEqual(sq.getEntry(r.entryId).fromAddress, 'wtc1q-alice', 'getEntry must return a clone');
}

function testGetEntryForAddressFiltersCorrectly() {
  const dir = makeTmpDir();
  silenceLogs(() => {
    initQueue(dir);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 5_000 });
  });
  const aliceEntries = sq.getEntryForAddress('wtc1q-alice');
  assert.strictEqual(aliceEntries.length, 1);
  assert.strictEqual(aliceEntries[0].fromAddress, 'wtc1q-alice');
}

function testGetEntryForAddressEmptyForUnknownAddress() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.deepStrictEqual(sq.getEntryForAddress('wtc1q-nobody'), []);
}

function testGetEntryForNullAddressReturnsEmpty() {
  const dir = makeTmpDir();
  silenceLogs(() => initQueue(dir));
  assert.deepStrictEqual(sq.getEntryForAddress(null), []);
}

function testGetAllEntriesReturnsAllStatuses() {
  const dir = makeTmpDir();
  let r;
  silenceLogs(() => {
    initQueue(dir);
    r = sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 5_000 });
    sq.stakeWtc({ fromAddress: 'wtc1q-bob',   wtcAmount: 5_000 });
    sq.cancelEntry(r.entryId);
  });
  const all = sq.getAllEntries();
  assert.strictEqual(all.length, 2);
  const statuses = all.map(e => e.status).sort();
  assert.deepStrictEqual(statuses, ['cancelled', 'pending']);
}

// ─── _maybeFlushByThreshold ───────────────────────────────────────────────────

async function testMaybeFlushDoesNotFireBelowThreshold() {
  const dir = makeTmpDir();
  const node = makeMockNode();
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 9_999 });
  });
  await silenceLogsAsync(() => sq._maybeFlushByThreshold());
  assert.strictEqual(node._calls.length, 0,       '_maybeFlushByThreshold must not flush below threshold');
  assert.strictEqual(sq.getAllEntries()[0].status, 'pending');
}

async function testMaybeFlushFiresAtThreshold() {
  const dir = makeTmpDir();
  const node = makeMockNode({ poolWtc: 1_000_000 });
  silenceLogs(() => {
    initQueue(dir, node);
    sq.stakeWtc({ fromAddress: 'wtc1q-alice', wtcAmount: 10_000 });
  });
  await silenceLogsAsync(() => sq._maybeFlushByThreshold());
  // 10 000 WTC → APY=1% → reward=100 WTC
  assert.strictEqual(node._calls.length, 1,        '_maybeFlushByThreshold must flush at threshold');
  assert.strictEqual(sq.getAllEntries()[0].status, 'rewarded');
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  // APY computation
  testApyZeroWithNoEntries();
  testApyFractionalBelowOldThreshold();
  testApyOnePercentAt10k();
  testApyMinimumNonZeroAt100Wtc();
  testApyFormula();
  testApyCappedAt100Percent();
  testApyIgnoresCancelledEntries();

  // stakeWtc
  testStakeRejectsEmptyAddress();
  testStakeRejectsUndefinedAddress();
  testStakeRejectsBelowMinimum();
  testStakeRejectsNonFiniteAmount();
  testStakeAtExactMinimum();
  testStakeCreatesEntryWithCorrectFields();
  testStakeAmountIsFloored();
  testStakeDuplicateAddressReturnsSameEntry();
  testStakeAllowsDifferentAddresses();

  // totalPendingWtc
  testTotalPendingWtcSumsAllPending();
  testTotalPendingWtcIgnoresCancelledEntries();
  testTotalPendingWtcZeroWithNoEntries();

  // Persistence
  testEntriesPersistedToDisk();
  testHmacTamperDetectedResetsQueue();
  testLegacyPlainArrayFileMigrates();
  testSaveUsesAtomicTmpRename();
  testEmptyDirLoadsAsEmptyQueue();

  // cancelEntry
  testCancelPendingEntry();
  testCancelPersistsToDisk();
  testCancelAlreadyCancelledEntryFails();
  testCancelUnknownIdFails();
  testCancelReducesTotalPendingWtc();

  // shouldFlush
  testShouldFlushFalseBeforeThreshold();
  testShouldFlushTrueAtThreshold();
  testShouldFlushTrueAboveThreshold();

  // poolBalance
  testPoolBalanceNullWithoutNode();
  testPoolBalanceQueriesNode();

  // flushStakingQueue
  await testFlushNoNodeDoesNothing();
  await testFlushEmptyBatchDoesNothing();
  await testFlushZeroRewardForSmallStake();
  await testFlushPaysCorrectRewardSingleStaker();
  await testFlushRewardAmountIsFloored();
  await testFlushPaysMultipleStakers();
  await testFlushSkipsWhenPoolBalanceIsZero();
  await testFlushMarksFailedWhenPoolInsufficient();
  await testFlushSendExceptionMarksEntryFailed();
  await testFlushContinuesAfterOneEntryFails();
  await testFlushPersistsResultsToDisk();
  await testFlushDoesNotReprocessRewardedEntries();
  await testConcurrentFlushDoesNotDoublePayRewards();

  // Query API
  testGetEntryReturnsNullForUnknownId();
  testGetEntryReturnsShallowClone();
  testGetEntryForAddressFiltersCorrectly();
  testGetEntryForAddressEmptyForUnknownAddress();
  testGetEntryForNullAddressReturnsEmpty();
  testGetAllEntriesReturnsAllStatuses();

  // _maybeFlushByThreshold
  await testMaybeFlushDoesNotFireBelowThreshold();
  await testMaybeFlushFiresAtThreshold();

  console.log('staking queue tests passed');
}

run().catch(e => { console.error(e); process.exit(1); });
