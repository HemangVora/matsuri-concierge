import type { BaseWallet } from 'ethers';
import { SHARE_TYPES, shareDomain, type Deployments } from '@mc/core';
import { ALLOWED_PAY_ORIGINS, validateAccepts, validatePayUrl } from './validate.ts';

export interface PayParams {
  wallet: BaseWallet;
  payUrl: string;
  deployments: Deployments;
  organizer: string;
  allowedOrigins?: readonly string[];
  fetchImpl?: typeof fetch;
}

export interface PayResult { status: number; body: unknown; }

/**
 * Rejects any response that is, or silently became, a redirect. Both fetches below pass
 * `redirect: 'manual'` so a 3xx is handed back to us instead of being followed transparently — a
 * redirect from the allowed api origin could otherwise point at an attacker's server, which would
 * hand back an attacker-shaped 402 that still passes shape validation. `response.type ===
 * 'opaqueredirect'` covers the no-cors-style case some fetch implementations use for a blocked
 * cross-origin manual redirect; the status-range check covers the common case where the redirect
 * response comes back directly. The origin re-check on `response.url` is defense in depth in case a
 * given fetch implementation ever normalizes/follows without reporting it as a 3xx.
 */
function checkNoRedirect(response: Response, requestedUrl: string, allowedOrigins: readonly string[]): string | null {
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    return 'Redirects are not allowed';
  }
  return validatePayUrl(response.url || requestedUrl, allowedOrigins);
}

/**
 * The friend agent's whole payment flow: fetch the 402, validate its terms (including that the
 * recipient is the organizer this agent already knows about — never an address named by the
 * response), sign a Share with the friend's own key, and retry with X-PAYMENT. Every failure mode
 * refuses before signing; nothing here trusts payUrl's origin, its response's origin (post-redirect),
 * or the money terms named in the 402 body without checking them first.
 */
export async function payFriendPayUrl(params: PayParams): Promise<PayResult> {
  const { wallet, payUrl, deployments, organizer, allowedOrigins = ALLOWED_PAY_ORIGINS, fetchImpl = fetch } = params;

  const originError = validatePayUrl(payUrl, allowedOrigins);
  if (originError) return { status: 400, body: { error: originError } };

  const first = await fetchImpl(payUrl, { redirect: 'manual' });
  const firstRedirectError = checkNoRedirect(first, payUrl, allowedOrigins);
  if (firstRedirectError) return { status: 400, body: { error: firstRedirectError } };
  if (first.status !== 402) return { status: 400, body: { error: `expected 402, got ${first.status}` } };

  const payload = await first.json().catch(() => null);
  const validated = validateAccepts(payload, deployments, organizer);
  if (!validated.ok) return { status: 400, body: { error: validated.reason } };
  const a = validated.accept;

  const share = { billId: a.billId, from: wallet.address, to: a.to, amount: BigInt(a.amount), deadline: BigInt(a.deadline) };
  const signature = await wallet.signTypedData(shareDomain(a.chainId, a.settlement), SHARE_TYPES, share);
  const header = Buffer.from(JSON.stringify({ from: wallet.address, signature })).toString('base64');

  const second = await fetchImpl(payUrl, { headers: { 'X-PAYMENT': header }, redirect: 'manual' });
  const secondRedirectError = checkNoRedirect(second, payUrl, allowedOrigins);
  if (secondRedirectError) return { status: 400, body: { error: secondRedirectError } };

  return { status: second.status, body: await second.json() };
}
