import type { RiskAssessment, RiskConfig, Screening } from './types.ts';

export function assessRisk(s: Screening, cfg: RiskConfig): RiskAssessment {
  if (!s.ok || !s.result) {
    return { action: 'ASK', score: null, reasons: [`Screening unavailable (${s.error ?? 'no result'}); a human must decide`] };
  }
  const { toxicScore, traits } = s.result;
  const describe = (t: { name: string; description: string }) => t.description || t.name;
  const hard = traits.filter((t) => cfg.hardTraits.includes(t.name));
  if (hard.length) return { action: 'REFUSE', score: toxicScore, reasons: hard.map(describe) };
  const reasons = traits.length ? traits.map(describe) : [`Toxic score ${toxicScore}`];
  if (toxicScore >= cfg.refuseScore) return { action: 'REFUSE', score: toxicScore, reasons };
  if (toxicScore >= cfg.askScore) return { action: 'ASK', score: toxicScore, reasons };
  if (toxicScore >= cfg.capScore) return { action: 'CAP', score: toxicScore, reasons };
  return { action: 'PAY', score: toxicScore, reasons: [] };
}
