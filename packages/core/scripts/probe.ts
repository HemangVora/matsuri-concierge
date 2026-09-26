import stalls from '../../../config/stalls.json' with { type: 'json' };
import policy from '../../../config/policy.json' with { type: 'json' };
import { assessRisk } from '../src/risk.ts';
import { quickScan } from '../src/intercepta.ts';

for (const s of stalls) {
  const scan = await quickScan(s.payTo, { apiKey: process.env.INTERCEPTA_API_KEY ?? '' });
  const risk = assessRisk(scan, policy.risk);
  console.log(`${s.name.padEnd(16)} intent=${s.intent.padEnd(11)} score=${scan.result?.toxicScore ?? '-'} → ${risk.action}  ${risk.reasons.join(' | ') || scan.error || ''}`);
}
