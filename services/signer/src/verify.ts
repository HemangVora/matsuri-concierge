import {
  assessRisk, erc20Iface, evaluateOrder, evaluateTransfer, hashProposal, recoverShareSigner, settlementIface,
  verifyApproval, voucherIface, weiToYen,
  type Deployments, type OrderLine, type PolicyConfig, type ProposalForSigner, type RiskAssessment, type Screening, type Stall,
} from '@mc/core';
import { getAddress } from 'ethers';

export interface VerifyCtx {
  deployments: Deployments; policy: PolicyConfig; approver: string; agentAddress: string;
  // The api's claim of what's been spent today. Untrusted: it can only ever make the signer
  // *stricter* (see ledgerSpentTodayYen below), and a malformed value refuses the whole proposal.
  spentTodayYen: number;
  // The signer's own persisted record of what it has actually sent today (Asia/Tokyo calendar day).
  // The effective spend used for policy is max(spentTodayYen, ledgerSpentTodayYen()) so an api that
  // under-reports (0, a stale value, or an outright lie) can never re-open budget the signer itself
  // already spent.
  ledgerSpentTodayYen(): Promise<number>;
  // Replay guards, backed by the signer's own persisted state — never trust the api on this either.
  isConsumed(proposalId: string): Promise<boolean>;
  isSignatureUsed(signature: string): Promise<boolean>;
  readItem(itemId: number): Promise<{ priceYen: number; available: number; payTo: string }>;
  screen(address: string): Promise<Screening>; now?: number;
}
type Result = { ok: true; spendYen: number } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });
const same = (a: string, b: string) => getAddress(a) === getAddress(b);

function checkApproval(p: ProposalForSigner, ctx: VerifyCtx, totalYen: number): Result {
  if (!p.approval) return fail('Human approval required but missing');
  if (p.approval.totalYen !== totalYen) return fail('Approval total does not match the transactions');
  const v = verifyApproval({ chainId: p.chainId, proposalHash: hashProposal(p.chainId, p.txs), totalYen,
    expiresAt: p.approval.expiresAt, signature: p.approval.signature, approver: ctx.approver, now: ctx.now });
  return v.ok ? { ok: true, spendYen: totalYen } : fail(v.reason!);
}

// Never throws: every decode, BigInt coercion, address checksum, and ABI parse below can reject
// malformed on-chain calldata by throwing, and none of that is trustworthy input (it comes from the
// api). run() is left free to throw naturally; this wrapper turns any escaped throw into a plain
// refusal so a hostile or corrupted proposal can never crash the signer or fall through un-refused.
export async function verifyForSigning(p: ProposalForSigner, ctx: VerifyCtx): Promise<Result> {
  try {
    return await run(p, ctx);
  } catch (e) {
    return fail(`Unreadable proposal: ${(e as Error).message}`);
  }
}

async function run(p: ProposalForSigner, ctx: VerifyCtx): Promise<Result> {
  if (p.chainId !== ctx.deployments.chainId) return fail('Wrong chain');
  if (p.txs.length === 0) return fail('Nothing to sign');
  if (p.txs.some((t) => BigInt(t.value) !== 0n)) return fail('Native value transfers are not allowed');
  if (await ctx.isConsumed(p.id)) return fail('Proposal already executed');
  if (p.approval && (await ctx.isSignatureUsed(p.approval.signature))) return fail('Approval signature already used');

  // A finite, non-negative whole number of yen is the only shape of "spent today" the signer will
  // accept from the api at all; anything else (NaN, a negative number meant to fake headroom,
  // Infinity, a fraction) refuses outright rather than trying to sanitize it.
  if (!Number.isInteger(ctx.spentTodayYen) || ctx.spentTodayYen < 0) return fail('Unreliable spend report from the api');
  const spentTodayYen = Math.max(ctx.spentTodayYen, await ctx.ledgerSpentTodayYen());

  if (p.kind === 'order') {
    const lines: OrderLine[] = [];
    for (const t of p.txs) {
      if (!same(t.to, ctx.deployments.voucher)) return fail(`Transaction to non-allowlisted contract ${t.to}`);
      let parsed;
      try { parsed = voucherIface.parseTransaction({ data: t.data }); } catch { return fail('Unreadable calldata'); }
      if (parsed?.name !== 'buyVoucher') return fail(`Unexpected function ${parsed?.name ?? 'unknown'}`);
      lines.push({ itemId: Number(parsed.args[0]), quantity: Number(parsed.args[1]) });
    }
    const stalls: Stall[] = [];
    const risk: Record<string, RiskAssessment> = {};
    for (const itemId of new Set(lines.map((l) => l.itemId))) {
      const item = await ctx.readItem(itemId);
      stalls.push({ itemId, name: `item ${itemId}`, item: '', emoji: '', ...item });
      risk[item.payTo.toLowerCase()] = assessRisk(await ctx.screen(item.payTo), ctx.policy.risk);
    }
    const d = evaluateOrder({ lines, stalls, risk, spentTodayYen, cfg: ctx.policy });
    for (const l of d.lines) {
      if (l.action === 'REFUSE') return fail(`${l.stallName}: ${l.reasons.join('; ')}`);
      if (l.qty !== l.requestedQty) return fail(`${l.stallName}: quantity ${l.requestedQty} exceeds policy (${l.qty})`);
    }
    return d.requiresApproval ? checkApproval(p, ctx, d.totalYen) : { ok: true, spendYen: d.totalYen };
  }

  if (p.kind === 'transfer') {
    if (p.txs.length !== 1) return fail('Transfer must be a single transaction');
    const [t] = p.txs;
    if (!same(t.to, ctx.deployments.stablecoin)) return fail(`Transaction to non-allowlisted contract ${t.to}`);
    let parsed;
    try { parsed = erc20Iface.parseTransaction({ data: t.data }); } catch { return fail('Unreadable calldata'); }
    if (parsed?.name !== 'transfer') return fail(`Unexpected function ${parsed?.name ?? 'unknown'}`);
    // ethers.parseTransaction() always returns the checksummed (mixed-case) form of an
    // address, regardless of how it was originally encoded. Normalize to lowercase before
    // screening/comparing so a screening result keyed on the plain address still matches.
    const to = String(parsed.args[0]).toLowerCase();
    const amountYen = weiToYen(parsed.args[1] as bigint);
    const risk = assessRisk(await ctx.screen(to), ctx.policy.risk);
    const d = evaluateTransfer({ to, amountYen, risk, spentTodayYen, cfg: ctx.policy });
    if (d.action === 'REFUSE') return fail(d.reasons.join('; '));
    return d.requiresApproval ? checkApproval(p, ctx, amountYen) : { ok: true, spendYen: amountYen };
  }

  // settle: money flows IN to the agent; the signer only pays gas, but still screens the payer.
  if (p.txs.length !== 1) return fail('Settle must be a single transaction');
  const [t] = p.txs;
  if (!same(t.to, ctx.deployments.settlement)) return fail(`Transaction to non-allowlisted contract ${t.to}`);
  let parsed;
  try { parsed = settlementIface.parseTransaction({ data: t.data }); } catch { return fail('Unreadable calldata'); }
  if (parsed?.name !== 'settle') return fail(`Unexpected function ${parsed?.name ?? 'unknown'}`);
  const [billId, from, to, amount, deadline, signature] = parsed.args as unknown as [string, string, string, bigint, bigint, string];
  if (!same(to, ctx.agentAddress)) return fail('Settlement must pay the organizer wallet');
  let signer = '';
  try { signer = recoverShareSigner(p.chainId, ctx.deployments.settlement, { billId, from, to, amount, deadline }, signature); }
  catch { return fail('Unreadable share signature'); }
  if (!same(signer, from)) return fail('Share not signed by payer');
  const risk = assessRisk(await ctx.screen(from), ctx.policy.risk);
  if (risk.action === 'REFUSE' || risk.action === 'ASK') return fail(`Payer held: ${risk.reasons.join('; ')}`);
  return { ok: true, spendYen: 0 };
}
