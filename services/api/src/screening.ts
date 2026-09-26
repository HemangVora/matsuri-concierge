import { quickScan, type Screening } from '@mc/core';
import type { Store } from './store.ts';
import { bus } from './events.ts';

export function createScreener(store: Store, apiKey: string) {
  return async (address: string): Promise<Screening> => {
    const cached = store.getScreening(address, 10 * 60_000);
    if (cached) return cached;
    const s = await quickScan(address, { apiKey });
    if (s.ok) store.cacheScreening(s);
    bus.emit('screening', { address, ok: s.ok, toxicScore: s.result?.toxicScore ?? null,
      traits: s.result?.traits.map((t) => t.description || t.name) ?? [], error: s.error });
    return s;
  };
}
export type Screener = ReturnType<typeof createScreener>;
