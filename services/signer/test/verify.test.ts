import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import {
  APPROVAL_TYPES, approvalDomain, erc20Iface, hashProposal, settlementIface, shareDomain, SHARE_TYPES, voucherIface,
  type PolicyConfig,
} from '@mc/core';
import { verifyForSigning, type VerifyCtx } from '../src/verify.ts';

const deployments = { chainId: 11155111, stablecoin: '0x00000000000000000000000000000000000000c0',
  voucher: '0x00000000000000000000000000000000000000b0', settlement: '0x00000000000000000000000000000000000000d0' };
const policy: PolicyConfig = { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } };
const human = Wallet.createRandom();
const agentAddress = '0x00000000000000000000000000000000000000ee';
const items: Record<number, { priceYen: number; available: number; payTo: string }> = {
  1: { priceYen: 600, available: 9, payTo: '0x00000000000000000000000000000000000000a1' },
  5: { priceYen: 300, available: 9, payTo: '0x00000000000000000000000000000000000000a5' },
  // priceYen 500, capFraction 0.5, maxPerStallYen 1500 -> absolute risk cap = floor(1500*0.5/500) = 1
  4: { priceYen: 500, available: 9, payTo: '0x00000000000000000000000000000000000000a4' },
};
const screenResult = (address: string) =>
  address.endsWith('a5')
    ? { toxicScore: 95, traits: [{ risk: 95, name: 'known_scammer', txsCount: 1, description: 'Known scammer' }] }
    : address.endsWith('a4')
    ? { toxicScore: 20, traits: [{ risk: 20, name: 'mixer', txsCount: 1, description: 'Mixer transfers' }] }
    : { toxicScore: 1, traits: [] };

function baseCtx(overrides: Partial<VerifyCtx> = {}): VerifyCtx {
  return {
    deployments, policy, approver: human.address, agentAddress, spentTodayYen: 0,
    ledgerSpentTodayYen: async () => 0,
    isConsumed: async () => false,
    isSignatureUsed: async () => false,
    readItem: async (id: number) => items[id],
    screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now', result: screenResult(address) }),
    ...overrides,
  };
}
const ctx = baseCtx();

const buy = (itemId: number, qty: number) => ({ to: deployments.voucher, data: voucherIface.encodeFunctionData('buyVoucher', [itemId, qty]), value: '0' });
const order = (txs: any[], approval: any = null) => ({ id: 'p', kind: 'order' as const, chainId: 11155111, txs, approval });

test('clean small order passes', async () => {
  assert.deepEqual(await verifyForSigning(order([buy(1, 1)]), ctx), { ok: true, spendYen: 600 });
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

test('refuses quantities the policy would have capped, with the reason, not just ok===false', async () => {
  const r = await verifyForSigning(order([buy(1, 3)]), ctx); // 1800 > 1500 per stall -> capped to 2, requested 3
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /quantity 3 exceeds policy \(2\)/);
});

test('an order composed at the already risk-capped quantity is accepted (CAP is idempotent)', async () => {
  // item 4's payTo screens as a CAP-level risk; the absolute cap is floor(1500*0.5/500) = 1.
  // Composing the proposal directly at that capped quantity must not be capped again.
  const r = await verifyForSigning(order([buy(4, 1)]), ctx);
  assert.deepEqual(r, { ok: true, spendYen: 500 });
});

test('big order needs a signature over the hash the signer computes', async () => {
  const txs = [buy(1, 2)];
  assert.equal((await verifyForSigning(order(txs), ctx)).ok, false);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const signature = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES,
    { proposalHash: hashProposal(11155111, txs), totalYen: 1200, expiresAt });
  assert.deepEqual(await verifyForSigning(order(txs, { signature, totalYen: 1200, expiresAt }), ctx), { ok: true, spendYen: 1200 });
  const other = [buy(1, 1), buy(1, 1)];
  assert.equal((await verifyForSigning(order(other, { signature, totalYen: 1200, expiresAt }), ctx)).ok, false);
});

test('transfer to flagged recipient is refused', async () => {
  const data = erc20Iface.encodeFunctionData('transfer', [items[5].payTo, 700n * 10n ** 18n]);
  const r = await verifyForSigning({ id: 't', kind: 'transfer', chainId: 11155111, txs: [{ to: deployments.stablecoin, data, value: '0' }], approval: null }, ctx);
  assert.equal(r.ok, false);
});

test('native value transfers are refused', async () => {
  const r = await verifyForSigning(order([{ ...buy(1, 1), value: '1' }]), ctx);
  assert.equal(r.ok, false);
});

test('spentTodayYen that is NaN or negative is refused outright, not sanitized', async () => {
  const nan = await verifyForSigning(order([buy(1, 1)]), baseCtx({ spentTodayYen: NaN }));
  assert.equal(nan.ok, false);
  const negative = await verifyForSigning(order([buy(1, 1)]), baseCtx({ spentTodayYen: -1_000_000_000 }));
  assert.equal(negative.ok, false);
});

test("api reports 0 spent but the signer's own ledger says the budget is already used up", async () => {
  const r = await verifyForSigning(order([buy(1, 1)]), baseCtx({ spentTodayYen: 0, ledgerSpentTodayYen: async () => 5000 }));
  assert.equal(r.ok, false);
});

test('replay of a consumed proposal id is refused', async () => {
  const r = await verifyForSigning(order([buy(1, 1)]), baseCtx({ isConsumed: async () => true }));
  assert.equal(r.ok, false);
});

test('replay of an already-used approval signature is refused', async () => {
  const txs = [buy(1, 2)];
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const signature = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES,
    { proposalHash: hashProposal(11155111, txs), totalYen: 1200, expiresAt });
  const r = await verifyForSigning(order(txs, { signature, totalYen: 1200, expiresAt }), baseCtx({ isSignatureUsed: async () => true }));
  assert.equal(r.ok, false);
});

test('malformed calldata is refused, never throws', async () => {
  const truncated = await verifyForSigning(
    { id: 't', kind: 'transfer', chainId: 11155111, txs: [{ to: deployments.stablecoin, data: '0xa9059cbb1234', value: '0' }], approval: null },
    ctx,
  );
  assert.equal(truncated.ok, false);

  const badValue = await verifyForSigning(order([{ ...buy(1, 1), value: 'not-a-number' }]), ctx);
  assert.equal(badValue.ok, false);
});

// --- settle ---

const payer = Wallet.createRandom();
const settleTx = async (opts: { to?: string; from?: string; signer?: ReturnType<typeof Wallet.createRandom> } = {}) => {
  const billId = '0x' + '11'.repeat(32);
  const to = opts.to ?? agentAddress;
  const from = opts.from ?? payer.address;
  const amount = 1000n * 10n ** 18n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signer = opts.signer ?? payer;
  const signature = await signer.signTypedData(shareDomain(11155111, deployments.settlement), SHARE_TYPES, { billId, from, to, amount, deadline });
  const data = settlementIface.encodeFunctionData('settle', [billId, from, to, amount, deadline, signature]);
  return { to: deployments.settlement, data, value: '0' };
};
const settle = (tx: { to: string; data: string; value: string }) => ({ id: 's', kind: 'settle' as const, chainId: 11155111, txs: [tx], approval: null });

test('settle happy path: payer signed a share paying the agent wallet', async () => {
  const tx = await settleTx();
  const r = await verifyForSigning(settle(tx), ctx);
  assert.deepEqual(r, { ok: true, spendYen: 0 });
});

test('settle refuses when the payout does not go to the agent wallet', async () => {
  const tx = await settleTx({ to: '0x00000000000000000000000000000000000000f1' });
  const r = await verifyForSigning(settle(tx), ctx);
  assert.equal(r.ok, false);
});

test('settle refuses a share signed by someone other than the claimed payer', async () => {
  const impostor = Wallet.createRandom();
  const tx = await settleTx({ signer: impostor });
  const r = await verifyForSigning(settle(tx), ctx);
  assert.equal(r.ok, false);
});
