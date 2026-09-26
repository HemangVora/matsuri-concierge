import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { APPROVAL_TYPES, approvalDomain, erc20Iface, hashProposal, voucherIface, type PolicyConfig } from '@mc/core';
import { verifyForSigning } from '../src/verify.ts';

const deployments = { chainId: 11155111, stablecoin: '0x00000000000000000000000000000000000000c0',
  voucher: '0x00000000000000000000000000000000000000b0', settlement: '0x00000000000000000000000000000000000000d0' };
const policy: PolicyConfig = { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } };
const human = Wallet.createRandom();
const items: Record<number, { priceYen: number; available: number; payTo: string }> = {
  1: { priceYen: 600, available: 9, payTo: '0x00000000000000000000000000000000000000a1' },
  5: { priceYen: 300, available: 9, payTo: '0x00000000000000000000000000000000000000a5' },
};
const ctx = {
  deployments, policy, approver: human.address, agentAddress: '0x00000000000000000000000000000000000000ee', spentTodayYen: 0,
  readItem: async (id: number) => items[id],
  screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now',
    result: address.endsWith('a5') ? { toxicScore: 95, traits: [{ risk: 95, name: 'known_scammer', txsCount: 1, description: 'Known scammer' }] }
                                   : { toxicScore: 1, traits: [] } }),
};
const buy = (itemId: number, qty: number) => ({ to: deployments.voucher, data: voucherIface.encodeFunctionData('buyVoucher', [itemId, qty]), value: '0' });
const order = (txs: any[], approval: any = null) => ({ id: 'p', kind: 'order' as const, chainId: 11155111, txs, approval });

test('clean small order passes', async () => {
  assert.deepEqual(await verifyForSigning(order([buy(1, 1)]), ctx), { ok: true });
});

test('rejects tx to non-allowlisted contract', async () => {
  const r = await verifyForSigning(order([{ ...buy(1, 1), to: '0x00000000000000000000000000000000000000ff' }]), ctx);
  assert.equal(r.ok, false);
});

test('rejects an unexpected selector on an allowlisted contract', async () => {
  const data = erc20Iface.encodeFunctionData('approve', [human.address, 10n ** 30n]);
  const r = await verifyForSigning(order([{ to: deployments.voucher, data, value: '0' }]), ctx);
  assert.equal(r.ok, false);
});

test('re-screens the stall itself and refuses a flagged payTo even if the api let it through', async () => {
  const r = await verifyForSigning(order([buy(5, 1)]), ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /Known scammer/);
});

test('refuses quantities the policy would have capped', async () => {
  assert.equal((await verifyForSigning(order([buy(1, 3)]), ctx)).ok, false); // 1800 > 1500 per stall
});

test('big order needs a signature over the hash the signer computes', async () => {
  const txs = [buy(1, 2)];
  assert.equal((await verifyForSigning(order(txs), ctx)).ok, false);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const signature = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES,
    { proposalHash: hashProposal(11155111, txs), totalYen: 1200, expiresAt });
  assert.deepEqual(await verifyForSigning(order(txs, { signature, totalYen: 1200, expiresAt }), ctx), { ok: true });
  const other = [buy(1, 1), buy(1, 1)];
  assert.equal((await verifyForSigning(order(other, { signature, totalYen: 1200, expiresAt }), ctx)).ok, false);
});

test('transfer to flagged recipient is refused', async () => {
  const data = erc20Iface.encodeFunctionData('transfer', [items[5].payTo, 700n * 10n ** 18n]);
  const r = await verifyForSigning({ id: 't', kind: 'transfer', chainId: 11155111, txs: [{ to: deployments.stablecoin, data, value: '0' }], approval: null }, ctx);
  assert.equal(r.ok, false);
});
