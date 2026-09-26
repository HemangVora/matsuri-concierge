import { useEffect, useState } from 'react';
import { subscribe, type FeedEvent } from './api.ts';
import Chat from './Chat.tsx';
import DecisionFeed from './DecisionFeed.tsx';
import Ledger from './Ledger.tsx';

export default function App() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => subscribe((e) => setEvents((xs) => (xs.some((x) => x.id === e.id) ? xs : [...xs, e]))), []);
  return (
    <div className="layout">
      <header><h1>🏮 Matsuri Concierge</h1><p>AI creates intent. The missing layer decides whether money moves.</p></header>
      <main>
        <Chat events={events} />
        <DecisionFeed events={events} />
      </main>
      <Ledger events={events} />
    </div>
  );
}
