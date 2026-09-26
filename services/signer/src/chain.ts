import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { voucherIface, weiToYen, type UnsignedTx } from '@mc/core';
import { env } from './env.ts';

export const provider = new JsonRpcProvider(env.rpcUrl, env.deployments.chainId);
export const wallet = new Wallet(env.agentKey, provider);
const voucher = new Contract(env.deployments.voucher, voucherIface, provider);

export async function readItem(itemId: number) {
  const [price, available, payTo] = await voucher.eventInfo(itemId);
  return { priceYen: weiToYen(price), available: Number(available), payTo: String(payTo) };
}

// Thrown by sendAll when a tx fails partway through a multi-tx proposal. txHashes carries whatever
// already landed on-chain so the caller can surface it — those sends happened and cannot be undone.
export class PartialSendError extends Error {
  txHashes: string[];
  constructor(message: string, txHashes: string[]) {
    super(message);
    this.name = 'PartialSendError';
    this.txHashes = txHashes;
  }
}

// Dry-run every tx before any of them are sent, so a proposal that would revert never gets us
// partway through a multi-tx order. Returns the first failure's reason, if any.
export async function preflight(txs: UnsignedTx[]): Promise<{ ok: true } | { ok: false; error: string }> {
  for (const t of txs) {
    try {
      await provider.estimateGas({ from: wallet.address, to: t.to, data: t.data, value: BigInt(t.value) });
    } catch (e) {
      const reason = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
      return { ok: false, error: `Transaction would revert: ${reason}` };
    }
  }
  return { ok: true };
}

export async function sendAll(txs: UnsignedTx[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const t of txs) {
    try {
      const sent = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
      await sent.wait(1);
      hashes.push(sent.hash);
    } catch (e) {
      throw new PartialSendError((e as Error).message, hashes);
    }
  }
  return hashes;
}
