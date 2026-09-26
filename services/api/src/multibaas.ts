import * as MB from '@curvegrid/multibaas-sdk';
import { weiToYen, yenToWei, type Stall, type StallMeta, type UnsignedTx } from '@mc/core';
import stallsMeta from '../../../config/stalls.json' with { type: 'json' };

const ALIAS = { coin: 'mc_stablecoin', voucher: 'mc_voucher', settlement: 'mc_settlement' } as const;

export function createMb(baseUrl: string, apiKey: string) {
  const config = new MB.Configuration({ basePath: new URL('/api/v0', baseUrl).toString(), accessToken: apiKey });
  const contracts = new MB.ContractsApi(config);
  const queries = new MB.EventQueriesApi(config);

  async function call(alias: string, method: string, args: unknown[], from?: string) {
    const resp = await contracts.callContractFunction(alias, alias, method, {
      args, from, contractOverride: true, formatInts: 'as_strings',
    } as MB.PostMethodArgs);
    return resp.data.result as MB.CallContractFunction200ResponseAllOfResult & { output?: unknown; tx?: MB.TransactionToSignTx };
  }
  async function compose(alias: string, method: string, args: unknown[], from: string): Promise<UnsignedTx> {
    const r = await call(alias, method, args, from);
    if (!r?.tx?.to || !r.tx.data) throw new Error(`MultiBaas did not return a transaction for ${method}`);
    return { to: r.tx.to, data: r.tx.data, value: r.tx.value ?? '0' };
  }

  return {
    async readStalls(): Promise<Stall[]> {
      return Promise.all((stallsMeta as StallMeta[]).map(async (m) => {
        const r = await call(ALIAS.voucher, 'eventInfo', [m.itemId]);
        const [price, available, payTo] = r.output as [string, string, string];
        return { itemId: m.itemId, name: m.name, item: m.item, emoji: m.emoji,
          priceYen: weiToYen(BigInt(price)), available: Number(available), payTo };
      }));
    },
    composeBuy: (itemId: number, qty: number, from: string) => compose(ALIAS.voucher, 'buyVoucher', [itemId, qty], from),
    composeTransfer: (to: string, amountYen: number, from: string) =>
      compose(ALIAS.coin, 'transfer', [to, yenToWei(amountYen).toString()], from),
    composeSettle: (a: { billId: string; from: string; to: string; amountYen: number; deadline: number; signature: string }, sender: string) =>
      compose(ALIAS.settlement, 'settle', [a.billId, a.from, a.to, yenToWei(a.amountYen).toString(), a.deadline, a.signature], sender),

    async purchases(limit = 50) {
      const q: MB.EventQuery = {
        events: [{
          eventName: 'VoucherPurchased(address,uint256,uint256,address,uint256)',
          select: [
            { type: 'input', inputIndex: 0, alias: 'buyer' }, { type: 'input', inputIndex: 1, alias: 'itemId' },
            { type: 'input', inputIndex: 2, alias: 'quantity' }, { type: 'input', inputIndex: 3, alias: 'stall' },
            { type: 'input', inputIndex: 4, alias: 'amount' }, { type: 'tx_hash', alias: 'txhash' },
            { type: 'triggered_at', alias: 'at' },
          ],
          filter: { fieldType: 'contract_address_alias', operator: 'equal', value: ALIAS.voucher },
        }],
        orderBy: 'at', order: 'DESC',
      } as MB.EventQuery;
      const rows = ((await queries.executeArbitraryEventQuery(q, 0, limit)).data.result?.rows ?? []) as any[];
      return rows.map((r) => ({ buyer: r.buyer, itemId: Number(r.itemid ?? r.itemId), quantity: Number(r.quantity),
        stall: r.stall, amountYen: weiToYen(BigInt(r.amount)), txHash: r.txhash, at: r.at }));
    },
    async settlements(limit = 50) {
      const q: MB.EventQuery = {
        events: [{
          eventName: 'ShareSettled(bytes32,address,address,uint256)',
          select: [
            { type: 'input', inputIndex: 0, alias: 'billId' }, { type: 'input', inputIndex: 1, alias: 'from' },
            { type: 'input', inputIndex: 2, alias: 'to' }, { type: 'input', inputIndex: 3, alias: 'amount' },
            { type: 'tx_hash', alias: 'txhash' }, { type: 'triggered_at', alias: 'at' },
          ],
          filter: { fieldType: 'contract_address_alias', operator: 'equal', value: ALIAS.settlement },
        }],
        orderBy: 'at', order: 'DESC',
      } as MB.EventQuery;
      const rows = ((await queries.executeArbitraryEventQuery(q, 0, limit)).data.result?.rows ?? []) as any[];
      return rows.map((r) => ({ billId: r.billid ?? r.billId, from: r.from, to: r.to,
        amountYen: weiToYen(BigInt(r.amount)), txHash: r.txhash, at: r.at }));
    },
  };
}
export type Mb = ReturnType<typeof createMb>;
