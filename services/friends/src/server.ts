import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Wallet } from 'ethers';
import type { Deployments } from '@mc/core';
import deploymentsJson from '../../../deployments.json' with { type: 'json' };
import { payFriendPayUrl } from './pay.ts';

const deployments = deploymentsJson as Deployments;
const organizer = process.env.ORGANIZER_ADDRESS;
if (!organizer) throw new Error('ORGANIZER_ADDRESS must be set — it pins the only address a friend agent will ever pay');

const friends: Record<string, Wallet> = {
  Aoi: new Wallet(process.env.AOI_PRIVATE_KEY!),
  Mei: new Wallet(process.env.MEI_PRIVATE_KEY!),
};
const app = new Hono();

// A friend's agent: fetch the 402, check it is within its own limit, sign the share, retry with X-PAYMENT.
// The actual flow (origin/redirect checks, terms validation, signing) lives in pay.ts so it can be
// exercised directly in tests without a running Hono server.
app.post('/friends/:name/pay', async (c) => {
  const wallet = friends[c.req.param('name')];
  if (!wallet) return c.json({ error: 'unknown friend' }, 404);

  const body = (await c.req.json().catch(() => null)) as { payUrl?: unknown } | null;
  const payUrl = body?.payUrl;
  if (typeof payUrl !== 'string') return c.json({ error: 'payUrl must be a string' }, 400);

  const result = await payFriendPayUrl({ wallet, payUrl, deployments, organizer });
  return c.json({ status: result.status, body: result.body });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8790) });
console.log('friend agents Aoi, Mei on :8790');
