export interface BusEvent { id: number; at: string; type: string; data: unknown; }
const listeners = new Set<(e: BusEvent) => void>();
const history: BusEvent[] = [];
let seq = 0;
export const bus = {
  emit(type: string, data: unknown) {
    const e = { id: ++seq, at: new Date().toISOString(), type, data };
    history.push(e); if (history.length > 500) history.shift();
    for (const l of listeners) l(e);
  },
  subscribe(fn: (e: BusEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
  recent(n = 100) { return history.slice(-n); },
};
