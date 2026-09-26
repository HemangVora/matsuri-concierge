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

export async function sendAll(txs: UnsignedTx[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const t of txs) {
    const sent = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
    await sent.wait(1);
    hashes.push(sent.hash);
  }
  return hashes;
}
