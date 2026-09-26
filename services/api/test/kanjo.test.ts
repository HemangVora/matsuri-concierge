import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, type HDNodeWallet } from 'ethers';
import { SHARE_TYPES, shareDomain } from '@mc/core';
import { openStore } from '../src/store.ts';
import { acceptPayment, createBill, paymentRequired } from '../src/kanjo.ts';

const aoi = Wallet.createRandom();
const mei = Wallet.createRandom();
const settlement = '0x00000000000000000000000000000000000000d0';
const organizer = '0x00000000000000000000000000000000000000ee';
function deps(flagged = false, opts: { failSignerOnce?: boolean; failScreenOnce?: boolean } = {}) {
  const signed: string[] = [];
  let signerCalls = 0;
  let screenCalls = 0;
  return { signed, d: {
    mb: {
      readStalls: async () => [], composeBuy: async () => ({ to: '0x0', data: '0x', value: '0' }),
      composeTransfer: async () => ({ to: '0x00000000000000000000000000000000000000c0', data: '0xfeed', value: '0' }),
      composeSettle: async () => ({ to: settlement, data: '0xabcd', value: '0' }),
    },
    screen: async (address: string) => {
      screenCalls++;
      if (opts.failScreenOnce && screenCalls === 1) return { address, ok: false, error: 'timeout', fetchedAt: 'now' };
      return { address, ok: true, fetchedAt: 'now',
        result: flagged ? { toxicScore: 90, traits: [{ risk: 90, name: 'known_scammer', txsCount: 1, description: 'Known scammer' }] } : { toxicScore: 1, traits: [] } };
    },
    store: openStore(':memory:'),
    policy: { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
      risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } },
    chainId: 11155111, agentAddress: organizer, approverAddress: organizer, publicBaseUrl: 'http://x',
    approvalBaseUrl: 'http://web',
    deployments: { chainId: 11155111, stablecoin: '0xc0', voucher: '0xb0', settlement },
    friends: { Aoi: aoi.address, Mei: mei.address, Ken: '0x00000000000000000000000000000000000000a5' },
    signer: { sign: async (id: string) => {
      signerCalls++;
      if (opts.failSignerOnce && signerCalls === 1) throw new Error('signer unavailable');
      signed.push(id); return { txHashes: ['0xsettled'] };
    } },
  } };
}
async function payAs(d: any, billId: string, fromName: string, wallet: HDNodeWallet) {
  const req = paymentRequired(d, billId, fromName)!;
  const a = req.accepts[0];
  const share = { billId: a.billId, from: wallet.address, to: a.to, amount: BigInt(a.amount), deadline: BigInt(a.deadline) };
  const signature = await wallet.signTypedData(shareDomain(11155111, settlement), SHARE_TYPES, share);
  return Buffer.from(JSON.stringify({ from: wallet.address, signature })).toString('base64');
}
async function pay(d: any, billId: string) {
  return payAs(d, billId, 'Aoi', aoi);
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

test('Mei signing Aoi\'s line is rejected as a payer mismatch, not accepted as Aoi\'s payment', async () => {
  const { d, signed } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi', 'Mei'], payments: [{ name: 'You', amountYen: 3300 }], memo: 'x' });
  const header = await payAs(d, b.billId, 'Aoi', mei); // valid share, but signed by Mei against Aoi's request
  const r = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.deepEqual([r.status, (r.body as { error?: string }).error, signed.length], [403, 'Payer does not match this request', 0]);
});

test('a request that is already paid cannot be settled again, even with a fresh valid share', async () => {
  const { d } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  assert.equal((await acceptPayment(d, b.billId, 'Aoi', await pay(d, b.billId))).status, 200);
  // A second, freshly-signed share for the same (already paid) request must still be rejected.
  assert.equal((await acceptPayment(d, b.billId, 'Aoi', await pay(d, b.billId))).status, 409);
});

test('a screening failure returns 503 without holding the request or marking the share; retry with an ok screening then succeeds', async () => {
  const { d } = deps(false, { failScreenOnce: true });
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const header = await pay(d, b.billId);
  const first = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.deepEqual([first.status, (first.body as { retry?: boolean }).retry], [503, true]);
  const bill = d.store.getBill(b.billId) as { requests: { status: string }[] };
  assert.equal(bill.requests[0].status, 'pending');
  const second = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.equal(second.status, 200);
});

test('a signer failure unmarks the share so a retry with the same valid share succeeds', async () => {
  const { d, signed } = deps(false, { failSignerOnce: true });
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const header = await pay(d, b.billId);
  const first = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.equal(first.status, 502);
  const second = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.deepEqual([second.status, signed.length], [200, 1]);
});

test('createBill validates every creditor address before proposing or persisting anything', async () => {
  const { d } = deps();
  // Mei is a resolvable creditor and would be proposed first; Ken (a later creditor) has no known
  // address. If validation isn't upfront, Mei's payout proposal gets inserted before the throw.
  const missingKen = { ...d, friends: { Aoi: aoi.address, Mei: mei.address } };
  await assert.rejects(
    () => createBill(missingKen, { participants: ['You', 'Aoi', 'Mei', 'Ken'],
      payments: [{ name: 'Mei', amountYen: 3000 }, { name: 'Ken', amountYen: 3000 }], memo: 'x' }),
    /No address for Ken/,
  );
  assert.deepEqual(d.store.listProposals(), []);
});
