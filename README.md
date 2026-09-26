# Matsuri Concierge

A festival agent that plans and buys matsuri food vouchers for a group, and settles the bill between friends' agents. Between the agent's intent and the chain sits a deterministic **missing layer** — policy, Intercepta screening, human approval and a separate signer — that decides whether money actually moves.

Curvegrid's tagline, taken literally: *"Ethereum settles value, AI creates intent. The missing layer decides whether money should move."*

Built for ETHGlobal Tokyo 2026 (Classic track). Target prizes: Curvegrid "Best AI Agent Project" and Intercepta "Safe Agent-to-Agent Payments with x402".

## Architecture

```
intent            agent              policy engine        human approval        secure signer          chain
"4 of us,    ->  services/api   ->  packages/core     ->  apps/web          ->  services/signer   ->  Sepolia
 ¥3,000,          (Claude tool      policy.ts/risk.ts     Approve.tsx           (only process           MatsuriVoucher
 dinner"          loop, NO             (pure TS,           EIP-712              holding the              MatsuriStablecoin
                  private keys)        deterministic)      signature via         agent's key;             KanjoSettlement
                                                            MetaMask)             re-runs every check)
```

- **Agent** (`services/api`) — a Claude tool-use loop (`services/api/src/agent.ts`) with tools `list_stalls`, `propose_order`, `execute_order`, `split_bill`, `ledger`, `rescreen_counterparties` (`services/api/src/tools.ts`). It can only *propose*; it holds no wallet key (`services/api/src/env.ts` never reads a private key — see `services/api/test/no-keys.test.ts`).
- **Policy engine** (`packages/core/src/policy.ts`, `packages/core/src/risk.ts`) — plain, deterministic TypeScript. Maps Intercepta's `toxicScore`/`traits` to `PAY` / `CAP` / `ASK` / `REFUSE` per `config/policy.json`.
- **Human approval** (`apps/web/src/Approve.tsx`) — orders over ¥1,000 (or any `ASK` verdict) require the human to sign an EIP-712 `Approval{proposalHash,totalYen,expiresAt}` with their own wallet (MetaMask).
- **Secure signer** (`services/signer`) — a separate process holding the only spending key. Independently re-verifies everything before it will sign (see [Security model](#security-model)).
- **Chain** (`contracts/`) — `MatsuriStablecoin` (MJPY, an ERC-20), `MatsuriVoucher`, `KanjoSettlement`, adapted from `curvegrid/matsuri-stablecoin-sample-app`, deployed to Ethereum Sepolia.

## The two flows

### Yatai (buy)
1. "4 of us, ¥3,000, dinner please" → the agent calls `list_stalls` (a live MultiBaas read), picks items, calls `propose_order`.
2. `services/api/src/proposals.ts` (`proposeOrder`) composes unsigned `buyVoucher` transactions via MultiBaas, screens every stall's `payTo` with Intercepta, runs `evaluateOrder`, and emits a verdict per line to the UI's "missing layer" feed.
3. `REFUSE` lines are dropped and explained; the agent may propose an alternative stall.
4. If approval is required, the UI shows an approval card; the human signs with MetaMask.
5. `execute_order` asks `services/signer`, which independently recomputes the proposal hash, checks the allowlisted contract + selector, decodes the calldata, re-reads price/stall on-chain, re-screens the `payTo` with Intercepta, re-runs `evaluateOrder` with its own policy file, verifies the approval signature, then signs and sends.
6. Hard backstop: the agent wallet's on-chain MJPY allowance to the voucher contract is capped at the daily budget, so even a fully compromised off-chain stack cannot overspend.

### Kanjō (settle)
1. "Split it: I paid 2600, Ken paid 1800 — You, Aoi, Mei, Ken" → `split_bill` (pure code, `packages/core/src/split.ts`) computes net transfers.
2. Friends who owe the organizer get an **x402-style** payment request: `GET /kanjo/bills/:id/pay?from=<name>` returns HTTP 402 with payment requirements; the friend's agent retries the same URL with `X-PAYMENT` = a base64 EIP-712 `Share{billId,from,to,amount,deadline}` signature (`services/friends/src/pay.ts`).
3. `services/api/src/kanjo.ts` (`acceptPayment`) Quick Scans the payer before accepting; accepted → the signer submits `KanjoSettlement.settle(...)`; flagged → the request is `held` with a reason and nothing moves.
4. `services/friends` agents will only ever fetch a `payUrl` on the api's own origin, never follow a redirect, and only sign a Share paying the pinned `ORGANIZER_ADDRESS` — never an address named in the response body (`services/friends/src/validate.ts`).
5. "What did we spend and why was Kuro Yatai blocked?" → the `ledger` tool answers from MultiBaas event queries plus the decision log; `rescreen_counterparties` re-screens every stall already paid.

**This is x402-*style*, not the official x402 SDK.** It reuses the HTTP 402 + retry-with-payment-proof shape, but the "payment proof" is our own EIP-712 `Share` signature verified by our own `KanjoSettlement` contract, not the official x402 facilitator/EIP-3009 flow.

## Where the sponsor tech is actually called

### Intercepta (`api.web3antivirus.io` Quick Scan)
All calls go through one function, `quickScan` in `packages/core/src/intercepta.ts` (`GET /api/public/v2/extension/account/:address/quick-scan`). Every call site:

| Call site | File:line | What it screens |
|---|---|---|
| Screener used by the api | `services/api/src/screening.ts:9` (`createScreener`, 10-minute cache) | wraps `quickScan` for every api-side check below |
| Stall payout addresses, before proposing an order | `services/api/src/proposals.ts:35` | every stall `payTo` in the order |
| Transfer/Kanjō payout recipient | `services/api/src/proposals.ts:50` | the `to` address of a `propose_order`/payout transfer |
| Payer accepting a Kanjō share | `services/api/src/kanjo.ts:78` | the friend's address before `acceptPayment` settles |
| Independent re-screen inside the signer | `services/signer/src/server.ts:69`, consumed in `services/signer/src/verify.ts:108,130,149` | stall `payTo` (orders), transfer `to`, and Kanjō payer — re-run with the signer's **own** `INTERCEPTA_API_KEY`, never trusting the api's verdict |

`packages/core/src/risk.ts` (`assessRisk`) maps the response into `PAY`/`CAP`/`ASK`/`REFUSE`: any `hardTraits` match (`sanction_address`, `known_scammer`, `blacklist`, `attack_money_target`, `fake_phishing_transfer`) is a hard `REFUSE`; otherwise `toxicScore` is compared against `refuseScore`/`askScore`/`capScore` in `config/policy.json`. Stall "Kuro Yatai" (`config/stalls.json`, itemId 5) is the stall **designated** to carry an Intercepta-flagged mainnet address so its payment is refused with the reason visible in the UI — as shipped, its `payTo` is still the same sequential placeholder as the other four stalls (see Honest limitations below). Wiring up the real REFUSE demo requires swapping in one of Intercepta's pinned test addresses via `MatsuriVoucher.setEvent` (it's `onlyOwner`, callable post-deploy, no redeploy needed) and setting `INTERCEPTA_API_KEY` — see the "Before recording" section of [`docs/demo-script.md`](docs/demo-script.md).

### MultiBaas (Curvegrid)
- `services/api/src/multibaas.ts` — `createMb()` composes **unsigned** transactions via `contracts.callContractFunction(...)` (`composeBuy`, `composeTransfer`, `composeSettle`); the api never has a key to sign with. It also reads stall state (`eventInfo`) and queries on-chain history through MultiBaas **Event Queries** (`purchases()` reads `VoucherPurchased`, `settlements()` reads `ShareSettled`), which back the `ledger` tool.
- Contract deployment is via `hardhat-multibaas-plugin` — `contracts/ignition/modules/MatsuriConcierge.ts` links each deployed contract to a MultiBaas address alias (`mc_stablecoin`, `mc_voucher`, `mc_settlement`) with `mb.link(...)`, so `callContractFunction` can address them by alias.

## Security model (`services/signer`)

The signer is the only process holding the spending key (`AGENT_PRIVATE_KEY`); everything upstream of it can be compromised and it still fails closed:

- Contract + function-selector allowlist — only `buyVoucher` on the deployed voucher, `transfer` on the deployed stablecoin, `settle` on the deployed settlement contract (`services/signer/src/verify.ts:97,121,139`).
- `value == 0` enforced on every transaction — no native-token transfers (`verify.ts:75`).
- On-chain re-read of price, stock and `payTo` for every item, never trusting what the api sent (`verify.ts:106`).
- Independent Intercepta re-screen with the signer's own API key (`verify.ts:108,130,149`).
- Its own copy of `config/policy.json` — re-runs `evaluateOrder`/`evaluateTransfer` itself rather than trusting the api's verdict.
- Approval is bound to the canonical EIP-712 digest of `{proposalHash, totalYen, expiresAt}` and is single-use (`approvalKey` + `state.isApprovalUsed`, `verify.ts:46-50`, `state.ts`) — every valid re-encoding of the same signature maps to the same key.
- Its own JST-calendar-day spend ledger; the effective daily spend used for policy is `max(api-reported spend, its own ledger)`, so an api that under-reports can never re-open budget it already spent (`verify.ts:92`).
- Preflight `estimateGas` on every transaction before sending, so a proposal that would revert never gets partway executed (`chain.ts:preflight`).
- Atomic claim-before-send (`state.tryClaim`) and a serialized `/sign` queue (`server.ts`'s `serialized()`), so two concurrent signs can never double-spend the daily budget.
- Timeouts on every network hop (internal api fetch, preflight, tx wait) so a hung call fails closed instead of wedging the whole signer.
- Any order/transfer above `approvalThresholdYen` (¥1,000) always needs the human's own EIP-712 signature — the agent cannot self-approve.
- Hard on-chain backstop: the agent wallet's MJPY allowance to the voucher contract is set once to the daily budget (¥5,000), capping worst-case loss regardless of what the rest of the stack does.

Friend agents (`services/friends`): a `payUrl` origin allowlist (`ALLOWED_PAY_ORIGINS`, api-only), `redirect: 'manual'` with every redirect refused, and the payment recipient pinned to the friend's own configured `ORGANIZER_ADDRESS` — never an address named in the 402 response body (`services/friends/src/validate.ts`, `pay.ts`).

## How to run

Requires Node ≥ 24 (`.nvmrc` pins `24`).

```bash
npm install --registry=https://registry.npmjs.org   # the checked-in lockfile resolves through registry.npmmirror.com; a plain
                                                      # `npm install` may fail or hang for some networks (see FEEDBACK.md)
npm run wallets                                      # generates signer/friends wallets into their .env files if not already present

cd contracts && npm run deploy:sepolia               # deploy + link on MultiBaas (needs MB_HOST, MB_ADMIN_API_KEY, DEPLOYER_KEY)
npm run fund                                         # mint/fund test balances
cd ..

npm run setup:allowance -w services/signer           # agent wallet approves the voucher contract for the daily budget (on-chain cap)
npm run setup:approve   -w services/friends          # Aoi's and Mei's wallets approve the settlement contract

npm run dev:api      # services/api      — :8787
npm run dev:signer   # services/signer   — :8788
npm run dev:friends  # services/friends  — :8790
npm run dev:web      # apps/web (vite)   — :5180
```

### Environment variables

| Service | Var | Secret? | Notes |
|---|---|---|---|
| `services/api` | `MB_BASE_URL`, `MB_API_KEY` | key is a secret | MultiBaas DApp User key |
| | `INTERCEPTA_API_KEY` | secret | optional; missing → screening result is `ok:false` and policy falls back to `ASK` |
| | `ANTHROPIC_API_KEY` | secret | Claude API |
| | `AGENT_ADDRESS` | no | public address only — **`services/api` holds no private key** (`services/api/test/no-keys.test.ts`) |
| | `APPROVER_ADDRESS` | no | the human's MetaMask address |
| | `SIGNER_URL`, `PUBLIC_BASE_URL`, `APPROVAL_BASE_URL` | no | local URLs |
| | `AGENT_MODEL`, `AGENT_EFFORT` | no | Claude model/effort |
| | `AOI_ADDRESS`, `MEI_ADDRESS`, `KEN_PAYTO` | no | demo friend addresses; `KEN_PAYTO` is meant to hold an Intercepta-flagged address for the demo — currently blank, see Honest limitations |
| `services/signer` | `AGENT_PRIVATE_KEY` | **secret — the only spending key in the whole system** | |
| | `RPC_URL`, `API_URL`, `APPROVER_ADDRESS` | no | |
| | `INTERCEPTA_API_KEY` | secret | its **own** key, independent of the api's |
| `services/friends` | `AOI_PRIVATE_KEY`, `MEI_PRIVATE_KEY` | secret | simulated friends' wallet keys |
| | `ORGANIZER_ADDRESS` | no | the only address a friend agent will ever pay |
| `contracts` | `DEPLOYER_KEY` | secret | |
| | `MB_HOST`, `MB_ADMIN_API_KEY` | secret | MultiBaas admin key — see FEEDBACK.md on where this actually lives |
| | `AWAJI_RPC_URL`, `SEPOLIA_RPC_URL` | no | see Limitations — `SEPOLIA_RPC_URL` default (`rpc.sepolia.org`) is dead, override it |

Ports: api `8787`, signer `8788`, friends `8790`, web `5180`.

## Tests

```bash
npm test                        # every workspace's node --test suite (packages/core, services/api, services/signer, services/friends)
cd contracts && npx hardhat test
```

## Honest limitations

- Friends (Aoi, Mei) are simulated agents in `services/friends`, not real third-party wallets.
- Deployed to Ethereum **Sepolia**, not Awaji: Awaji requires a ~30 gwei minimum priority fee and the MIZU faucet gave us only 0.014 MIZU, not enough to cover it.
- Intercepta screens real mainnet addresses; EVM addresses are chain-agnostic, so the design pays a real, Intercepta-known address on Sepolia to demonstrate that the same verdict would apply on any chain — but Intercepta's own data is a mainnet reputation signal, not something that has seen Sepolia activity.
- The voucher-contract allowance set by `setup:allowance` is a one-time approval for the daily budget, not an enforced *per-day* renewal — nothing currently resets or re-caps it automatically each calendar day.
- **All five stall `payTo` addresses in `config/stalls.json` — Kuro Yatai included — are still sequential placeholders** (`0x1111…1111` through `0x5555…5555`), not Intercepta's published test fixtures, and `KEN_PAYTO` is blank. `INTERCEPTA_API_KEY` is also still blank in both `services/api/.env` and `services/signer/.env`. As shipped today, every screening call gets `ok:false` and `packages/core/src/risk.ts` falls back to `ASK` — no REFUSE actually happens yet, and every order/transfer needs the human's approval regardless of amount. Getting the intended PAY/CAP/ASK/REFUSE spread (including the deliberate Kuro Yatai REFUSE) requires setting `INTERCEPTA_API_KEY` and swapping in real Intercepta-flagged/clean addresses first — see `docs/demo-script.md`'s "Before recording" section.
- Kanjō is x402-*style* (HTTP 402 + our own EIP-712 signature), not the official x402 SDK/facilitator (see Non-goals in `docs/spec.md`).

## Credits

- `contracts/contracts/MatsuriStablecoin.sol` and the base of `MatsuriVoucher.sol` are adapted from [`curvegrid/matsuri-stablecoin-sample-app`](https://github.com/curvegrid/matsuri-stablecoin-sample-app) (MIT).
- Screening via [Intercepta](https://web3antivirus.io) Quick Scan.
- Chain access, unsigned transaction composition and event queries via [Curvegrid MultiBaas](https://www.curvegrid.com/multibaas).

## AI attribution

See [`AI_ATTRIBUTION.md`](./AI_ATTRIBUTION.md) — every source file in this repo was written by Claude Code from the plan in `docs/superpowers/plans/`.
