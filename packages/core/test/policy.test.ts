import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrder, evaluateTransfer } from '../src/policy.ts';
import type { PolicyConfig, RiskAssessment, Stall } from '../src/types.ts';

const cfg: PolicyConfig = {
  maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: [] },
};
const stall = (itemId: number, priceYen: number, payTo: string, available = 100): Stall =>
  ({ itemId, name: `S${itemId}`, item: 'x', emoji: '', priceYen, available, payTo });
const stalls = [stall(1, 600, '0xA1'), stall(2, 700, '0xA2'), stall(5, 300, '0xA5'), stall(4, 500, '0xA4')];
const pay: RiskAssessment = { action: 'PAY', score: 1, reasons: [] };
const risk: Record<string, RiskAssessment> = {
  '0xa1': pay, '0xa2': pay,
  '0xa5': { action: 'REFUSE', score: 95, reasons: ['Known scammer'] },
  '0xa4': { action: 'CAP', score: 20, reasons: ['Mixer transfers'] },
};
const run = (lines: any[], spentTodayYen = 0) => evaluateOrder({ lines, stalls, risk, spentTodayYen, cfg });

test('clean small order pays without approval', () => {
  const d = run([{ itemId: 1, quantity: 1 }]);
  assert.deepEqual([d.lines[0].action, d.totalYen, d.requiresApproval], ['PAY', 600, false]);
});
test('order at or above the threshold needs approval', () => {
  const d = run([{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 1 }]);
  assert.equal(d.totalYen, 1300);
  assert.equal(d.requiresApproval, true);
});
test('flagged stall is refused with Intercepta reason and excluded from total', () => {
  const d = run([{ itemId: 5, quantity: 2 }, { itemId: 1, quantity: 1 }]);
  const flagged = d.lines.find((l) => l.itemId === 5)!;
  assert.deepEqual([flagged.action, flagged.qty, flagged.reasons], ['REFUSE', 0, ['Known scammer']]);
  assert.equal(d.totalYen, 600);
});
test('CAP risk halves quantity', () => {
  const l = run([{ itemId: 4, quantity: 2 }]).lines[0];
  assert.deepEqual([l.action, l.qty], ['CAP', 1]);
});
test('per-stall cap trims quantity', () => {
  const l = run([{ itemId: 2, quantity: 3 }]).lines[0]; // 2100 > 1500 → 2 x 700
  assert.deepEqual([l.action, l.qty, l.subtotalYen], ['CAP', 2, 1400]);
});
test('duplicate lines are merged before caps apply', () => {
  const d = run([{ itemId: 2, quantity: 2 }, { itemId: 2, quantity: 2 }]);
  assert.equal(d.lines.length, 1);
  assert.deepEqual([d.lines[0].requestedQty, d.lines[0].qty], [4, 2]);
});
test('unknown stall, sold out, and bad quantities are refused', () => {
  assert.equal(run([{ itemId: 99, quantity: 1 }]).lines[0].action, 'REFUSE');
  assert.equal(evaluateOrder({ lines: [{ itemId: 1, quantity: 5 }], stalls: [stall(1, 600, '0xA1', 2)], risk, spentTodayYen: 0, cfg }).lines[0].action, 'REFUSE');
  assert.equal(run([{ itemId: 1, quantity: 0 }]).lines[0].action, 'REFUSE');
  assert.equal(run([{ itemId: 1, quantity: 1.5 }]).lines[0].action, 'REFUSE');
});
test('missing screening becomes ASK and forces approval', () => {
  const d = evaluateOrder({ lines: [{ itemId: 1, quantity: 1 }], stalls, risk: {}, spentTodayYen: 0, cfg });
  assert.deepEqual([d.lines[0].action, d.requiresApproval], ['ASK', true]);
});
test('over the remaining daily budget refuses everything', () => {
  const d = run([{ itemId: 1, quantity: 2 }], 4000);
  assert.equal(d.refusedAll, true);
  assert.ok(d.lines.every((l) => l.action === 'REFUSE'));
  assert.equal(d.totalYen, 0);
});
test('transfer to a flagged friend is refused; clean big transfer needs approval', () => {
  assert.equal(evaluateTransfer({ to: '0xA5', amountYen: 700, risk: risk['0xa5'], spentTodayYen: 0, cfg }).action, 'REFUSE');
  const t = evaluateTransfer({ to: '0xA1', amountYen: 1200, risk: pay, spentTodayYen: 0, cfg });
  assert.deepEqual([t.action, t.requiresApproval], ['PAY', true]);
});
