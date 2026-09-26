import type {
  LineDecision, OrderDecision, OrderLine, PolicyConfig, RiskAssessment, Stall, TransferDecision,
} from './types.ts';

const MISSING: RiskAssessment = { action: 'ASK', score: null, reasons: ['No screening result; a human must decide'] };

function merge(lines: OrderLine[]): OrderLine[] {
  const byId = new Map<number, number>();
  for (const l of lines) byId.set(l.itemId, (byId.get(l.itemId) ?? 0) + l.quantity);
  return [...byId].map(([itemId, quantity]) => ({ itemId, quantity }));
}

function decideLine(l: OrderLine, stalls: Stall[], risk: Record<string, RiskAssessment>, cfg: PolicyConfig): LineDecision {
  const stall = stalls.find((s) => s.itemId === l.itemId);
  const base = {
    itemId: l.itemId, stallName: stall?.name ?? `item ${l.itemId}`, payTo: stall?.payTo ?? '',
    requestedQty: l.quantity, priceYen: stall?.priceYen ?? 0,
  };
  const refuse = (reasons: string[]): LineDecision => ({ ...base, qty: 0, subtotalYen: 0, action: 'REFUSE', reasons });

  if (!Number.isInteger(l.quantity) || l.quantity <= 0) return refuse(['Quantity must be a positive whole number']);
  if (!stall) return refuse(['Stall is not registered on-chain']);
  if (l.quantity > stall.available) return refuse([`Only ${stall.available} left`]);

  const ra = risk[stall.payTo.toLowerCase()] ?? MISSING;
  if (ra.action === 'REFUSE') return refuse(ra.reasons);

  let qty = l.quantity;
  const reasons = [...ra.reasons];
  let capped = false;
  if (ra.action === 'CAP') {
    qty = Math.floor(qty * cfg.risk.capFraction);
    capped = true;
    reasons.push(`Risk cap: quantity limited to ${qty}`);
    if (qty === 0) return refuse(reasons);
  }
  const maxQty = Math.floor(cfg.maxPerStallYen / stall.priceYen);
  if (maxQty === 0) return refuse([`Price ¥${stall.priceYen} exceeds per-stall limit ¥${cfg.maxPerStallYen}`]);
  if (qty > maxQty) {
    qty = maxQty;
    capped = true;
    reasons.push(`Per-stall limit ¥${cfg.maxPerStallYen}: quantity limited to ${qty}`);
  }
  const action = ra.action === 'ASK' ? 'ASK' : capped ? 'CAP' : 'PAY';
  return { ...base, qty, subtotalYen: qty * stall.priceYen, action, reasons };
}

export function evaluateOrder(input: {
  lines: OrderLine[]; stalls: Stall[]; risk: Record<string, RiskAssessment>; spentTodayYen: number; cfg: PolicyConfig;
}): OrderDecision {
  const { cfg } = input;
  let lines = merge(input.lines).map((l) => decideLine(l, input.stalls, input.risk, cfg));
  let totalYen = lines.reduce((sum, l) => sum + l.subtotalYen, 0);
  const remaining = cfg.dailyBudgetYen - input.spentTodayYen;

  if (totalYen > remaining) {
    const reason = `Over daily budget: ¥${totalYen} requested, ¥${Math.max(remaining, 0)} left today`;
    lines = lines.map((l) => ({ ...l, qty: 0, subtotalYen: 0, action: 'REFUSE', reasons: [...l.reasons, reason] }));
    return { lines, totalYen: 0, requiresApproval: false, approvalReasons: [], refusedAll: true };
  }

  const approvalReasons: string[] = [];
  if (lines.some((l) => l.action === 'ASK')) approvalReasons.push('A stall needs a human decision');
  if (totalYen > 0 && totalYen >= cfg.approvalThresholdYen) approvalReasons.push(`Total ¥${totalYen} ≥ ¥${cfg.approvalThresholdYen}`);
  const refusedAll = lines.every((l) => l.action === 'REFUSE');
  return { lines, totalYen, requiresApproval: approvalReasons.length > 0 && !refusedAll, approvalReasons, refusedAll };
}

export function evaluateTransfer(input: {
  to: string; amountYen: number; risk: RiskAssessment; spentTodayYen: number; cfg: PolicyConfig;
}): TransferDecision {
  const { to, amountYen, risk, cfg } = input;
  const base = { to, amountYen, requiresApproval: false, approvalReasons: [] as string[] };
  if (!Number.isInteger(amountYen) || amountYen <= 0) return { ...base, action: 'REFUSE', reasons: ['Amount must be a positive whole number of yen'] };
  if (risk.action === 'REFUSE') return { ...base, action: 'REFUSE', reasons: risk.reasons };
  if (amountYen > cfg.dailyBudgetYen - input.spentTodayYen) return { ...base, action: 'REFUSE', reasons: ['Over daily budget'] };
  const approvalReasons: string[] = [];
  if (risk.action === 'ASK' || risk.action === 'CAP') approvalReasons.push(...risk.reasons, 'Recipient needs a human decision');
  if (amountYen >= cfg.approvalThresholdYen) approvalReasons.push(`Amount ¥${amountYen} ≥ ¥${cfg.approvalThresholdYen}`);
  const action = risk.action === 'PAY' ? 'PAY' : 'ASK';
  return { to, amountYen, action, reasons: risk.reasons, requiresApproval: approvalReasons.length > 0, approvalReasons };
}
