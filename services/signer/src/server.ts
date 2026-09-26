import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { quickScan, type ProposalForSigner } from '@mc/core';
import { env } from './env.ts';
import { readItem, sendAll, wallet } from './chain.ts';
import { verifyForSigning } from './verify.ts';

const app = new Hono();
const inFlight = new Set<string>();

app.post('/sign', async (c) => {
  const { proposalId } = await c.req.json<{ proposalId: string }>();
  if (inFlight.has(proposalId)) return c.json({ error: 'Already signing' }, 409);
  inFlight.add(proposalId);
  try {
    const res = await fetch(`${env.apiUrl}/internal/proposals/${proposalId}`);
    if (!res.ok) return c.json({ error: 'Unknown proposal' }, 404);
    const { proposal, spentTodayYen } = (await res.json()) as { proposal: ProposalForSigner; spentTodayYen: number };
    const verdict = await verifyForSigning(proposal, {
      deployments: env.deployments, policy: env.policy, approver: env.approver, agentAddress: wallet.address,
      spentTodayYen, readItem, screen: (a) => quickScan(a, { apiKey: env.interceptaKey }),
    });
    if (!verdict.ok) {
      console.log(`[signer] REFUSED ${proposalId}: ${verdict.reason}`);
      return c.json({ error: verdict.reason }, 422);
    }
    const txHashes = await sendAll(proposal.txs);
    console.log(`[signer] signed ${proposalId}: ${txHashes.join(', ')}`);
    return c.json({ txHashes });
  } finally {
    inFlight.delete(proposalId);
  }
});

serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' });
console.log(`signer for ${wallet.address} on 127.0.0.1:${env.port}`);
