import { randomUUID } from 'node:crypto';
import {
  assessRisk, evaluateOrder, evaluateTransfer, hashProposal, verifyApproval,
  type ApprovalRecord, type OrderLine, type PolicyConfig, type ProposalKind, type RiskAssessment,
} from '@mc/core';
import type { Mb } from './multibaas.ts';
import type { Screener } from './screening.ts';
import type { ProposalStatus, Store } from './store.ts';
import { bus } from './events.ts';

export interface Deps {
  mb: Pick<Mb, 'readStalls' | 'composeBuy' | 'composeTransfer'>; screen: Screener; store: Store;
  policy: PolicyConfig; chainId: number; agentAddress: string; approverAddress: string; publicBaseUrl: string;
  approvalBaseUrl: string;
  signer: { sign(id: string): Promise<{ txHashes: string[] }> };
}
export interface ProposalView {
  proposalId: string; kind: ProposalKind; status: ProposalStatus; totalYen: number; requiresApproval: boolean;
  approvalReasons: string[]; approvalUrl: string | null; hash: string; decision: unknown;
}

function view(d: Deps, id: string): ProposalView {
  const p = d.store.getProposal(id)!;
  const dec = p.decision as { approvalReasons?: string[] };
  return { proposalId: p.id, kind: p.kind, status: p.status, totalYen: p.totalYen, requiresApproval: p.requiresApproval,
    approvalReasons: dec.approvalReasons ?? [], hash: p.hash, decision: p.decision,
    approvalUrl: p.status === 'awaiting_approval' ? `${d.approvalBaseUrl}/approve/${p.id}` : null };
}

export async function proposeOrder(d: Deps, lines: OrderLine[]): Promise<ProposalView> {
  const stalls = await d.mb.readStalls();
  const wanted = new Set(lines.map((l) => l.itemId));
  const risk: Record<string, RiskAssessment> = {};
  await Promise.all(stalls.filter((s) => wanted.has(s.itemId)).map(async (s) => {
    risk[s.payTo.toLowerCase()] = assessRisk(await d.screen(s.payTo), d.policy.risk);
  }));
  const decision = evaluateOrder({ lines, stalls, risk, spentTodayYen: d.store.spentTodayYen(), cfg: d.policy });
  const payable = decision.lines.filter((l) => l.action !== 'REFUSE');
  const txs = [];
  for (const l of payable) txs.push(await d.mb.composeBuy(l.itemId, l.qty, d.agentAddress));
  const status: ProposalStatus = decision.refusedAll ? 'refused' : decision.requiresApproval ? 'awaiting_approval' : 'proposed';
  const id = randomUUID();
  d.store.insertProposal({ id, kind: 'order', status, hash: hashProposal(d.chainId, txs), totalYen: decision.totalYen,
    requiresApproval: decision.requiresApproval, decision, txs, meta: { lines } });
  bus.emit('proposal', view(d, id));
  return view(d, id);
}

export async function proposeTransfer(d: Deps, a: { to: string; amountYen: number; memo: string }): Promise<ProposalView> {
  const risk = assessRisk(await d.screen(a.to), d.policy.risk);
  const decision = evaluateTransfer({ to: a.to, amountYen: a.amountYen, risk, spentTodayYen: d.store.spentTodayYen(), cfg: d.policy });
  const txs = decision.action === 'REFUSE' ? [] : [await d.mb.composeTransfer(a.to, a.amountYen, d.agentAddress)];
  const status: ProposalStatus = decision.action === 'REFUSE' ? 'held' : decision.requiresApproval ? 'awaiting_approval' : 'proposed';
  const id = randomUUID();
  d.store.insertProposal({ id, kind: 'transfer', status, hash: hashProposal(d.chainId, txs),
    totalYen: decision.action === 'REFUSE' ? 0 : a.amountYen, requiresApproval: decision.requiresApproval,
    decision, txs, meta: { memo: a.memo } });
  bus.emit('proposal', view(d, id));
  return view(d, id);
}

export function recordApproval(d: Deps, id: string, a: ApprovalRecord) {
  const p = d.store.getProposal(id);
  if (!p) return { ok: false, reason: 'Unknown proposal' };
  if (p.status !== 'awaiting_approval') return { ok: false, reason: `Proposal is ${p.status}` };
  if (a.totalYen !== p.totalYen) return { ok: false, reason: 'Approved total does not match proposal' };
  const v = verifyApproval({ chainId: d.chainId, proposalHash: p.hash, totalYen: a.totalYen, expiresAt: a.expiresAt,
    signature: a.signature, approver: d.approverAddress });
  if (!v.ok) return v;
  d.store.setApproval(id, a);
  bus.emit('approval', { proposalId: id });
  return { ok: true };
}

export async function execute(d: Deps, id: string) {
  const p = d.store.getProposal(id);
  if (!p) return { status: 'failed' as ProposalStatus, reason: 'Unknown proposal' };
  if (p.status === 'refused' || p.status === 'held' || p.status === 'executed') return { status: p.status };
  if (p.status === 'failed') return { status: 'failed' as ProposalStatus, reason: 'Proposal failed; propose a new one' };
  if (p.requiresApproval && !p.approval) return { status: 'awaiting_approval' as ProposalStatus };
  // Atomic claim: only the caller that flips 'proposed'/'approved' -> 'executing' may go on to call
  // the signer and later write 'failed'/'executed'. A concurrent second call for the same id loses
  // the claim and returns immediately without ever reaching the signer — this is what stops a race
  // from producing a spurious "Signer refused" for a request that was, in fact, still in flight.
  if (!d.store.claimExecution(id)) return { status: 'executing' as ProposalStatus };
  try {
    const { txHashes } = await d.signer.sign(id);
    d.store.setStatus(id, 'executed', txHashes);
    bus.emit('executed', { proposalId: id, txHashes });
    return { status: 'executed' as ProposalStatus, txHashes };
  } catch (e) {
    d.store.setStatus(id, 'failed');
    bus.emit('signer_refused', { proposalId: id, reason: (e as Error).message });
    return { status: 'failed' as ProposalStatus, reason: (e as Error).message };
  }
}
