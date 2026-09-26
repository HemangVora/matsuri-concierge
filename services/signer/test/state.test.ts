import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openState } from '../src/state.ts';

test('spentTodayYen sums only spends recorded on the same Asia/Tokyo calendar day', () => {
  const s = openState(':memory:');
  const noonJstAsUtc = new Date('2026-09-26T03:00:00.000Z'); // 12:00 JST on 2026-09-26
  s.recordSpend(600, noonJstAsUtc);
  s.recordSpend(300, new Date('2026-09-26T14:59:59.000Z')); // 23:59:59 JST, still the same day
  s.recordSpend(9999, new Date('2026-09-26T15:00:00.000Z')); // 00:00:00 JST next day — excluded
  s.recordSpend(9999, new Date('2026-09-25T14:59:59.000Z')); // the day before — excluded
  assert.equal(s.spentTodayYen(noonJstAsUtc), 900);
});

test('recordSpend ignores zero/negative amounts', () => {
  const s = openState(':memory:');
  s.recordSpend(0);
  s.recordSpend(-500);
  assert.equal(s.spentTodayYen(), 0);
});

test('tryClaim atomically claims a proposal id and its approval key, and reserves the spend', () => {
  const s = openState(':memory:');
  assert.equal(s.isConsumed('p1'), false);
  assert.equal(s.isApprovalUsed('key-a'), false);

  assert.equal(s.tryClaim('p1', 'key-a', 600), true);
  assert.equal(s.isConsumed('p1'), true);
  assert.equal(s.isApprovalUsed('key-a'), true);
  // The spend is reserved as part of the claim itself, not after some later "send" step.
  assert.equal(s.spentTodayYen(), 600);
});

test('a second claim of the same proposal id fails and reserves nothing further', () => {
  const s = openState(':memory:');
  assert.equal(s.tryClaim('p1', 'key-a', 600), true);
  assert.equal(s.tryClaim('p1', 'key-b', 100), false); // same proposal id, different approval — still refused
  assert.equal(s.spentTodayYen(), 600);
});

test('a second claim of an already-used approval key fails even under a brand-new proposal id, and rolls back the proposal claim', () => {
  const s = openState(':memory:');
  assert.equal(s.tryClaim('p1', 'key-a', 600), true);
  assert.equal(s.tryClaim('p2', 'key-a', 100), false);
  // p2's proposal-id claim must not be left dangling: a legitimate future proposal reusing that id
  // (which should never happen, but defense in depth) is not falsely blocked by this losing attempt.
  assert.equal(s.isConsumed('p2'), false);
  assert.equal(s.spentTodayYen(), 600);
});

test('tryClaim without an approval key (below-threshold proposals) still guards against replay', () => {
  const s = openState(':memory:');
  assert.equal(s.tryClaim('p1', null, 300), true);
  assert.equal(s.spentTodayYen(), 300);
  assert.equal(s.tryClaim('p1', null, 300), false);
  assert.equal(s.spentTodayYen(), 300);
});

test('a claim that reserves zero yen (e.g. settle) still guards the proposal id', () => {
  const s = openState(':memory:');
  assert.equal(s.tryClaim('settle-1', null, 0), true);
  assert.equal(s.spentTodayYen(), 0);
  assert.equal(s.tryClaim('settle-1', null, 0), false);
});
