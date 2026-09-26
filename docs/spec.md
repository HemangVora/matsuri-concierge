# Matsuri Concierge: spec

ETHGlobal Tokyo 2026 (hacking Fri 25 Sep 21:00 JST → submit Sun 27 Sep 09:00 JST). Classic track, fresh repo.
Target prizes: Curvegrid "Best AI Agent Project" ($1k) and Intercepta "Safe Agent-to-Agent Payments with x402" ($1,250 / $750).

## One line

A festival agent that plans and buys matsuri food vouchers from stalls, and settles the bill between friends' agents. Between the agent's intent and the chain sits a deterministic "missing layer" (policy + Intercepta screening + human approval + a separate signer) that decides whether money moves.

Curvegrid's tagline, taken literally: *"Ethereum settles value, AI creates intent. The missing layer decides whether money should move."*

## What the judges asked for (source: Curvegrid workshop transcript, Intercepta prize page)

| Ask | Where we meet it |
|---|---|
| Agent never holds private keys | `services/api` (agent) has no key; `services/signer` is a separate process holding the only spending key |
| Prompts are not policy | `packages/core/policy.ts` is plain TypeScript; the LLM can only *propose*; the signer re-runs the same policy |
| Human accountability | Orders over ¥1,000 or any ASK verdict need an EIP-712 approval signed by the human's own wallet; signer verifies it |
| Replace clicking with an agent | Chat (optionally voice) replaces Approve / Buy buttons of the sample app |
| Audit logs / proof of what happened | Decision log in SQLite + on-chain events queried through MultiBaas Event Queries |
| Intercepta live call before signing / before accepting | Quick Scan on every stall payTo before a purchase (api and again in signer); Quick Scan on every payer before accepting a Kanjō share; Quick Scan on a friend agent's payTo before paying it |
| Verdict decides pay / refuse / cap / ask | `packages/core/risk.ts` maps `toxicScore` + `traits` to PAY / CAP / ASK / REFUSE |
| One payment passes, one blocked, reason visible | Stall "Kuro Yatai" payTo is a known-risky mainnet address → REFUSE with `traits[].description` shown |
| Mainnet addresses screened | Stall payout addresses *are* real mainnet addresses (EVM addresses are chain-agnostic); MJPY is sent to the same address on Sepolia |

## Flows

### Yatai (buy)
1. User: "4 of us, ¥3,000, dinner." Agent calls `list_stalls` (MultiBaas reads), picks items, calls `propose_order`.
2. api composes unsigned `buyVoucher` txs via MultiBaas (`from` = agent wallet), screens each stall payTo via Intercepta, runs `evaluateOrder`, stores the proposal, emits decision events to the UI.
3. REFUSE lines are dropped and explained; the agent may re-plan with another stall.
4. If approval is required the UI shows an approval card; the human signs `Approval{proposalHash,totalYen,expiresAt}` with MetaMask.
5. `execute_order` asks the signer. The signer independently: recomputes the proposal hash, checks allowlisted `to` + selector, decodes calldata, reads price/stall on-chain, re-screens payTo via Intercepta, re-runs `evaluateOrder` with its own policy file, verifies the approval signature, then signs and sends.
6. Hard backstop: the agent wallet's on-chain MJPY allowance to the voucher contract equals the daily budget, so even a fully compromised off-chain stack cannot overspend.

### Kanjō (settle)
1. User: "Split it 4 ways. Ken paid ¥800 for drinks." `splitBill` (pure code) computes net transfers.
2. Friends who owe the user get an x402-style payment request: `GET /kanjo/bills/:id/pay?from=` → HTTP 402 with requirements; the friend's agent retries with `X-PAYMENT` = EIP-712 `Share{billId,from,to,amount,deadline}` signature.
3. api Quick Scans the payer before accepting; ACCEPT → signer submits `KanjoSettlement.settle(...)`; flagged → HELD with reason, nothing moves.
4. Ken's agent requests ¥X from the user to a payTo that Intercepta flags → the user's agent HOLDS the payment and shows the reason.
5. "What did we spend and why was that stall blocked?" → `ledger` tool answers from MultiBaas event queries + decision log; `rescreen_counterparties` re-screens everyone paid so far.

This is x402-*style* (HTTP 402 + signed authorization), not the official x402 SDK; the README says so.

## Non-goals
Official x402 SDK / facilitator; World ID (stretch); ENS; mainnet; fiat; merchant redemption flow; mobile app.

## Chain + infra
Ethereum Sepolia (Awaji needs ~0.2 MIZU we don't have). MultiBaas deployment `https://pijegreyazbslgm3qxb77bwjwu.multibaas.com` (Sepolia). Contracts adapted from `curvegrid/matsuri-stablecoin-sample-app` (MIT), attributed in README.
