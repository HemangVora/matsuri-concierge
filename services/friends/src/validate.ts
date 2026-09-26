import type { Deployments } from '@mc/core';

// The only origins a friend agent will ever fetch a payUrl from: the api, local dev only. A friend's
// agent holds real keys — fetching an attacker-supplied URL (SSRF) or paying against a spoofed 402
// from anywhere else would let a malicious payUrl steer the wallet into signing for arbitrary terms.
export const ALLOWED_PAY_ORIGINS = ['http://localhost:8787', 'http://127.0.0.1:8787'] as const;

export interface Accept {
  scheme: string;
  chainId: number;
  settlement: string;
  token: string;
  to: string;
  amount: string;
  amountYen: number;
  billId: string;
  deadline: number;
  memo: string;
}

export interface PaymentRequiredBody {
  x402Version?: unknown;
  error?: unknown;
  accepts?: unknown[];
}

export type ValidationResult = { ok: true; accept: Accept } | { ok: false; reason: string };

const sameAddress = (value: unknown, expected: string): boolean =>
  typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();

/** Rejects any payUrl whose origin isn't the api, before it's ever fetched. */
export function validatePayUrl(payUrl: unknown, allowedOrigins: readonly string[] = ALLOWED_PAY_ORIGINS): string | null {
  if (typeof payUrl !== 'string' || payUrl.length === 0) return 'payUrl must be a non-empty string';
  let url: URL;
  try {
    url = new URL(payUrl);
  } catch {
    return 'payUrl is not a valid URL';
  }
  if (!allowedOrigins.includes(url.origin)) return `payUrl origin ${url.origin} is not the api`;
  return null;
}

/**
 * Validates the shape and terms of a 402 body's `accepts[0]` against the deployment this friend
 * agent expects to pay into, and against the friend's own spending limit. Anything that fails here
 * means the agent refuses to sign, full stop — it never trusts fields off an HTTP response to decide
 * what its wallet commits to.
 */
export function validateAccepts(body: unknown, deployments: Deployments): ValidationResult {
  const accepts = (body as PaymentRequiredBody | null)?.accepts;
  const accept = Array.isArray(accepts) ? (accepts[0] as Partial<Accept> | undefined) : undefined;
  if (!accept || typeof accept !== 'object') return { ok: false, reason: 'missing accepts[0]' };

  if (accept.scheme !== 'eip712-share') return { ok: false, reason: `unsupported scheme: ${String(accept.scheme)}` };
  if (accept.chainId !== deployments.chainId) return { ok: false, reason: `unexpected chainId: ${String(accept.chainId)}` };
  if (!sameAddress(accept.settlement, deployments.settlement)) return { ok: false, reason: 'unexpected settlement contract' };
  if (!sameAddress(accept.token, deployments.stablecoin)) return { ok: false, reason: 'unexpected token' };

  if (
    typeof accept.amountYen !== 'number' ||
    !Number.isInteger(accept.amountYen) ||
    accept.amountYen <= 0 ||
    accept.amountYen > 3000
  ) {
    return { ok: false, reason: `friend agent limit: amountYen ${String(accept.amountYen)} is not an integer in (0, 3000]` };
  }
  if (typeof accept.to !== 'string' || accept.to.length === 0) return { ok: false, reason: 'missing accepts[0].to' };
  if (typeof accept.amount !== 'string' || accept.amount.length === 0) return { ok: false, reason: 'missing accepts[0].amount' };
  if (typeof accept.billId !== 'string' || accept.billId.length === 0) return { ok: false, reason: 'missing accepts[0].billId' };
  if (typeof accept.deadline !== 'number' || !Number.isInteger(accept.deadline)) {
    return { ok: false, reason: 'missing or invalid accepts[0].deadline' };
  }

  return { ok: true, accept: accept as Accept };
}
