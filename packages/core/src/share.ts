import { verifyTypedData } from 'ethers';

export const SHARE_TYPES = {
  Share: [
    { name: 'billId', type: 'bytes32' },
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
export const shareDomain = (chainId: number, verifyingContract: string) =>
  ({ name: 'KanjoSettlement', version: '1', chainId, verifyingContract });

export interface ShareMessage { billId: string; from: string; to: string; amount: bigint; deadline: bigint; }

export function recoverShareSigner(chainId: number, settlement: string, share: ShareMessage, signature: string): string {
  return verifyTypedData(shareDomain(chainId, settlement), SHARE_TYPES, share, signature);
}
