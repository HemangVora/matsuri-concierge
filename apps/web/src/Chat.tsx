import { useState } from 'react';
import { friendPay, sendChat, type FeedEvent } from './api.ts';

const sessionId = crypto.randomUUID();
type Msg = { who: 'you' | 'agent'; text: string };

export default function Chat({ events }: { events: FeedEvent[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bills = events.filter((e) => e.type === 'bill').map((e) => e.data);

  async function send(t: string) {
    if (!t.trim()) return;
    setMsgs((m) => [...m, { who: 'you', text: t }]); setText(''); setBusy(true);
    try { const r = await sendChat(sessionId, t); setMsgs((m) => [...m, { who: 'agent', text: r.reply }]); }
    finally { setBusy(false); }
  }
  function listen() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR(); rec.lang = navigator.language.startsWith('ja') ? 'ja-JP' : 'en-US';
    rec.onresult = (e: any) => send(e.results[0][0].transcript);
    rec.start();
  }
  return (
    <section className="panel chat">
      <h2>Concierge</h2>
      <div className="msgs">{msgs.map((m, i) => <p key={i} className={m.who}>{m.text}</p>)}{busy && <p className="agent">…</p>}</div>
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="4 of us, ¥3,000, dinner please" />
        <button type="button" onClick={listen} title="Speak">🎤</button>
        <button disabled={busy}>Send</button>
      </form>
      {bills.map((b: any) => b.requests.map((r: any) => (
        <button key={b.billId + r.from} className="friend" onClick={() => friendPay(r.from, r.payUrl)}>
          📱 {r.from}'s agent pays ¥{r.amountYen}
        </button>
      )))}
    </section>
  );
}
