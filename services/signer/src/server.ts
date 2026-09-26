import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { quickScan, type ProposalForSigner } from '@mc/core';
import { env } from './env.ts';
import { readItem, sendAll, preflight, wallet, PartialSendError } from './chain.ts';
import { verifyForSigning } from './verify.ts';
import { openState } from './state.ts';

const app = new Hono();
const inFlight = new Set<string>();
const state = openState(env.statePath);
const PROPOSAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

app.post('/sign', async (c) => {
  const body = await c.req.json().catch(() => null);
  const proposalId = (body as { proposalId?: unknown } | null)?.proposalId;
  if (typeof proposalId !== 'string') return c.json({ error: 'proposalId must be a string' }, 400);
  if (!PROPOSAL_ID_RE.test(proposalId)) return c.json({ error: 'Invalid proposalId' }, 400);

  if (inFlight.has(proposalId)) return c.json({ error: 'Already signing' }, 409);
  inFlight.add(proposalId);
  try {
    // Cheap, local rejection before touching the network: a consumed proposal is never re-signed,
    // no matter what the api says about it now.
    if (state.isConsumed(proposalId)) return c.json({ error: 'Proposal already executed' }, 422);

    const res = await fetch(`${env.apiUrl}/internal/proposals/${encodeURIComponent(proposalId)}`);
    if (!res.ok) return c.json({ error: 'Unknown proposal' }, 404);
    const { proposal, spentTodayYen } = (await res.json()) as { proposal: ProposalForSigner; spentTodayYen: number };
    if (proposal.id !== proposalId) return c.json({ error: 'Proposal id mismatch' }, 400);

    const verdict = await verifyForSigning(proposal, {
      deployments: env.deployments, policy: env.policy, approver: env.approver, agentAddress: wallet.address,
      spentTodayYen,
      ledgerSpentTodayYen: async () => state.spentTodayYen(),
      isConsumed: async (id) => state.isConsumed(id),
      isSignatureUsed: async (sig) => state.isSignatureUsed(sig),
      readItem, screen: (a) => quickScan(a, { apiKey: env.interceptaKey }),
    });
    if (!verdict.ok) {
      console.log(`[signer] REFUSED ${proposalId}: ${verdict.reason}`);
      return c.json({ error: verdict.reason }, 422);
    }

    const pre = await preflight(proposal.txs);
    if (!pre.ok) {
      console.log(`[signer] REFUSED ${proposalId}: ${pre.error}`);
      return c.json({ error: pre.error }, 422);
    }

    // Consumed BEFORE the first send: once we've decided to sign, a crash or a retry of this same
    // request must never sign it twice. The on-chain sends below can partially succeed, but replay
    // of the proposal id (and of the approval signature, if any) is blocked from this point on.
    state.markConsumed(proposal.id);
    if (proposal.approval) state.markSignatureUsed(proposal.approval.signature);

    let txHashes: string[];
    try {
      txHashes = await sendAll(proposal.txs);
    } catch (e) {
      if (e instanceof PartialSendError) {
        console.error(`[signer] PARTIAL SEND ${proposalId}: ${e.message}; sent ${e.txHashes.join(', ') || '(none)'}`);
        // Whatever did land already spent real money; record it even though the proposal failed.
        if (e.txHashes.length > 0) state.recordSpend(verdict.spendYen);
        return c.json({ error: e.message, txHashes: e.txHashes }, 500);
      }
      throw e;
    }

    if (verdict.spendYen > 0) state.recordSpend(verdict.spendYen);
    console.log(`[signer] signed ${proposalId}: ${txHashes.join(', ')}`);
    return c.json({ txHashes });
  } finally {
    inFlight.delete(proposalId);
  }
});

serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' });
console.log(`signer for ${wallet.address} on 127.0.0.1:${env.port}`);
