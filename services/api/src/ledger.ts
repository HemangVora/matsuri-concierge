import type { Mb } from './multibaas.ts';
import type { Store } from './store.ts';
import type { Screener } from './screening.ts';

export async function ledger(mb: Mb, store: Store) {
  const [purchases, settlements] = await Promise.all([mb.purchases(), mb.settlements()]);
  const decisions = store.listProposals(30).map((p) => ({ id: p.id, kind: p.kind, status: p.status,
    totalYen: p.totalYen, decision: p.decision, txHashes: p.txHashes, at: p.createdAt }));
  return { purchases, settlements, decisions, spentTodayYen: store.spentTodayYen() };
}

export async function rescreen(mb: Mb, store: Store, fresh: (address: string) => Promise<ReturnType<Screener> extends Promise<infer S> ? S : never>) {
  const paid = [...new Set((await mb.purchases()).map((p) => p.stall.toLowerCase()))];
  return Promise.all(paid.map(async (address) => {
    const before = store.getScreening(address, Number.MAX_SAFE_INTEGER);
    const after = await fresh(address);
    if (after.ok) store.cacheScreening(after);
    return { address, before: before?.result?.toxicScore ?? null, after: after.result?.toxicScore ?? null,
      changed: (before?.result?.toxicScore ?? null) !== (after.result?.toxicScore ?? null),
      traits: after.result?.traits.map((t) => t.description || t.name) ?? [] };
  }));
}
