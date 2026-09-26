import { getAddress, verifyTypedData } from 'ethers';

export const APPROVAL_TYPES = {
  Approval: [
    { name: 'proposalHash', type: 'bytes32' },
    { name: 'totalYen', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};
export const approvalDomain = (chainId: number) => ({ name: 'Matsuri Concierge', version: '1', chainId });

export function verifyApproval(a: {
  chainId: number; proposalHash: string; totalYen: number; expiresAt: number;
  signature: string; approver: string; now?: number;
}): { ok: boolean; reason?: string } {
  const now = a.now ?? Math.floor(Date.now() / 1000);
  if (a.expiresAt <= now) return { ok: false, reason: 'Approval expired' };
  let recovered: string;
  try {
    recovered = verifyTypedData(approvalDomain(a.chainId), APPROVAL_TYPES,
      { proposalHash: a.proposalHash, totalYen: a.totalYen, expiresAt: a.expiresAt }, a.signature);
  } catch {
    return { ok: false, reason: 'Unreadable approval signature' };
  }
  if (getAddress(recovered) !== getAddress(a.approver)) return { ok: false, reason: 'Approval not signed by the approver wallet' };
  return { ok: true };
}
