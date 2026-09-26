import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Wallet } from 'ethers';
import { SHARE_TYPES, shareDomain, type Deployments } from '@mc/core';
import deploymentsJson from '../../../deployments.json' with { type: 'json' };
import { ALLOWED_PAY_ORIGINS, validateAccepts, validatePayUrl } from './validate.ts';

const deployments = deploymentsJson as Deployments;

const friends: Record<string, Wallet> = {
  Aoi: new Wallet(process.env.AOI_PRIVATE_KEY!),
  Mei: new Wallet(process.env.MEI_PRIVATE_KEY!),
};
const app = new Hono();

// A friend's agent: fetch the 402, check it is within its own limit, sign the share, retry with X-PAYMENT.
app.post('/friends/:name/pay', async (c) => {
  const wallet = friends[c.req.param('name')];
  if (!wallet) return c.json({ error: 'unknown friend' }, 404);

  const body = (await c.req.json().catch(() => null)) as { payUrl?: unknown } | null;
  const payUrl = body?.payUrl;

  // Never fetch a payUrl the agent didn't expect: this is real money moving out of a real wallet, so
  // the source of the 402 must be the api it knows about, not wherever a caller points it.
  const originError = validatePayUrl(payUrl, ALLOWED_PAY_ORIGINS);
  if (originError) return c.json({ error: originError }, 400);

  const first = await fetch(payUrl as string);
  if (first.status !== 402) return c.json({ error: `expected 402, got ${first.status}` }, 400);

  const payload = await first.json().catch(() => null);
  const validated = validateAccepts(payload, deployments);
  if (!validated.ok) return c.json({ error: validated.reason }, 400);
  const a = validated.accept;

  const share = { billId: a.billId, from: wallet.address, to: a.to, amount: BigInt(a.amount), deadline: BigInt(a.deadline) };
  const signature = await wallet.signTypedData(shareDomain(a.chainId, a.settlement), SHARE_TYPES, share);
  const header = Buffer.from(JSON.stringify({ from: wallet.address, signature })).toString('base64');
  const second = await fetch(payUrl as string, { headers: { 'X-PAYMENT': header } });
  return c.json({ status: second.status, body: await second.json() });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8790) });
console.log('friend agents Aoi, Mei on :8790');
