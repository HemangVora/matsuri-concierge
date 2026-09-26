import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { APPROVAL_TYPES, approvalDomain, type PolicyConfig } from '@mc/core';
import { openStore } from '../src/store.ts';
import { execute, proposeOrder, proposeTransfer, recordApproval } from '../src/proposals.ts';

const policy: PolicyConfig = { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } };
const human = Wallet.createRandom();
const stalls = [
  { itemId: 1, name: 'Takoyaki', item: 't', emoji: '', priceYen: 600, available: 9, payTo: '0x00000000000000000000000000000000000000a1' },
  { itemId: 5, name: 'Kuro', item: 'k', emoji: '', priceYen: 300, available: 9, payTo: '0x00000000000000000000000000000000000000a5' },
];
function deps(signed: string[] = []) {
  return {
    mb: {
      readStalls: async () => stalls,
      composeBuy: async (itemId: number, qty: number) => ({ to: '0x00000000000000000000000000000000000000b0', data: `0x0${itemId}0${qty}`, value: '0' }),
      composeTransfer: async () => ({ to: '0x00000000000000000000000000000000000000c0', data: '0xfeed', value: '0' }),
    },
    screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now',
      result: address.endsWith('a5') ? { toxicScore: 90, traits: [{ risk: 90, name: 'known_scammer', txsCount: 2, description: 'Known scammer' }] }
                                     : { toxicScore: 2, traits: [] } }),
    store: openStore(':memory:'), policy, chainId: 11155111,
    agentAddress: '0x00000000000000000000000000000000000000ee', approverAddress: human.address,
    publicBaseUrl: 'http://x',
    signer: { sign: async (id: string) => { signed.push(id); return { txHashes: ['0xhash'] }; } },
  };
}

test('small clean order executes without approval', async () => {
  const signed: string[] = []; const d = deps(signed);
  const v = await proposeOrder(d, [{ itemId: 1, quantity: 1 }]);
  assert.deepEqual([v.status, v.requiresApproval], ['proposed', false]);
  assert.equal((await execute(d, v.proposalId)).status, 'executed');
  assert.deepEqual(signed, [v.proposalId]);
});

test('flagged stall is dropped; its tx is never composed', async () => {
  const d = deps();
  const v = await proposeOrder(d, [{ itemId: 5, quantity: 2 }, { itemId: 1, quantity: 1 }]);
  const row = d.store.getProposal(v.proposalId)!;
  assert.equal(row.txs.length, 1);
  assert.equal(v.totalYen, 600);
});

test('big order waits for a valid human approval bound to its hash', async () => {
  const d = deps();
  const v = await proposeOrder(d, [{ itemId: 1, quantity: 2 }]);
  assert.equal(v.status, 'awaiting_approval');
  assert.equal((await execute(d, v.proposalId)).status, 'awaiting_approval');
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const bad = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES, { proposalHash: '0x' + '00'.repeat(32), totalYen: 1200, expiresAt });
  assert.equal(recordApproval(d, v.proposalId, { signature: bad, totalYen: 1200, expiresAt }).ok, false);
  const good = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES, { proposalHash: v.hash, totalYen: 1200, expiresAt });
  assert.equal(recordApproval(d, v.proposalId, { signature: good, totalYen: 1200, expiresAt }).ok, true);
  assert.equal((await execute(d, v.proposalId)).status, 'executed');
});

test('all-refused order is refused and cannot execute', async () => {
  const d = deps();
  const v = await proposeOrder(d, [{ itemId: 5, quantity: 1 }]);
  assert.equal(v.status, 'refused');
  assert.equal((await execute(d, v.proposalId)).status, 'refused');
});

test('transfer to a flagged friend agent is held', async () => {
  const d = deps();
  const v = await proposeTransfer(d, { to: stalls[1].payTo, amountYen: 700, memo: 'Ken drinks' });
  assert.equal(v.status, 'held');
});
