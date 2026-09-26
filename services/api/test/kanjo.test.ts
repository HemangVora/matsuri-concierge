import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { SHARE_TYPES, shareDomain } from '@mc/core';
import { openStore } from '../src/store.ts';
import { acceptPayment, createBill, paymentRequired } from '../src/kanjo.ts';

const aoi = Wallet.createRandom();
const settlement = '0x00000000000000000000000000000000000000d0';
const organizer = '0x00000000000000000000000000000000000000ee';
function deps(flagged = false) {
  const signed: string[] = [];
  return { signed, d: {
    mb: {
      readStalls: async () => [], composeBuy: async () => ({ to: '0x0', data: '0x', value: '0' }),
      composeTransfer: async () => ({ to: '0x00000000000000000000000000000000000000c0', data: '0xfeed', value: '0' }),
      composeSettle: async () => ({ to: settlement, data: '0xabcd', value: '0' }),
    },
    screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now',
      result: flagged ? { toxicScore: 90, traits: [{ risk: 90, name: 'known_scammer', txsCount: 1, description: 'Known scammer' }] } : { toxicScore: 1, traits: [] } }),
    store: openStore(':memory:'),
    policy: { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
      risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } },
    chainId: 11155111, agentAddress: organizer, approverAddress: organizer, publicBaseUrl: 'http://x',
    approvalBaseUrl: 'http://web',
    deployments: { chainId: 11155111, stablecoin: '0xc0', voucher: '0xb0', settlement },
    friends: { Aoi: aoi.address, Mei: Wallet.createRandom().address, Ken: '0x00000000000000000000000000000000000000a5' },
    signer: { sign: async (id: string) => { signed.push(id); return { txHashes: ['0xsettled'] }; } },
  } };
}
async function pay(d: any, billId: string) {
  const req = paymentRequired(d, billId, 'Aoi')!;
  const a = req.accepts[0];
  const share = { billId: a.billId, from: aoi.address, to: a.to, amount: BigInt(a.amount), deadline: BigInt(a.deadline) };
  const signature = await aoi.signTypedData(shareDomain(11155111, settlement), SHARE_TYPES, share);
  return Buffer.from(JSON.stringify({ from: aoi.address, signature })).toString('base64');
}

test('bill: friends owe the organizer, organizer owes Ken', async () => {
  const { d } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi', 'Mei', 'Ken'],
    payments: [{ name: 'You', amountYen: 2600 }, { name: 'Ken', amountYen: 1800 }], memo: 'dinner' });
  assert.deepEqual(b.requests.map((r) => [r.from, r.amountYen]), [['Aoi', 1100], ['Mei', 1100]]);
  assert.deepEqual(b.payouts.map((p) => [p.to, p.amountYen]), [['Ken', 700]]);
});

test('flagged creditor payTo is held, not merely awaiting approval', async () => {
  const { d } = deps(true);
  const b = await createBill(d, { participants: ['You', 'Ken'],
    payments: [{ name: 'Ken', amountYen: 1800 }], memo: 'dinner' });
  assert.deepEqual(b.payouts.map((p) => [p.to, p.status]), [['Ken', 'held']]);
});

test('402 then a valid share settles once; replay is rejected', async () => {
  const { d, signed } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const header = await pay(d, b.billId);
  const first = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.deepEqual([first.status, signed.length], [200, 1]);
  const again = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.equal(again.status, 409);
});

test('flagged payer is held before anything is signed', async () => {
  const { d, signed } = deps(true);
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const r = await acceptPayment(d, b.billId, 'Aoi', await pay(d, b.billId));
  assert.equal(r.status, 403);
  assert.equal(signed.length, 0);
});

test('a share signed by someone else is rejected', async () => {
  const { d } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const forged = Buffer.from(JSON.stringify({ from: aoi.address, signature: '0x' + '11'.repeat(65) })).toString('base64');
  assert.equal((await acceptPayment(d, b.billId, 'Aoi', forged)).status, 400);
});
