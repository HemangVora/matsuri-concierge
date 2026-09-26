# AI attribution

Every source file in this repository was written by Claude Code, not a human, working from the implementation plan at [`docs/superpowers/plans/2026-09-26-matsuri-concierge.md`](docs/superpowers/plans/2026-09-26-matsuri-concierge.md) against the spec at [`docs/spec.md`](docs/spec.md).

Process: a Claude Opus 5.5 controller session broke the plan into tasks; Claude Sonnet implementer subagents wrote the code for each task test-first; Claude Opus reviewer passes checked each task's diff before the next task started (multiple review rounds happened on several tasks — e.g. the signer's replay/atomicity guards and the friends' payment validation each went through more than one review-and-fix cycle before landing). Every commit on this branch carries a `Co-Authored-By: Claude` trailer; `git log` is the authoritative record of what changed and when.

No human wrote or hand-edited any of the TypeScript, Solidity, config or docs in this repo; a human reviewed and ran it.

## Files, by directory

Generated from `git ls-files`, excluding `package-lock.json` files and the generated Hardhat Ignition deployment artifacts under `contracts/ignition/deployments/` (those are `hardhat ignition deploy` output, not authored).

**Root**
`.gitignore`, `.nvmrc`, `AI_ATTRIBUTION.md`, `README.md`, `FEEDBACK.md`, `deployments.json`, `package.json`, `tsconfig.base.json`

**`docs/`** — spec and plan artifacts
`docs/spec.md`, `docs/superpowers/plans/2026-09-26-matsuri-concierge.md`, `docs/demo-script.md`

**`config/`** — policy and stall data
`config/policy.json`, `config/stalls.json`

**`scripts/`**
`scripts/gen-wallets.ts`

**`packages/core/`** — shared, pure TypeScript (policy, risk mapping, hashing/EIP-712, bill split, Intercepta client)
`package.json`, `tsconfig.json`, `scripts/probe.ts`,
`src/abi.ts`, `src/approval.ts`, `src/hash.ts`, `src/index.ts`, `src/intercepta.ts`, `src/policy.ts`, `src/risk.ts`, `src/share.ts`, `src/split.ts`, `src/types.ts`, `src/units.ts`,
`test/approval.test.ts`, `test/hash.test.ts`, `test/intercepta.test.ts`, `test/policy.test.ts`, `test/risk.test.ts`, `test/smoke.test.ts`, `test/split.test.ts`

**`services/api/`** — Claude agent loop, MultiBaas composition, Intercepta screening, SQLite store; holds no private key
`.env.example`, `package.json`, `tsconfig.json`,
`src/agent.ts`, `src/env.ts`, `src/events.ts`, `src/kanjo.ts`, `src/ledger.ts`, `src/multibaas.ts`, `src/proposals.ts`, `src/screening.ts`, `src/server.ts`, `src/signerClient.ts`, `src/store.ts`, `src/tools.ts`, `src/validateChat.ts`,
`test/kanjo.test.ts`, `test/multibaas.live.test.ts`, `test/no-keys.test.ts`, `test/proposals.test.ts`, `test/store.test.ts`, `test/tools.test.ts`

**`services/signer/`** — the only process holding the agent's spending key; independent re-verification before signing
`.env.example`, `package.json`, `tsconfig.json`,
`src/chain.ts`, `src/env.ts`, `src/server.ts`, `src/setupAllowance.ts`, `src/state.ts`, `src/verify.ts`,
`test/state.test.ts`, `test/verify.test.ts`

**`services/friends/`** — simulated friend agents (Aoi, Mei)
`.env.example`, `package.json`, `tsconfig.json`,
`src/pay.ts`, `src/server.ts`, `src/setupApprove.ts`, `src/validate.ts`,
`test/pay.test.ts`, `test/validate.test.ts`

**`apps/web/`** — chat, missing-layer decision feed, EIP-712 approval page, ledger
`index.html`, `package.json`, `tsconfig.json`, `vite.config.ts`,
`src/api.ts`, `src/App.tsx`, `src/Approve.tsx`, `src/Chat.tsx`, `src/DecisionFeed.tsx`, `src/Ledger.tsx`, `src/main.tsx`, `src/styles.css`

**`contracts/`** — Solidity + Hardhat 3 + Ignition + hardhat-multibaas-plugin
`.env.example`, `package.json`, `tsconfig.json`, `hardhat.config.ts`,
`contracts/KanjoSettlement.sol`, `contracts/MatsuriStablecoin.sol`, `contracts/MatsuriVoucher.sol`,
`ignition/modules/MatsuriConcierge.ts`,
`scripts/fund.ts`,
`test/settlement.ts`, `test/stablecoin.ts`, `test/voucher.ts`

`contracts/contracts/MatsuriStablecoin.sol` and the base of `contracts/contracts/MatsuriVoucher.sol` are adapted from [`curvegrid/matsuri-stablecoin-sample-app`](https://github.com/curvegrid/matsuri-stablecoin-sample-app) (MIT license) — that portion is third-party code, not Claude-authored, though Claude Code made the adaptations needed to fit this repo's contracts.
