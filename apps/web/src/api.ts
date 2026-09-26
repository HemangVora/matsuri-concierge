export async function sendChat(sessionId: string, text: string) {
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text }) });
  return r.json() as Promise<{ reply: string; toolCalls: { name: string; input: unknown; output: any }[] }>;
}
export type FeedEvent = { id: number; at: string; type: string; data: any };
export function subscribe(onEvent: (e: FeedEvent) => void) {
  const es = new EventSource('/api/events');
  for (const t of ['proposal', 'screening', 'approval', 'executed', 'signer_refused', 'bill', 'kanjo_paid', 'kanjo_held', 'tool_call'])
    es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}
export const getProposal = (id: string) => fetch(`/api/proposals/${id}`).then((r) => r.json());
export const approve = (id: string, body: { signature: string; totalYen: number; expiresAt: number }) =>
  fetch(`/api/proposals/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
export const getLedger = () => fetch('/api/ledger').then((r) => r.json());
export const friendPay = (name: string, payUrl: string) =>
  fetch(`/friends/${name}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payUrl }) }).then((r) => r.json());
