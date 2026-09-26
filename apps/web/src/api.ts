// Reads a fetch Response as JSON, throwing a readable Error when the response isn't ok. The api's
// error bodies use either `{ error }` (e.g. 404s, friends validation) or `{ ok: false, reason }`
// (e.g. proposal approval rejections) — both are checked so the thrown message stays informative
// instead of collapsing to a bare status code. A non-JSON error body (e.g. the dev proxy's plain-text
// 502 page when a backend service isn't running) falls back to the status text.
async function asJson<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let message = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (typeof body?.error === 'string') message = body.error;
      else if (typeof body?.reason === 'string') message = body.reason;
    } catch {
      // non-JSON error body; keep the status-text fallback
    }
    throw new Error(message);
  }
  return r.json() as Promise<T>;
}

export async function sendChat(sessionId: string, text: string) {
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text }) });
  return asJson<{ reply: string; toolCalls: { name: string; input: unknown; output: any }[] }>(r);
}
export type FeedEvent = { id: number; at: string; type: string; data: any };
export function subscribe(onEvent: (e: FeedEvent) => void) {
  const es = new EventSource('/api/events');
  for (const t of ['proposal', 'screening', 'approval', 'executed', 'signer_refused', 'bill', 'kanjo_paid', 'kanjo_held', 'tool_call'])
    es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}
export const getProposal = (id: string) => fetch(`/api/proposals/${id}`).then((r) => asJson<any>(r));
export const approve = (id: string, body: { signature: string; totalYen: number; expiresAt: number }) =>
  fetch(`/api/proposals/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => asJson<any>(r));
export const getLedger = () => fetch('/api/ledger').then((r) => asJson<any>(r));
export const friendPay = (name: string, payUrl: string) =>
  fetch(`/friends/${name}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payUrl }) }).then((r) => asJson<{ status: number; body: any }>(r));
