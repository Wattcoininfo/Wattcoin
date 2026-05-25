'use strict';

const assert = require('assert');

const { checkLedgerNetworkAuth } = require('../ops-health');

// ─── Tests ───────────────────────────────────────────────────────────────────

function testMatchingTokensGrantAccess() {
  assert.strictEqual(
    checkLedgerNetworkAuth('secret-token-abc', 'secret-token-abc'),
    true,
    'identical tokens should return true',
  );
}

function testMismatchedTokenDeniesAccess() {
  assert.strictEqual(
    checkLedgerNetworkAuth('wrong-token', 'secret-token-abc'),
    false,
    'non-matching tokens should return false',
  );
}

function testEmptySuppliedTokenDeniesAccess() {
  assert.strictEqual(checkLedgerNetworkAuth('', 'secret-token-abc'), false, 'empty supplied token should return false');
}

function testNullSuppliedTokenDeniesAccess() {
  assert.strictEqual(
    checkLedgerNetworkAuth(null, 'secret-token-abc'),
    false,
    'null supplied token should return false',
  );
}

function testUndefinedSuppliedTokenDeniesAccess() {
  assert.strictEqual(
    checkLedgerNetworkAuth(undefined, 'secret-token-abc'),
    false,
    'undefined supplied token should return false',
  );
}

function testFailClosedWhenRequiredTokenIsEmpty() {
  // Fail-closed: no required token configured → never accept anything.
  assert.strictEqual(
    checkLedgerNetworkAuth('some-supplied-token', ''),
    false,
    'should fail closed when required token is empty string',
  );
}

function testFailClosedWhenRequiredTokenIsNull() {
  assert.strictEqual(
    checkLedgerNetworkAuth('some-supplied-token', null),
    false,
    'should fail closed when required token is null',
  );
}

function testFailClosedWhenRequiredTokenIsUndefined() {
  assert.strictEqual(
    checkLedgerNetworkAuth('some-supplied-token', undefined),
    false,
    'should fail closed when required token is undefined',
  );
}

function testWhitespaceOnlySuppliedTokenDeniesAccess() {
  assert.strictEqual(
    checkLedgerNetworkAuth('   ', 'secret-token-abc'),
    false,
    'whitespace-only supplied token should return false (trimmed to empty)',
  );
}

function testSurroundingWhitespaceIsTrimmedBeforeComparison() {
  assert.strictEqual(
    checkLedgerNetworkAuth('  secret-token-abc  ', 'secret-token-abc'),
    true,
    'surrounding whitespace should be trimmed — tokens should match after trim',
  );
}

function testDifferentLengthTokensDeny() {
  assert.strictEqual(
    checkLedgerNetworkAuth('short', 'much-longer-required-token'),
    false,
    'different-length tokens must not match',
  );
}

function testSingleCharacterTokenMatchesExactly() {
  assert.strictEqual(checkLedgerNetworkAuth('x', 'x'), true, 'single-char match');
  assert.strictEqual(checkLedgerNetworkAuth('x', 'y'), false, 'single-char mismatch');
}

function testTokensAreTreatedAsCaseSensitive() {
  assert.strictEqual(
    checkLedgerNetworkAuth('Secret-Token', 'secret-token'),
    false,
    'token comparison must be case-sensitive',
  );
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function run() {
  testMatchingTokensGrantAccess();
  testMismatchedTokenDeniesAccess();
  testEmptySuppliedTokenDeniesAccess();
  testNullSuppliedTokenDeniesAccess();
  testUndefinedSuppliedTokenDeniesAccess();
  testFailClosedWhenRequiredTokenIsEmpty();
  testFailClosedWhenRequiredTokenIsNull();
  testFailClosedWhenRequiredTokenIsUndefined();
  testWhitespaceOnlySuppliedTokenDeniesAccess();
  testSurroundingWhitespaceIsTrimmedBeforeComparison();
  testDifferentLengthTokensDeny();
  testSingleCharacterTokenMatchesExactly();
  testTokensAreTreatedAsCaseSensitive();
  console.log('ops auth integration tests passed');
}

run();
