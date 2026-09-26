import type { FeedEvent } from './api.ts';

const color: Record<string, string> = { PAY: 'pay', CAP: 'cap', ASK: 'ask', REFUSE: 'refuse' };

// A decision line is either an order's per-stall LineDecision (stallName/qty/subtotalYen) or a
// transfer's TransferDecision (to/amountYen, no stallName or qty) — `(d.decision.lines ?? [d.decision])`
// normalizes both into one array so this renders either kind; the label falls back from stallName to
// a shortened `to` address, and qty/reasons are simply omitted when the line doesn't have them.
export default function DecisionFeed({ events }: { events: FeedEvent[] }) {
  return (
    <section className="panel feed">
      <h2>The missing layer</h2>
      {[...events].reverse().map((e) => {
        const d = e.data;
        if (e.type === 'screening') return <div key={e.id} className="row">🔎 Intercepta {short(d.address)} → score {d.toxicScore ?? 'n/a'} {d.traits.join(', ')} {d.error ?? ''}</div>;
        if (e.type === 'proposal') return (
          <div key={e.id} className="card">
            <strong>{d.kind === 'order' ? '🧾 Order' : '💸 Transfer'} · ¥{d.totalYen} · {d.status}</strong>
            {(d.decision.lines ?? [d.decision]).map((l: any, i: number) => (
              <div key={i} className={`verdict ${color[l.action]}`}>{l.action} {l.stallName ?? short(l.to)} {l.qty !== undefined ? `×${l.qty}` : ''} {l.reasons?.join('; ')}</div>
            ))}
            {d.approvalUrl && <a className="approve" href={d.approvalUrl} target="_blank">✋ Approve on your phone</a>}
          </div>
        );
        if (e.type === 'executed') return <div key={e.id} className="row ok">✅ Signed by the signer: {d.txHashes.map((h: string) => <a key={h} href={`https://sepolia.etherscan.io/tx/${h}`} target="_blank">{short(h)} </a>)}</div>;
        if (e.type === 'signer_refused') return <div key={e.id} className="row bad">⛔ Signer refused: {d.reason}</div>;
        if (e.type === 'kanjo_paid') return <div key={e.id} className="row ok">🤝 {d.from} paid ¥{d.amountYen}</div>;
        if (e.type === 'kanjo_held') return <div key={e.id} className="row bad">⏸ {d.from}'s payment held: {d.reasons.join('; ')}</div>;
        return null;
      })}
    </section>
  );
}
const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '');
