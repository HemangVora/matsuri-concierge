import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { APPROVAL_TYPES, approvalDomain, verifyApproval } from '../src/approval.ts';

const human = Wallet.createRandom();
const chainId = 11155111;
const hashA = '0x' + 'aa'.repeat(32);
const hashB = '0x' + 'bb'.repeat(32);
const now = 1_800_000_000;

async function sign(proposalHash: string, totalYen: number, expiresAt: number) {
  return human.signTypedData(approvalDomain(chainId), APPROVAL_TYPES, { proposalHash, totalYen, expiresAt });
}

test('accepts the human approval for the exact proposal', async () => {
  const signature = await sign(hashA, 2400, now + 600);
  assert.deepEqual(
    verifyApproval({ chainId, proposalHash: hashA, totalYen: 2400, expiresAt: now + 600, signature, approver: human.address, now }),
    { ok: true }
  );
});

test('verifyApproval rejects approval for another hash', async () => {
  const signature = await sign(hashA, 2400, now + 600);
  const r = verifyApproval({ chainId, proposalHash: hashB, totalYen: 2400, expiresAt: now + 600, signature, approver: human.address, now });
  assert.equal(r.ok, false);
});

test('rejects a changed total, an expired approval, and a different signer', async () => {
  const signature = await sign(hashA, 2400, now + 600);
  assert.equal(verifyApproval({ chainId, proposalHash: hashA, totalYen: 9999, expiresAt: now + 600, signature, approver: human.address, now }).ok, false);
  const old = await sign(hashA, 2400, now - 1);
  assert.equal(verifyApproval({ chainId, proposalHash: hashA, totalYen: 2400, expiresAt: now - 1, signature: old, approver: human.address, now }).reason, 'Approval expired');
  assert.equal(verifyApproval({ chainId, proposalHash: hashA, totalYen: 2400, expiresAt: now + 600, signature, approver: Wallet.createRandom().address, now }).ok, false);
});

test('garbage signature is a rejection, not a throw', () => {
  const r = verifyApproval({ chainId, proposalHash: hashA, totalYen: 1, expiresAt: now + 1, signature: '0xdead', approver: human.address, now });
  assert.equal(r.ok, false);
});
