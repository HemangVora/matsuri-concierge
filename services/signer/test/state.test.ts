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

test('consumed proposal ids and used approval signatures round-trip', () => {
  const s = openState(':memory:');
  assert.equal(s.isConsumed('p1'), false);
  s.markConsumed('p1');
  assert.equal(s.isConsumed('p1'), true);
  assert.equal(s.isConsumed('p2'), false);

  assert.equal(s.isSignatureUsed('0xsig'), false);
  s.markSignatureUsed('0xsig');
  assert.equal(s.isSignatureUsed('0xsig'), true);
  assert.equal(s.isSignatureUsed('0xother'), false);
});

test('marking the same proposal/signature consumed twice does not throw', () => {
  const s = openState(':memory:');
  s.markConsumed('p1');
  s.markConsumed('p1');
  s.markSignatureUsed('0xsig');
  s.markSignatureUsed('0xsig');
  assert.equal(s.isConsumed('p1'), true);
  assert.equal(s.isSignatureUsed('0xsig'), true);
});
