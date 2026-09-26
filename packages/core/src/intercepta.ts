import type { Screening, ToxicScore } from './types.ts';

function isToxicScore(x: unknown): x is ToxicScore {
  const v = x as ToxicScore;
  return typeof v?.toxicScore === 'number' && Array.isArray(v.traits);
}

export async function quickScan(
  address: string,
  opts: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }
): Promise<Screening> {
  const fetchedAt = new Date().toISOString();
  if (!opts.apiKey) return { address, ok: false, error: 'INTERCEPTA_API_KEY not set', fetchedAt };
  const url = `${opts.baseUrl ?? 'https://api.web3antivirus.io'}/api/public/v2/extension/account/${address}/quick-scan`;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      headers: { 'X-API-KEY': opts.apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
    });
    if (!res.ok) return { address, ok: false, error: `HTTP ${res.status}`, fetchedAt };
    const body = await res.json();
    if (!isToxicScore(body)) return { address, ok: false, error: 'Unexpected response shape', fetchedAt };
    return { address, ok: true, result: body, fetchedAt };
  } catch (e) {
    return { address, ok: false, error: (e as Error).message, fetchedAt };
  }
}
