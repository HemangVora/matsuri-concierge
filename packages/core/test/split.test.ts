import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill } from '../src/split.ts';

test('hub split: friends pay the organizer, organizer pays the other payer', () => {
  const r = splitBill({
    organizer: 'You', participants: ['You', 'Aoi', 'Mei', 'Ken'],
    payments: [{ name: 'You', amountYen: 2600 }, { name: 'Ken', amountYen: 1800 }],
  });
  assert.equal(r.totalYen, 4400);
  assert.deepEqual(r.shares, { You: 1100, Aoi: 1100, Mei: 1100, Ken: 1100 });
  assert.deepEqual(r.transfers, [
    { from: 'Aoi', to: 'You', amountYen: 1100 },
    { from: 'Mei', to: 'You', amountYen: 1100 },
    { from: 'You', to: 'Ken', amountYen: 700 },
  ]);
});

test('remainder yen go to the first participants, never lost', () => {
  const r = splitBill({ organizer: 'You', participants: ['You', 'Aoi', 'Mei'], payments: [{ name: 'You', amountYen: 1000 }] });
  assert.deepEqual(r.shares, { You: 334, Aoi: 333, Mei: 333 });
  assert.equal(Object.values(r.shares).reduce((a, b) => a + b, 0), 1000);
});

test('rejects payers who are not participants and non-integer yen', () => {
  assert.throws(() => splitBill({ organizer: 'You', participants: ['You'], payments: [{ name: 'X', amountYen: 1 }] }));
  assert.throws(() => splitBill({ organizer: 'You', participants: ['You', 'A'], payments: [{ name: 'You', amountYen: 1.5 }] }));
});
