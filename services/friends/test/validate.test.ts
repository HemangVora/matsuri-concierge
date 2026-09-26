import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Deployments } from '@mc/core';
import { ALLOWED_PAY_ORIGINS, validateAccepts, validatePayUrl } from '../src/validate.ts';

const deployments: Deployments = {
  chainId: 11155111,
  stablecoin: '0x1c7A95BE9B92b08E79bc906FF05E314f219a0bf3',
  voucher: '0xa94124E8149b7e09ec4AE0345C5ccD1e7eAd4aE2',
  settlement: '0x1804fd65F65AC75954724f6aB1385B97346B5a0E',
};
const organizer = '0x00000000000000000000000000000000000000ee';

function accept(overrides: Record<string, unknown> = {}) {
  return {
    scheme: 'eip712-share',
    chainId: deployments.chainId,
    settlement: deployments.settlement,
    token: deployments.stablecoin,
    to: organizer,
    amount: '1100000000000000000000',
    amountYen: 1100,
    billId: '0xbill',
    deadline: 1234567890,
    memo: 'dinner',
    ...overrides,
  };
}

// --- validatePayUrl ---

test('validatePayUrl: accepts the api on localhost and 127.0.0.1', () => {
  assert.equal(validatePayUrl('http://localhost:8787/kanjo/bills/1/pay', ALLOWED_PAY_ORIGINS), null);
  assert.equal(validatePayUrl('http://127.0.0.1:8787/kanjo/bills/1/pay', ALLOWED_PAY_ORIGINS), null);
});

test('validatePayUrl: rejects any other origin', () => {
  assert.match(validatePayUrl('https://evil.example/pay', ALLOWED_PAY_ORIGINS)!, /not the api/);
  assert.match(validatePayUrl('http://localhost:9999/pay', ALLOWED_PAY_ORIGINS)!, /not the api/);
});

test('validatePayUrl: rejects malformed or missing input', () => {
  assert.match(validatePayUrl('not-a-url', ALLOWED_PAY_ORIGINS)!, /not a valid URL/);
  assert.match(validatePayUrl(undefined, ALLOWED_PAY_ORIGINS)!, /non-empty string/);
  assert.match(validatePayUrl('', ALLOWED_PAY_ORIGINS)!, /non-empty string/);
});

// --- validateAccepts ---

test('validateAccepts: accepts a well-formed, matching 402 body', () => {
  const r = validateAccepts({ accepts: [accept()] }, deployments, organizer);
  assert.equal(r.ok, true);
});

test('validateAccepts: settlement/token match is case-insensitive', () => {
  const r = validateAccepts(
    { accepts: [accept({ settlement: deployments.settlement.toLowerCase(), token: deployments.stablecoin.toUpperCase() })] },
    deployments,
    organizer,
  );
  assert.equal(r.ok, true);
});

test('validateAccepts: rejects a missing accepts[0]', () => {
  const r = validateAccepts({ accepts: [] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /missing accepts\[0\]/);
});

test('validateAccepts: rejects a missing accepts array entirely', () => {
  const r = validateAccepts({}, deployments, organizer);
  assert.equal(r.ok, false);
});

test('validateAccepts: rejects an unsupported scheme', () => {
  const r = validateAccepts({ accepts: [accept({ scheme: 'eip712-voucher' })] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /unsupported scheme/);
});

test('validateAccepts: rejects a mismatched chainId', () => {
  const r = validateAccepts({ accepts: [accept({ chainId: 1 })] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /chainId/);
});

test('validateAccepts: rejects a mismatched settlement contract', () => {
  const r = validateAccepts({ accepts: [accept({ settlement: '0x000000000000000000000000000000deadbeef' })] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /settlement/);
});

test('validateAccepts: rejects a mismatched token', () => {
  const r = validateAccepts({ accepts: [accept({ token: '0x000000000000000000000000000000deadbeef' })] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /token/);
});

test('validateAccepts: rejects amountYen over the friend agent limit', () => {
  const r = validateAccepts({ accepts: [accept({ amountYen: 3001 })] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /friend agent limit/);
});

test('validateAccepts: accepts amountYen exactly at the limit', () => {
  const r = validateAccepts({ accepts: [accept({ amountYen: 3000 })] }, deployments, organizer);
  assert.equal(r.ok, true);
});

test('validateAccepts: rejects a non-integer amountYen', () => {
  const r = validateAccepts({ accepts: [accept({ amountYen: 1100.5 })] }, deployments, organizer);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /friend agent limit/);
});

test('validateAccepts: rejects a zero or negative amountYen', () => {
  assert.equal(validateAccepts({ accepts: [accept({ amountYen: 0 })] }, deployments, organizer).ok, false);
  assert.equal(validateAccepts({ accepts: [accept({ amountYen: -5 })] }, deployments, organizer).ok, false);
});

test('validateAccepts: rejects missing required string/number fields', () => {
  assert.equal(validateAccepts({ accepts: [accept({ to: undefined })] }, deployments, organizer).ok, false);
  assert.equal(validateAccepts({ accepts: [accept({ amount: undefined })] }, deployments, organizer).ok, false);
  assert.equal(validateAccepts({ accepts: [accept({ billId: undefined })] }, deployments, organizer).ok, false);
  assert.equal(validateAccepts({ accepts: [accept({ deadline: 'soon' })] }, deployments, organizer).ok, false);
});

// --- to (organizer) pinning — the critical fix from review round 1 ---

test('validateAccepts: rejects a to that differs from the organizer address (spoofed recipient)', () => {
  const r = validateAccepts(
    { accepts: [accept({ to: '0x000000000000000000000000000000badc0de1' })] },
    deployments,
    organizer,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /organizer/);
});

test('validateAccepts: to match against the organizer is case-insensitive', () => {
  const r = validateAccepts({ accepts: [accept({ to: organizer.toUpperCase() })] }, deployments, organizer);
  assert.equal(r.ok, true);
});
