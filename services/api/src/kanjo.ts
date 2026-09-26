import { randomUUID } from 'node:crypto';
import { id as keccakId } from 'ethers';
import { assessRisk, hashProposal, recoverShareSigner, splitBill, yenToWei, type Deployments } from '@mc/core';
import type { Deps } from './proposals.ts';
import { execute, proposeTransfer } from './proposals.ts';
import type { Mb } from './multibaas.ts';
import { bus } from './events.ts';

export type KanjoDeps = Deps & {
  mb: Deps['mb'] & Pick<Mb, 'composeSettle'>;
  deployments: Deployments;
  friends: Record<string, string>; // name → address (payer address for debtors, payTo for creditors)
};
interface BillRequest { from: string; amountYen: number; payUrl: string; status: 'pending' | 'paid' | 'held'; reason?: string; txHash?: string; }
interface Bill { billId: string; memo: string; totalYen: number; shares: Record<string, number>; deadline: number;
  requests: BillRequest[]; payouts: { to: string; amountYen: number; proposalId: string; status: string; reasons: string[] }[]; }

export async function createBill(d: KanjoDeps, input: { participants: string[]; payments: { name: string; amountYen: number }[]; memo: string }) {
  const split = splitBill({ organizer: 'You', participants: input.participants, payments: input.payments });
  // Validate every creditor has a known address before proposing or persisting anything: otherwise a
  // later creditor missing from `friends` would throw mid-loop after earlier payouts were already
  // proposed (and stored), leaving orphaned proposals with no bill to show for them.
  for (const t of split.transfers) {
    if (t.to !== 'You' && !d.friends[t.to]) throw new Error(`No address for ${t.to}`);
  }
  const billId = keccakId(`bill:${randomUUID()}`);
  const bill: Bill = { billId, memo: input.memo, totalYen: split.totalYen, shares: split.shares,
    deadline: Math.floor(Date.now() / 1000) + 24 * 3600, requests: [], payouts: [] };
  for (const t of split.transfers) {
    if (t.to === 'You') {
      bill.requests.push({ from: t.from, amountYen: t.amountYen, status: 'pending',
        payUrl: `${d.publicBaseUrl}/kanjo/bills/${billId}/pay?from=${encodeURIComponent(t.from)}` });
    } else {
      const to = d.friends[t.to];
      if (!to) throw new Error(`No address for ${t.to}`);
      const v = await proposeTransfer(d, { to, amountYen: t.amountYen, memo: `${input.memo}: pay ${t.to}` });
      const reasons = (v.decision as { reasons?: string[] }).reasons ?? [];
      bill.payouts.push({ to: t.to, amountYen: t.amountYen, proposalId: v.proposalId, status: v.status, reasons });
    }
  }
  d.store.putBill(billId, bill);
  bus.emit('bill', bill);
  return bill;
}

export function paymentRequired(d: KanjoDeps, billId: string, fromName: string) {
  const bill = d.store.getBill(billId) as Bill | null;
  const req = bill?.requests.find((r) => r.from === fromName);
  if (!bill || !req) return null;
  return { x402Version: 'mc-kanjo-1', error: 'Payment required', accepts: [{
    scheme: 'eip712-share', chainId: d.chainId, settlement: d.deployments.settlement, token: d.deployments.stablecoin,
    to: d.agentAddress, amount: yenToWei(req.amountYen).toString(), amountYen: req.amountYen,
    billId, deadline: bill.deadline, memo: bill.memo }] };
}

export async function acceptPayment(d: KanjoDeps, billId: string, fromName: string, header: string) {
  const bill = d.store.getBill(billId) as Bill | null;
  const req = bill?.requests.find((r) => r.from === fromName);
  if (!bill || !req) return { status: 404, body: { error: 'Unknown bill or payer' } };
  let payload: { from: string; signature: string };
  try { payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return { status: 400, body: { error: 'Bad X-PAYMENT' } }; }

  // Bind the request's named debtor to a known address: without this, a share validly signed by
  // anyone (e.g. another friend) could be submitted against a different friend's payment line.
  const expected = d.friends[fromName];
  if (!expected || payload.from.toLowerCase() !== expected.toLowerCase()) {
    return { status: 403, body: { error: 'Payer does not match this request' } };
  }
  // A line that is already paid or held cannot be settled again — checked up front, before spending
  // any effort verifying a signature that (even if perfectly valid) can no longer apply here.
  if (req.status !== 'pending') return { status: 409, body: { error: 'Request is not pending' } };

  const share = { billId, from: payload.from, to: d.agentAddress, amount: yenToWei(req.amountYen), deadline: BigInt(bill.deadline) };
  let signer = '';
  try { signer = recoverShareSigner(d.chainId, d.deployments.settlement, share, payload.signature); } catch { /* invalid */ }
  if (signer.toLowerCase() !== payload.from.toLowerCase()) return { status: 400, body: { error: 'Share signature invalid' } };

  const screening = await d.screen(payload.from);
  // A screening call that itself failed (Intercepta unreachable, no INTERCEPTA_API_KEY, etc.) is not
  // a verdict — it's the missing layer being unable to answer. Report it as a retryable failure and
  // leave the request exactly as it was (still pending, no share marked) rather than holding the line
  // on a screening result that was never actually obtained. Only a real verdict from an ok screening
  // (REFUSE, or ASK/CAP with a score) holds the line.
  if (!screening.ok) return { status: 503, body: { error: 'Screening unavailable, try again', retry: true } };
  const risk = assessRisk(screening, d.policy.risk);
  if (risk.action === 'REFUSE' || risk.action === 'ASK') {
    req.status = 'held'; req.reason = risk.reasons.join('; ');
    d.store.putBill(billId, bill);
    bus.emit('kanjo_held', { billId, from: fromName, reasons: risk.reasons });
    return { status: 403, body: { held: true, reasons: risk.reasons } };
  }
  // markShare stays ahead of execute (guards against a concurrent double submission of the same
  // share); if execute doesn't actually land (signer failure, composeSettle throwing), we unmark so
  // the payer isn't permanently locked out by a share that never settled.
  if (!d.store.markShare(billId, payload.from)) return { status: 409, body: { error: 'Share already submitted' } };

  let tx;
  try {
    tx = await d.mb.composeSettle({ billId, from: payload.from, to: d.agentAddress, amountYen: req.amountYen,
      deadline: bill.deadline, signature: payload.signature }, d.agentAddress);
  } catch (e) {
    d.store.unmarkShare(billId, payload.from);
    return { status: 502, body: { error: (e as Error).message } };
  }
  const proposalId = randomUUID();
  d.store.insertProposal({ id: proposalId, kind: 'settle', status: 'proposed', hash: hashProposal(d.chainId, [tx]),
    totalYen: req.amountYen, requiresApproval: false, decision: { risk }, txs: [tx], meta: { billId, from: fromName } });
  const r = await execute(d, proposalId);
  if (r.status !== 'executed') {
    d.store.unmarkShare(billId, payload.from);
    return { status: 502, body: { error: r.reason ?? r.status } };
  }
  req.status = 'paid'; req.txHash = r.txHashes![0];
  d.store.putBill(billId, bill);
  bus.emit('kanjo_paid', { billId, from: fromName, amountYen: req.amountYen, txHash: req.txHash });
  return { status: 200, body: { txHash: req.txHash } };
}
