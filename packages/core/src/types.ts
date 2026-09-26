export type Action = 'PAY' | 'CAP' | 'ASK' | 'REFUSE';

export interface StallMeta { itemId: number; name: string; item: string; emoji: string; }
export interface Stall extends StallMeta { priceYen: number; available: number; payTo: string; }
export interface OrderLine { itemId: number; quantity: number; }

export interface ToxicTrait { risk: number; name: string; txsCount: number; description: string; }
export interface ToxicScore { toxicScore: number; traits: ToxicTrait[]; }
export interface Screening { address: string; ok: boolean; result?: ToxicScore; error?: string; fetchedAt: string; }
export interface RiskAssessment { action: Action; score: number | null; reasons: string[]; }

export interface RiskConfig { refuseScore: number; askScore: number; capScore: number; capFraction: number; hardTraits: string[]; }
export interface PolicyConfig { maxPerStallYen: number; approvalThresholdYen: number; dailyBudgetYen: number; risk: RiskConfig; }

export interface LineDecision {
  itemId: number; stallName: string; payTo: string;
  requestedQty: number; qty: number; priceYen: number; subtotalYen: number;
  action: Action; reasons: string[];
}
export interface OrderDecision {
  lines: LineDecision[]; totalYen: number;
  requiresApproval: boolean; approvalReasons: string[]; refusedAll: boolean;
}
export interface TransferDecision {
  to: string; amountYen: number; action: Action; reasons: string[];
  requiresApproval: boolean; approvalReasons: string[];
}

export interface UnsignedTx { to: string; data: string; value: string; }
export type ProposalKind = 'order' | 'transfer' | 'settle';
export interface ApprovalRecord { signature: string; totalYen: number; expiresAt: number; }
export interface ProposalForSigner {
  id: string; kind: ProposalKind; chainId: number; txs: UnsignedTx[];
  approval: ApprovalRecord | null;
}
export interface Deployments { chainId: number; stablecoin: string; voucher: string; settlement: string; }
