import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { quickScan, type ProposalForSigner } from '@mc/core';
import { env } from './env.ts';
import { readItem, sendAll, preflight, wallet, PartialSendError, withTimeout } from './chain.ts';
import { approvalKey, verifyForSigning } from './verify.ts';
import { openState } from './state.ts';

const app = new Hono();
const inFlight = new Set<string>();
const state = openState(env.statePath);
const PROPOSAL_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// A single in-process mutex over the whole verify-then-send pipeline. Without it, two concurrent
// /sign calls for two *different* (individually legitimate) proposal ids could both pass their own
// isConsumed/isApprovalUsed/budget checks while the other is still awaiting readItem/screen/preflight,
// and both proceed to spend — the atomic tryClaim below only catches replay of the *same* proposal id
// or approval key, not two distinct proposals racing each other under the same daily budget. Every
// /sign request is queued through this promise chain and processed strictly one at a time.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(() => undefined, () => undefined); // keep the chain alive even after a failure
  return result;
}

app.post('/sign', async (c) => {
  const body = await c.req.json().catch(() => null);
  const proposalId = (body as { proposalId?: unknown } | null)?.proposalId;
  if (typeof proposalId !== 'string') return c.json({ error: 'proposalId must be a string' }, 400);
  if (!PROPOSAL_ID_RE.test(proposalId)) return c.json({ error: 'Invalid proposalId' }, 400);

  // Fast, lock-free rejection of an exact duplicate submission that's already queued or running,
  // before it even joins the serialization queue.
  if (inFlight.has(proposalId)) return c.json({ error: 'Already signing' }, 409);
  inFlight.add(proposalId);
  try {
    return await serialized(() => handleSign(proposalId));
  } catch (e) {
    // Anything that escapes here — including a fetch/preflight/wait timeout — fails closed with a
    // plain error response instead of leaking to Hono's default handler. The mutex itself is
    // unaffected: `serialized`'s internal chain already settles on rejection (see above), so the
    // next queued /sign proceeds normally regardless of what happens to this response.
    console.error(`[signer] ERROR ${proposalId}: ${(e as Error).message}`);
    return c.json({ error: (e as Error).message }, 500);
  } finally {
    inFlight.delete(proposalId);
  }
});

async function handleSign(proposalId: string) {
  // Cheap, local rejection before touching the network: a consumed proposal is never re-signed,
  // no matter what the api says about it now.
  if (state.isConsumed(proposalId)) return jsonResponse({ error: 'Proposal already executed' }, 422);

  // 10s cap on the internal api call: a hung fetch would otherwise block this request — and, via
  // the mutex, every later /sign — forever.
  const res = await fetch(`${env.apiUrl}/internal/proposals/${encodeURIComponent(proposalId)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return jsonResponse({ error: 'Unknown proposal' }, 404);
  const { proposal, spentTodayYen } = (await res.json()) as { proposal: ProposalForSigner; spentTodayYen: number };
  if (proposal.id !== proposalId) return jsonResponse({ error: 'Proposal id mismatch' }, 400);

  const verdict = await verifyForSigning(proposal, {
    deployments: env.deployments, policy: env.policy, approver: env.approver, agentAddress: wallet.address,
    spentTodayYen,
    ledgerSpentTodayYen: async () => state.spentTodayYen(),
    isConsumed: async (id) => state.isConsumed(id),
    isApprovalUsed: async (key) => state.isApprovalUsed(key),
    readItem, screen: (a) => quickScan(a, { apiKey: env.interceptaKey }),
  });
  if (!verdict.ok) {
    console.log(`[signer] REFUSED ${proposalId}: ${verdict.reason}`);
    return jsonResponse({ error: verdict.reason }, 422);
  }

  const pre = await withTimeout(preflight(proposal.txs), 60_000, 'Preflight timed out');
  if (!pre.ok) {
    console.log(`[signer] REFUSED ${proposalId}: ${pre.error}`);
    return jsonResponse({ error: pre.error }, 422);
  }

  // The single enforcement point for replay-safety and budget reservation: synchronous, atomic,
  // and — thanks to the mutex above — the only thing touching this state right now anyway. Claims
  // the proposal id and its approval key (if any) and reserves the spend *before* anything is sent,
  // rather than after sendAll resolves. If this loses (already claimed), refuse without sending.
  const key = proposal.approval ? approvalKey(proposal.chainId, proposal.txs, proposal.approval) : null;
  if (!state.tryClaim(proposal.id, key, verdict.spendYen)) {
    console.log(`[signer] REFUSED ${proposalId}: lost the claim race`);
    return jsonResponse({ error: 'Proposal already executed' }, 422);
  }

  let txHashes: string[];
  try {
    txHashes = await sendAll(proposal.txs);
  } catch (e) {
    if (e instanceof PartialSendError) {
      console.error(`[signer] PARTIAL SEND ${proposalId}: ${e.message}; sent ${e.txHashes.join(', ') || '(none)'}`);
      // The spend was already reserved at claim time above; it is not re-recorded or rolled back
      // here even though the send failed partway — see chain.ts's PartialSendError and the round-2
      // fix report for the reasoning (fail-closed: never re-open budget for a proposal we already
      // committed to and partially or fully attempted).
      return jsonResponse({ error: e.message, txHashes: e.txHashes }, 500);
    }
    throw e;
  }

  console.log(`[signer] signed ${proposalId}: ${txHashes.join(', ')}`);
  return jsonResponse({ txHashes });
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' });
console.log(`signer for ${wallet.address} on 127.0.0.1:${env.port}`);
