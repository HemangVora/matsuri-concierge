import { useEffect, useState } from 'react';
import { getLedger, type FeedEvent } from './api.ts';

export default function Ledger({ events }: { events: FeedEvent[] }) {
  const [l, setL] = useState<any>(null);
  const [failed, setFailed] = useState(false);
  const executedCount = events.filter((e) => e.type === 'executed').length;
  useEffect(() => {
    let cancelled = false;
    getLedger()
      .then((data) => { if (!cancelled) { setL(data); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [executedCount]);
  if (failed) return <section className="panel ledger"><p className="muted">Ledger unavailable (api offline)</p></section>;
  if (!l) return null;
  return (
    <section className="panel ledger">
      <h2>Ledger (MultiBaas event queries) · spent today ¥{l.spentTodayYen}</h2>
      <table><tbody>
        {l.purchases.map((p: any) => <tr key={p.txHash}><td>🧾</td><td>item {p.itemId} ×{p.quantity}</td><td>¥{p.amountYen}</td><td>{p.stall.slice(0, 8)}…</td></tr>)}
        {l.settlements.map((s: any) => <tr key={s.txHash}><td>🤝</td><td>{s.from.slice(0, 8)}… → you</td><td>¥{s.amountYen}</td><td>{s.billId.slice(0, 8)}…</td></tr>)}
      </tbody></table>
    </section>
  );
}
