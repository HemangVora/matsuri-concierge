import { useState } from 'react';
import { friendPay, sendChat, type FeedEvent } from './api.ts';

const sessionId = crypto.randomUUID();
type Msg = { who: 'you' | 'agent'; text: string; error?: boolean };

const EXAMPLES = [
  '4 of us, ¥3,000, dinner please',
  'Split it: I paid 2600, Ken paid 1800 — You, Aoi, Mei, Ken',
];

export default function Chat({ events }: { events: FeedEvent[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [payResults, setPayResults] = useState<Record<string, string>>({});
  const bills = events.filter((e) => e.type === 'bill').map((e) => e.data);

  async function send(t: string) {
    if (!t.trim()) return;
    setMsgs((m) => [...m, { who: 'you', text: t }]); setText(''); setBusy(true);
    try {
      const r = await sendChat(sessionId, t);
      setMsgs((m) => [...m, { who: 'agent', text: r.reply }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { who: 'agent', text: `Couldn't reach the concierge: ${e?.message ?? 'unknown error'}`, error: true }]);
    } finally {
      setBusy(false);
    }
  }
  function listen() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR(); rec.lang = navigator.language.startsWith('ja') ? 'ja-JP' : 'en-US';
    rec.onresult = (e: any) => send(e.results[0][0].transcript);
    rec.start();
  }
  async function pay(key: string, name: string, payUrl: string) {
    setPayResults((m) => ({ ...m, [key]: 'Paying…' }));
    try {
      const r = await friendPay(name, payUrl);
      if (r.status === 200) setPayResults((m) => ({ ...m, [key]: `${name} paid ✓` }));
      else {
        const reason = r.body?.error ?? (r.body?.held ? `held: ${r.body.reasons?.join('; ')}` : `failed (status ${r.status})`);
        setPayResults((m) => ({ ...m, [key]: reason }));
      }
    } catch (e: any) {
      setPayResults((m) => ({ ...m, [key]: e?.message ?? 'Payment failed' }));
    }
  }
  return (
    <section className="panel chat">
      <h2>Concierge</h2>
      <div className="msgs">
        {msgs.length === 0 ? (
          <div className="empty-hint">
            <p>Try one of these:</p>
            <div className="chips">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="chip" onClick={() => void send(ex)}>{ex}</button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {msgs.map((m, i) => <p key={i} className={`${m.who}${m.error ? ' error' : ''}`}>{m.text}</p>)}
            {busy && <p className="agent">…</p>}
          </>
        )}
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="4 of us, ¥3,000, dinner please"
          aria-label="Message to the concierge"
        />
        <button type="button" onClick={listen} title="Speak" aria-label="Speak">🎤</button>
        <button disabled={busy}>Send</button>
      </form>
      {bills.map((b: any) => b.requests.map((r: any) => {
        const key = b.billId + r.from;
        return (
          <div key={key} className="friend-row">
            <button className="friend" onClick={() => void pay(key, r.from, r.payUrl)} disabled={payResults[key] === 'Paying…'}>
              📱 {r.from}'s agent pays ¥{r.amountYen}
            </button>
            {payResults[key] && <span className="friend-result">{payResults[key]}</span>}
          </div>
        );
      }))}
    </section>
  );
}
