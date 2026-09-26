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

// A hung RPC call (estimateGas, wait(...)) would otherwise block the /sign mutex forever, wedging
// every later request behind it. This forces a rejection after `ms`, so the caller always fails
// closed and the mutex is released, instead of a single stuck call taking the whole signer down.
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    let sent;
    try {
      sent = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
    } catch (e) {
      throw new PartialSendError((e as Error).message, hashes);
    }
    // Record the hash as soon as it exists, before awaiting the mining wait: a tx that gets mined
    // but reverts (or is dropped/replaced) throws out of wait(1), and that hash must still be
    // reported to the caller — it landed on-chain and cannot be undone, so losing track of it here
    // would make PartialSendError under-report what was actually sent.
    hashes.push(sent.hash);
    try {
      await withTimeout(sent.wait(1), 60_000, 'Transaction wait timed out');
    } catch (e) {
      throw new PartialSendError((e as Error).message, hashes);
    }
  }
  return hashes;
}
