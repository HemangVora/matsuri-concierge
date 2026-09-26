import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { APPROVAL_TYPES, approvalDomain, type PolicyConfig } from '@mc/core';
import { env } from './env.ts';
import { openStore } from './store.ts';
import { createMb } from './multibaas.ts';
import { createScreener } from './screening.ts';
import { createSignerClient } from './signerClient.ts';
import { execute, recordApproval } from './proposals.ts';
import { acceptPayment, paymentRequired } from './kanjo.ts';
import { ledger } from './ledger.ts';
import { chat } from './agent.ts';
import { bus } from './events.ts';
import { validateChatBody } from './validateChat.ts';

const policy = JSON.parse(readFileSync(new URL('../../../config/policy.json', import.meta.url), 'utf8')) as PolicyConfig;
const store = openStore(new URL('../data.sqlite', import.meta.url).pathname);
const mb = createMb(env.mbBaseUrl, env.mbApiKey);
const deps = {
  mb, mbFull: mb, screen: createScreener(store, env.interceptaKey), store, policy, chainId: env.chainId,
  agentAddress: env.agentAddress, approverAddress: env.approverAddress, publicBaseUrl: env.publicBaseUrl,
  approvalBaseUrl: env.approvalBaseUrl, signer: createSignerClient(env.signerUrl), deployments: env.deployments,
  interceptaKey: env.interceptaKey,
  friends: { Aoi: process.env.AOI_ADDRESS ?? '', Mei: process.env.MEI_ADDRESS ?? '', Ken: process.env.KEN_PAYTO ?? '' },
};

// Loopback-only guard for the internal proposal endpoint the separate signer reads. This route
// exposes unsigned transactions and approval signatures for a proposal id it already knows about;
// it must never be reachable from outside this host.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLoopback(c: Parameters<typeof getConnInfo>[0]): boolean {
  try {
    return LOOPBACK.has(getConnInfo(c).remote.address ?? '');
  } catch {
    return false;
  }
}

const app = new Hono();
app.post('/api/chat', async (c) => {
  const body = await c.req.json().catch(() => null);
  const v = validateChatBody(body);
  if (!v.ok) return c.json({ error: v.error }, 400);
  return c.json(await chat(v.body.sessionId, v.body.text, deps, env.anthropicModel, env.agentEffort));
});
app.get('/api/events', (c) => streamSSE(c, async (stream) => {
  for (const e of bus.recent()) await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
  const off = bus.subscribe((e) => { void stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) }); });
  stream.onAbort(() => { off(); });
  while (!stream.aborted) await stream.sleep(15_000);
}));
app.get('/api/stalls', async (c) => c.json(await mb.readStalls()));
app.get('/api/ledger', async (c) => c.json(await ledger(mb, store)));
app.get('/api/proposals/:id', (c) => {
  const p = store.getProposal(c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ ...p, approver: env.approverAddress,
    typedData: { domain: approvalDomain(env.chainId), types: APPROVAL_TYPES, primaryType: 'Approval' } });
});
app.post('/api/proposals/:id/approve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ signature: string; totalYen: number; expiresAt: number }>().catch(() => null);
  if (!body) return c.json({ ok: false, reason: 'Malformed JSON body' }, 400);
  // The signer refuses an approval whose totalYen/expiresAt aren't JSON numbers (it will not coerce
  // a string). Reject the same malformed shapes here, before touching the store, so the failure is
  // reported at the api boundary rather than surfacing later as an opaque signer refusal.
  if (!Number.isInteger(body.totalYen) || !Number.isInteger(body.expiresAt)) {
    return c.json({ ok: false, reason: 'totalYen and expiresAt must be integers' }, 400);
  }
  const r = recordApproval(deps, id, body);
  if (!r.ok) return c.json(r, 400);
  return c.json({ ok: true, execution: await execute(deps, id) });
});
app.get('/internal/proposals/:id', (c) => {
  if (!isLoopback(c)) return c.json({ error: 'Forbidden' }, 403);
  const p = store.getProposal(c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ proposal: { id: p.id, kind: p.kind, chainId: env.chainId, txs: p.txs, approval: p.approval },
    spentTodayYen: store.spentTodayYen() });
});
app.get('/kanjo/bills/:billId/pay', async (c) => {
  const billId = c.req.param('billId'); const from = c.req.query('from') ?? '';
  const header = c.req.header('X-PAYMENT');
  if (!header) {
    const req = paymentRequired(deps, billId, from);
    return req ? c.json(req, 402) : c.json({ error: 'not found' }, 404);
  }
  const r = await acceptPayment(deps, billId, from, header);
  return c.json(r.body, r.status as 200);
});

// Loopback-only: the api exposes unsigned proposals, approval flows and the internal signer
// endpoint. Binding to every interface would put all of that on the LAN with no additional auth.
// A phone approving from off-host needs a LAN/tunnel forward to this port — see the README.
serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' });
console.log(`api on 127.0.0.1:${env.port} (agent wallet ${env.agentAddress}, no keys here)`);
