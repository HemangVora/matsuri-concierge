import { AbiCoder, getAddress, keccak256 } from 'ethers';
import type { UnsignedTx } from './types.ts';

// Nonce and gas are deliberately excluded: the signer sets them; what the human approves is to/data/value.
export function hashProposal(chainId: number, txs: UnsignedTx[]): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'tuple(address to, bytes data, uint256 value)[]'],
      [chainId, txs.map((t) => ({ to: getAddress(t.to), data: t.data, value: BigInt(t.value) }))]
    )
  );
}
