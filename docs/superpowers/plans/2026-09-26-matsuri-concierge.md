# Matsuri Concierge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A festival agent that buys matsuri food vouchers and settles bills between friends' agents, where a deterministic "missing layer" (policy + Intercepta screening + human EIP-712 approval + separate signer) decides whether money moves.

**Architecture:** npm-workspaces monorepo. `packages/core` is pure TypeScript (policy, risk mapping, hashing, typed data, bill split, Intercepta client) shared by every process. `services/api` runs the Claude agent loop, composes *unsigned* transactions through MultiBaas, screens through Intercepta and stores decisions in SQLite; it holds **no private key**. `services/signer` is a separate process holding the agent wallet key; it re-derives every decision from chain state before signing. `services/friends` simulates friends' agents. `apps/web` is a Vite React chat + decision feed + approval page. Contracts (Hardhat 3, adapted from Curvegrid's MIT sample) live in their own npm project under `contracts/`.

**Tech Stack:** Node 24, TypeScript run via `tsx`, `node:test`, `node:sqlite`, ethers 6.17, Hono + @hono/node-server, @anthropic-ai/sdk (model `claude-opus-5`), @curvegrid/multibaas-sdk 1.1.1, Hardhat 3.18 + Ignition + hardhat-multibaas-plugin 3.0.0, OpenZeppelin 5.6.1, React 19 + Vite 8.

**Spec:** `docs/spec.md`

## Global Constraints

- Node `>=24.0.0` (`.nvmrc` = 24). Every command below assumes `source ~/.nvm/nvm.sh && nvm use 24`.
- Chain: Ethereum Sepolia, chainId `11155111`. RPC `https://ethereum-sepolia-rpc.publicnode.com` (`rpc.sepolia.org` is dead).
- MultiBaas deployment: `https://pijegreyazbslgm3qxb77bwjwu.multibaas.com`. Contract labels/aliases: `mc_stablecoin`, `mc_voucher`, `mc_settlement`.
- Money: MJPY has 18 decimals; **1 MJPY = ¥1**. All policy math is in integer yen (`number`), converted with `parseUnits(String(yen), 18)` only at the tx boundary.
- `services/api` must never read any `*_PRIVATE_KEY` / `*_KEY` wallet secret. Only `services/signer`, `services/friends` and `contracts` hold wallet keys, each in its own gitignored `.env`.
- The LLM never computes amounts, addresses or calldata; tools do.
- Claude model: `claude-opus-5`, `output_config.effort` from env `AGENT_EFFORT` (default `medium`), `thinking: {type: "adaptive"}`, server-side `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`.
- Intercepta: `GET https://api.web3antivirus.io/api/public/v2/extension/account/{address}/quick-scan`, header `X-API-KEY`, response `{ toxicScore: number, traits: {risk,name,txsCount,description}[] }`. Screen the **exact** payTo/payer address (mainnet addresses reused on Sepolia).
- Ports: api `8787`, signer `8788` (bind `127.0.0.1`), friends `8790`, web `5180` (5173 is taken by drishti).
- Hackathon rules: small commits with conventional messages all through the build (no single giant commit); every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; `AI_ATTRIBUTION.md` lists AI-written files; README credits the Curvegrid sample (MIT) and states the Kanjō protocol is x402-*style*, not the official x402 SDK.

## Review Focus

1. **Approval replay:** an approval signed for proposal A submitted for proposal B must be rejected (the hash is recomputed by the signer). Test in Task 4 (`verifyApproval rejects approval for another hash`) and Task 10.
2. **Duplicate lines bypassing the per-stall cap:** `[{itemId:1,qty:2},{itemId:1,qty:2}]` must be merged before caps apply. Test in Task 5.
3. **Intercepta down / 5xx / timeout / malformed body:** fail closed to ASK (human decides), never PAY. Tests in Task 5 (risk) and Task 6 (client).
4. **MultiBaas returns a tx to an unexpected contract or selector:** the signer refuses. Test in Task 10 (`rejects tx to non-allowlisted contract`).
5. **Kanjō share replay:** the same `X-PAYMENT` submitted twice must not move money twice (on-chain `settled[billId][from]` + api dedupe). Tests in Task 2 (contract) and Task 11 (api).

---

## File Structure

```
matsuri-concierge/
  package.json                 # workspaces + root scripts
  tsconfig.base.json
  .nvmrc  .gitignore  README.md  AI_ATTRIBUTION.md  FEEDBACK.md
  config/
    stalls.json                # itemId, name, item, emoji, priceYen, available, payTo (mainnet addr)
    policy.json                # PolicyConfig (shared by api + signer)
  scripts/gen-wallets.ts       # creates agent + friend wallets into service .env files
  contracts/                   # separate npm project (Hardhat 3)
    contracts/MatsuriStablecoin.sol   # from sample, unchanged
    contracts/MatsuriVoucher.sol      # + per-item stall payout
    contracts/KanjoSettlement.sol     # EIP-712 Share-authorised transferFrom
    ignition/modules/MatsuriConcierge.ts
    scripts/fund.ts            # mint MJPY + send gas ETH to agent + friends
    test/voucher.ts  test/settlement.ts
  packages/core/src/
    types.ts  units.ts  abi.ts  hash.ts  approval.ts  share.ts
    risk.ts  policy.ts  split.ts  intercepta.ts  index.ts
  packages/core/test/*.test.ts
  services/api/src/
    env.ts  store.ts  multibaas.ts  screening.ts  events.ts
    proposals.ts  signerClient.ts  kanjo.ts  ledger.ts
    tools.ts  agent.ts  server.ts
  services/api/test/*.test.ts
  services/signer/src/  env.ts  verify.ts  chain.ts  server.ts  setupAllowance.ts
  services/signer/test/verify.test.ts
  services/friends/src/ server.ts  setupApprove.ts
  apps/web/src/ main.tsx  App.tsx  api.ts  Chat.tsx  DecisionFeed.tsx  Approve.tsx  Ledger.tsx  styles.css
```

---

### Task 1: Repo scaffold, wallets, shared config

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `config/stalls.json`, `config/policy.json`, `scripts/gen-wallets.ts`, `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/test/smoke.test.ts`, `AI_ATTRIBUTION.md`

**Interfaces:**
- Produces: workspace `@mc/core` importable as `import { ... } from '@mc/core'`; `config/stalls.json` and `config/policy.json` shapes used by Tasks 2, 5, 8, 10.

- [ ] **Step 1: Root manifests**

`package.json`:
```json
{
  "name": "matsuri-concierge",
  "private": true,
  "type": "module",
  "workspaces": ["packages/core", "services/api", "services/signer", "services/friends", "apps/web"],
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "npm test --workspaces --if-present",
    "wallets": "tsx scripts/gen-wallets.ts",
    "dev:api": "npm run dev -w services/api",
    "dev:signer": "npm run dev -w services/signer",
    "dev:friends": "npm run dev -w services/friends",
    "dev:web": "npm run dev -w apps/web"
  },
  "devDependencies": {
    "@types/node": "24.13.6",
    "tsx": "^4.20.0",
    "typescript": "5.9.3"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

`packages/core/package.json`:
```json
{
  "name": "@mc/core",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "node --import tsx --test test/*.test.ts" },
  "dependencies": { "ethers": "6.17.0" }
}
```
`packages/core/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`

- [ ] **Step 2: Shared config**

`config/stalls.json` (payTo values are placeholders only until Step 5 replaces them with Intercepta's Discord-pinned addresses; the probe in Task 6 confirms each stall's verdict):
```json
[
  { "itemId": 1, "name": "Takoyaki Hachi", "item": "Takoyaki (8 pcs)", "emoji": "🐙", "priceYen": 600, "available": 200, "payTo": "0x1111111111111111111111111111111111111111", "intent": "clean" },
  { "itemId": 2, "name": "Yakisoba Ryu",   "item": "Yakisoba",         "emoji": "🍜", "priceYen": 700, "available": 200, "payTo": "0x2222222222222222222222222222222222222222", "intent": "clean" },
  { "itemId": 3, "name": "Kakigori Yuki",  "item": "Shaved ice",       "emoji": "🍧", "priceYen": 400, "available": 200, "payTo": "0x3333333333333333333333333333333333333333", "intent": "clean" },
  { "itemId": 4, "name": "Karaage Taro",   "item": "Karaage",          "emoji": "🍗", "priceYen": 500, "available": 200, "payTo": "0x4444444444444444444444444444444444444444", "intent": "medium-risk" },
  { "itemId": 5, "name": "Kuro Yatai",     "item": "Mystery skewers",  "emoji": "🍢", "priceYen": 300, "available": 200, "payTo": "0x5555555555555555555555555555555555555555", "intent": "flagged" }
]
```

`config/policy.json`:
```json
{
  "maxPerStallYen": 1500,
  "approvalThresholdYen": 1000,
  "dailyBudgetYen": 5000,
  "risk": {
    "refuseScore": 70,
    "askScore": 40,
    "capScore": 15,
    "capFraction": 0.5,
    "hardTraits": ["sanction_address", "known_scammer", "blacklist", "attack_money_target", "fake_phishing_transfer"]
  }
}
```

- [ ] **Step 3: Wallet generator**

`scripts/gen-wallets.ts` — writes keys only into the env file of the process that owns them, never prints private keys:
```ts
import { Wallet } from 'ethers';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function upsert(file: string, key: string, value: string) {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  const next = lines.filter((l) => !l.startsWith(`${key}=`));
  next.push(`${key}=${value}`);
  writeFileSync(file, next.join('\n') + '\n', { mode: 0o600 });
}
function has(file: string, key: string) {
  return existsSync(file) && readFileSync(file, 'utf8').split('\n').some((l) => l.startsWith(`${key}=0x`));
}

const plan: Array<[string, string, string]> = [
  ['services/signer/.env', 'AGENT_PRIVATE_KEY', 'AGENT_ADDRESS'],
  ['services/friends/.env', 'AOI_PRIVATE_KEY', 'AOI_ADDRESS'],
  ['services/friends/.env', 'MEI_PRIVATE_KEY', 'MEI_ADDRESS'],
];
for (const [file, keyVar, addrVar] of plan) {
  if (has(file, keyVar)) continue;
  const w = Wallet.createRandom();
  upsert(file, keyVar, w.privateKey);
  upsert(file, addrVar, w.address);
  console.log(`${addrVar}=${w.address}`);
}
```

- [ ] **Step 4: Smoke test for the workspace wiring**

`packages/core/src/index.ts`: `export const CORE_VERSION = '0.1.0';`

`packages/core/test/smoke.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_VERSION } from '../src/index.ts';

test('core loads', () => {
  assert.equal(CORE_VERSION, '0.1.0');
});
```

Run: `npm install && npm test -w packages/core`
Expected: `# pass 1`

- [ ] **Step 5: Real stall addresses**

Get Intercepta's pinned test addresses from their ETHGlobal Discord channel (one clean-looking, one medium, one known-risky). Put the risky one on `Kuro Yatai` (itemId 5), a medium one on `Karaage Taro` (4), and clean ones on 1–3. If the medium tier doesn't exist in their list, use a second clean address for 4. Run `npm run wallets` and note the printed `AGENT_ADDRESS`, `AOI_ADDRESS`, `MEI_ADDRESS`.

`AI_ATTRIBUTION.md`:
```md
# AI attribution
Planning, scaffolding and most TypeScript/Solidity in this repo were written with Claude Code (Claude Opus 5.5), reviewed and run by the team.
Files: see git log; commits carry `Co-Authored-By: Claude`. Specs and plans: `docs/spec.md`, `docs/superpowers/plans/`.
Contracts `MatsuriStablecoin.sol` and the base of `MatsuriVoucher.sol` come from curvegrid/matsuri-stablecoin-sample-app (MIT).
```

- [ ] **Step 6: Commit**
```bash
git add -A && git commit -m "chore: scaffold workspaces, shared stall/policy config, wallet generator"
```

---

### Task 2: Contracts — per-stall voucher payouts + KanjoSettlement

**Files:**
- Create: `contracts/` by copying `~/dev/matsuri-stablecoin-sample-app/contracts/{package.json,package-lock.json,tsconfig.json,hardhat.config.ts,.env.example}` and `contracts/contracts/MatsuriStablecoin.sol` verbatim.
- Create: `contracts/contracts/MatsuriVoucher.sol` (modified), `contracts/contracts/KanjoSettlement.sol`
- Test: `contracts/test/voucher.ts`, `contracts/test/settlement.ts`

**Interfaces:**
- Produces (ABI used by core `abi.ts`, Task 3):
  - `MatsuriVoucher.setEvent(uint256 eventId, uint256 price, uint256 available, address stall)`
  - `MatsuriVoucher.buyVoucher(uint256 eventId, uint256 quantity)`
  - `MatsuriVoucher.eventInfo(uint256) view returns (uint256 price, uint256 available, address stall)`
  - `event VoucherPurchased(address indexed buyer, uint256 indexed eventId, uint256 quantity, address indexed stall, uint256 amount)`
  - `KanjoSettlement(address token)`; `settle(bytes32 billId, address from, address to, uint256 amount, uint256 deadline, bytes signature)`; `settled(bytes32,address) view returns (bool)`
  - `event ShareSettled(bytes32 indexed billId, address indexed from, address indexed to, uint256 amount)`
  - EIP-712 domain `{name:"KanjoSettlement", version:"1", chainId, verifyingContract}`, type `Share(bytes32 billId,address from,address to,uint256 amount,uint256 deadline)`

- [ ] **Step 1: Copy the sample contracts project**
```bash
mkdir -p contracts/contracts contracts/test contracts/ignition/modules contracts/scripts
S=~/dev/matsuri-stablecoin-sample-app/contracts
cp $S/package.json $S/package-lock.json $S/tsconfig.json $S/hardhat.config.ts $S/.env.example contracts/
cp $S/contracts/MatsuriStablecoin.sol contracts/contracts/
cp $S/.env contracts/.env   # existing DEPLOYER_KEY, MB_HOST, MB_ADMIN_API_KEY, SEPOLIA_RPC_URL (Sepolia deployment)
cd contracts && npm ci --ignore-scripts
```
In `contracts/package.json` replace the four `deploy*` scripts with:
```json
"deploy:sepolia": "hardhat ignition deploy ignition/modules/MatsuriConcierge.ts --network sepolia",
"deploy:reset:sepolia": "rm -rf ignition/deployments/chain-11155111",
"fund": "hardhat run scripts/fund.ts --network sepolia"
```
Keep the `syncExisting: process.env.MB_SYNC_EXISTING === '1'` line in `hardhat.config.ts` (already present in the sample copy we patched).

- [ ] **Step 2: Write the failing tests**

`contracts/test/voucher.ts`:
```ts
import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();

async function deploy() {
  const [owner, buyer, stallA, stallB] = await ethers.getSigners();
  const coin = await (await ethers.getContractFactory('MatsuriStablecoin')).deploy('Matsuri Yen', 'MJPY', owner.address);
  const voucher = await (await ethers.getContractFactory('MatsuriVoucher')).deploy(await coin.getAddress(), owner.address);
  return { owner, buyer, stallA, stallB, coin, voucher };
}

describe('MatsuriVoucher', () => {
  it('pays the stall configured for the item, not the treasury', async () => {
    const { owner, buyer, stallA, coin, voucher } = await deploy();
    const price = ethers.parseUnits('600', 18);
    await voucher.setEvent(1, price, 10, stallA.address);
    await coin.mint(buyer.address, price * 2n);
    await coin.connect(buyer).approve(await voucher.getAddress(), price * 2n);

    await expect(voucher.connect(buyer).buyVoucher(1, 2))
      .to.emit(voucher, 'VoucherPurchased')
      .withArgs(buyer.address, 1n, 2n, stallA.address, price * 2n);
    expect(await coin.balanceOf(stallA.address)).to.equal(price * 2n);
    expect(await coin.balanceOf(owner.address)).to.equal(0n);
  });

  it('returns the stall from eventInfo', async () => {
    const { stallB, voucher } = await deploy();
    await voucher.setEvent(2, 1n, 5, stallB.address);
    const [price, available, stall] = await voucher.eventInfo(2);
    expect([price, available, stall]).to.deep.equal([1n, 5n, stallB.address]);
  });

  it('rejects a zero stall address', async () => {
    const { voucher } = await deploy();
    await expect(voucher.setEvent(3, 1n, 5, ethers.ZeroAddress)).to.be.revertedWith('Stall required');
  });

  it('still blocks voucher transfers', async () => {
    const { buyer, stallA, coin, voucher } = await deploy();
    await voucher.setEvent(1, 1n, 5, stallA.address);
    await coin.mint(buyer.address, 1n);
    await coin.connect(buyer).approve(await voucher.getAddress(), 1n);
    await voucher.connect(buyer).buyVoucher(1, 1);
    await expect(
      voucher.connect(buyer).transferFrom(buyer.address, stallA.address, 1n)
    ).to.be.revertedWith('Transfers disabled');
  });
});
```

`contracts/test/settlement.ts`:
```ts
import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();

const types = {
  Share: [
    { name: 'billId', type: 'bytes32' },
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

async function deploy() {
  const [owner, friend, organizer, attacker] = await ethers.getSigners();
  const coin = await (await ethers.getContractFactory('MatsuriStablecoin')).deploy('Matsuri Yen', 'MJPY', owner.address);
  const settlement = await (await ethers.getContractFactory('KanjoSettlement')).deploy(await coin.getAddress());
  const amount = ethers.parseUnits('1100', 18);
  await coin.mint(friend.address, amount * 3n);
  await coin.connect(friend).approve(await settlement.getAddress(), amount * 3n);
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'KanjoSettlement', version: '1', chainId, verifyingContract: await settlement.getAddress() };
  const billId = ethers.id('bill-1');
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const share = { billId, from: friend.address, to: organizer.address, amount, deadline };
  const signature = await friend.signTypedData(domain, types, share);
  return { friend, organizer, attacker, coin, settlement, share, signature, domain };
}

describe('KanjoSettlement', () => {
  it('moves the signed share to the signed recipient', async () => {
    const { organizer, coin, settlement, share, signature } = await deploy();
    await expect(
      settlement.connect(organizer).settle(share.billId, share.from, share.to, share.amount, share.deadline, signature)
    ).to.emit(settlement, 'ShareSettled').withArgs(share.billId, share.from, share.to, share.amount);
    expect(await coin.balanceOf(organizer.address)).to.equal(share.amount);
  });

  it('rejects a replay of the same share', async () => {
    const { settlement, share, signature } = await deploy();
    await settlement.settle(share.billId, share.from, share.to, share.amount, share.deadline, signature);
    await expect(
      settlement.settle(share.billId, share.from, share.to, share.amount, share.deadline, signature)
    ).to.be.revertedWith('Already settled');
  });

  it('rejects a recipient the payer did not sign', async () => {
    const { attacker, settlement, share, signature } = await deploy();
    await expect(
      settlement.connect(attacker).settle(share.billId, share.from, attacker.address, share.amount, share.deadline, signature)
    ).to.be.revertedWith('Bad signature');
  });

  it('rejects an expired share', async () => {
    const { friend, organizer, settlement, domain } = await deploy();
    const share = { billId: ethers.id('bill-2'), from: friend.address, to: organizer.address, amount: 1n, deadline: 1n };
    const sig = await friend.signTypedData(domain, types, share);
    await expect(
      settlement.settle(share.billId, share.from, share.to, share.amount, share.deadline, sig)
    ).to.be.revertedWith('Expired');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd contracts && npx hardhat test`
Expected: compile error / FAIL (`KanjoSettlement` not found, `setEvent` arity mismatch).

- [ ] **Step 4: Implement the contracts**

`contracts/contracts/MatsuriVoucher.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { ERC721 } from '@openzeppelin/contracts/token/ERC721/ERC721.sol';
import { Ownable } from '@openzeppelin/contracts/access/Ownable.sol';

// Based on curvegrid/matsuri-stablecoin-sample-app (MIT). Change: each item pays its own stall.
// Curvegrid サンプル (MIT) を元に、商品ごとに屋台へ直接支払うよう変更。
contract MatsuriVoucher is ERC721, Ownable {
    struct EventInfo {
        uint256 price;
        uint256 available;
        address stall;
    }

    IERC20 public immutable stablecoin;

    mapping(uint256 => EventInfo) private events;
    mapping(address => mapping(uint256 => uint256)) private balances;
    mapping(uint256 => uint256) private tokenEvent;
    mapping(address => mapping(uint256 => uint256[])) private ownedEventTokens;
    uint256 private nextTokenId = 1;

    event EventConfigured(uint256 indexed eventId, uint256 price, uint256 available, address indexed stall);
    event VoucherPurchased(address indexed buyer, uint256 indexed eventId, uint256 quantity, address indexed stall, uint256 amount);
    event VoucherRedeemed(address indexed holder, uint256 indexed eventId, uint256 quantity);

    constructor(address stablecoinAddress, address owner_) ERC721('Matsuri Voucher', 'MVCHR') Ownable(owner_) {
        stablecoin = IERC20(stablecoinAddress);
    }

    function setEvent(uint256 eventId, uint256 price, uint256 available, address stall) external onlyOwner {
        require(stall != address(0), 'Stall required');
        events[eventId] = EventInfo({ price: price, available: available, stall: stall });
        emit EventConfigured(eventId, price, available, stall);
    }

    function buyVoucher(uint256 eventId, uint256 quantity) external {
        EventInfo storage info = events[eventId];
        require(info.price > 0, 'Event not found');
        require(quantity > 0, 'Quantity required');
        require(info.available >= quantity, 'Not enough availability');

        uint256 totalCost = info.price * quantity;
        require(stablecoin.transferFrom(msg.sender, info.stall, totalCost), 'Payment failed');
        info.available -= quantity;

        for (uint256 i = 0; i < quantity; i++) {
            uint256 tokenId = nextTokenId++;
            _safeMint(msg.sender, tokenId);
            tokenEvent[tokenId] = eventId;
            ownedEventTokens[msg.sender][eventId].push(tokenId);
            balances[msg.sender][eventId] += 1;
        }
        emit VoucherPurchased(msg.sender, eventId, quantity, info.stall, totalCost);
    }

    function redeemVoucher(uint256 eventId, uint256 quantity) external {
        require(balances[msg.sender][eventId] >= quantity, 'Insufficient vouchers');
        for (uint256 i = 0; i < quantity; i++) {
            uint256[] storage stack = ownedEventTokens[msg.sender][eventId];
            uint256 tokenId = stack[stack.length - 1];
            stack.pop();
            delete tokenEvent[tokenId];
            _burn(tokenId);
            balances[msg.sender][eventId] -= 1;
        }
        emit VoucherRedeemed(msg.sender, eventId, quantity);
    }

    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);
        require(from == address(0) || to == address(0), 'Transfers disabled');
        return from;
    }

    function balanceOf(address owner_, uint256 eventId) external view returns (uint256) {
        return balances[owner_][eventId];
    }

    function eventInfo(uint256 eventId) external view returns (uint256 price, uint256 available, address stall) {
        EventInfo storage info = events[eventId];
        return (info.price, info.available, info.stall);
    }
}
```

`contracts/contracts/KanjoSettlement.sol`:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import { EIP712 } from '@openzeppelin/contracts/utils/cryptography/EIP712.sol';
import { ECDSA } from '@openzeppelin/contracts/utils/cryptography/ECDSA.sol';

// Moves a friend's bill share only to the recipient, amount and bill the friend signed.
// 友人が署名した宛先・金額・伝票に対してのみ割り勘分を移動する。
contract KanjoSettlement is EIP712 {
    bytes32 public constant SHARE_TYPEHASH =
        keccak256('Share(bytes32 billId,address from,address to,uint256 amount,uint256 deadline)');

    IERC20 public immutable token;
    mapping(bytes32 => mapping(address => bool)) public settled;

    event ShareSettled(bytes32 indexed billId, address indexed from, address indexed to, uint256 amount);

    constructor(address token_) EIP712('KanjoSettlement', '1') {
        token = IERC20(token_);
    }

    function settle(
        bytes32 billId,
        address from,
        address to,
        uint256 amount,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, 'Expired');
        require(!settled[billId][from], 'Already settled');
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SHARE_TYPEHASH, billId, from, to, amount, deadline)));
        require(ECDSA.recover(digest, signature) == from, 'Bad signature');
        settled[billId][from] = true;
        require(token.transferFrom(from, to, amount), 'Transfer failed');
        emit ShareSettled(billId, from, to, amount);
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd contracts && npx hardhat test`
Expected: `8 passing` (4 voucher + 4 settlement). Delete the sample's old `test/stablecoin.ts` only if it no longer compiles; otherwise keep it (then 10 passing).

- [ ] **Step 6: Commit**
```bash
git add contracts && git commit -m "feat(contracts): pay each stall directly and add EIP-712 KanjoSettlement"
```

---

### Task 3: Deploy, link to MultiBaas, fund wallets

**Files:**
- Create: `contracts/ignition/modules/MatsuriConcierge.ts`, `contracts/scripts/fund.ts`, `deployments.json` (repo root, generated then committed)

**Interfaces:**
- Consumes: `config/stalls.json` (Task 1), contracts (Task 2).
- Produces: `deployments.json` = `{ "chainId": 11155111, "stablecoin": "0x…", "voucher": "0x…", "settlement": "0x…" }` read by core consumers (api, signer, friends, web). MultiBaas aliases `mc_stablecoin`, `mc_voucher`, `mc_settlement`.

- [ ] **Step 1: Ignition module**

`contracts/ignition/modules/MatsuriConcierge.ts`:
```ts
import { buildModule } from '@nomicfoundation/hardhat-ignition/modules';
import { ethers } from 'ethers';
import { mb } from 'hardhat-multibaas-plugin/ignition';
import stalls from '../../../config/stalls.json' with { type: 'json' };

export default buildModule('MatsuriConcierge', (m) => {
  if (!process.env.MB_HOST || !process.env.MB_ADMIN_API_KEY) {
    throw new Error('Set MB_HOST and MB_ADMIN_API_KEY');
  }
  const owner = m.getAccount(0);
  const stablecoin = m.contract('MatsuriStablecoin', ['Matsuri Yen', 'MJPY', owner]);
  const voucher = m.contract('MatsuriVoucher', [stablecoin, owner]);
  const settlement = m.contract('KanjoSettlement', [stablecoin]);

  mb.link(stablecoin, { contractLabel: 'mc_stablecoin', contractVersion: '1.0', addressAlias: 'mc_stablecoin' });
  mb.link(voucher, { contractLabel: 'mc_voucher', contractVersion: '1.0', addressAlias: 'mc_voucher' });
  mb.link(settlement, { contractLabel: 'mc_settlement', contractVersion: '1.0', addressAlias: 'mc_settlement' });

  for (const s of stalls) {
    m.call(voucher, 'setEvent', [s.itemId, ethers.parseUnits(String(s.priceYen), 18), s.available, s.payTo], {
      id: `setEvent_${s.itemId}`,
    });
  }
  return { stablecoin, voucher, settlement };
});
```

- [ ] **Step 2: Deploy**

Run (retry on `HHE10412` nonce lag; ignition resumes):
```bash
cd contracts && echo y | npm run deploy:sepolia
```
If the run was interrupted after contracts deployed, link with: `echo y | MB_SYNC_EXISTING=1 npm run deploy:sepolia`.
Expected: `[ MatsuriConcierge ] successfully deployed` and three `MultiBaas: Linking contract "mc_…"` lines.
Write the three printed addresses into `/deployments.json` with `"chainId": 11155111`.

- [ ] **Step 3: Verify MultiBaas can read the stall payout**
```bash
U=$(grep ^MB_HOST= contracts/.env|cut -d= -f2); A=$(grep ^MB_ADMIN_API_KEY= contracts/.env|cut -d= -f2)
curl -s -X POST -H "Authorization: Bearer $A" -H 'content-type: application/json' \
  "$U/api/v0/chains/ethereum/addresses/mc_voucher/contracts/mc_voucher/methods/eventInfo" -d '{"args":["5"]}'
```
Expected: `"output":["300000000000000000000","200","0x…"]` with the Kuro Yatai payTo.

- [ ] **Step 4: Funding script**

`contracts/scripts/fund.ts` (deployer mints MJPY and sends gas; addresses come from env, no private keys of other wallets needed):
```ts
import { network } from 'hardhat';
import deployments from '../../deployments.json' with { type: 'json' };

const { ethers } = await network.create();
const [owner] = await ethers.getSigners();
const coin = await ethers.getContractAt('MatsuriStablecoin', deployments.stablecoin);

const targets = [
  { name: 'agent', address: process.env.FUND_AGENT!, yen: '10000' },
  { name: 'aoi', address: process.env.FUND_AOI!, yen: '5000' },
  { name: 'mei', address: process.env.FUND_MEI!, yen: '5000' },
];
for (const t of targets) {
  if (!t.address) throw new Error(`FUND_${t.name.toUpperCase()} missing`);
  await (await coin.mint(t.address, ethers.parseUnits(t.yen, 18))).wait();
  await (await owner.sendTransaction({ to: t.address, value: ethers.parseEther('0.005') })).wait();
  console.log(`funded ${t.name} ${t.address}: ¥${t.yen} MJPY + 0.005 ETH`);
}
```
Run:
```bash
cd contracts && FUND_AGENT=<AGENT_ADDRESS> FUND_AOI=<AOI_ADDRESS> FUND_MEI=<MEI_ADDRESS> npm run fund
```
Expected: three `funded …` lines.

- [ ] **Step 5: Allow MultiBaas CORS for the web app** (already done for 5180 on this deployment; verify):
```bash
curl -s -H "Authorization: Bearer $A" $U/api/v0/cors
```
Expected: includes `http://localhost:5180`.

- [ ] **Step 6: Commit**
```bash
git add contracts/ignition contracts/scripts deployments.json && git commit -m "feat(contracts): deploy concierge contracts to Sepolia, link in MultiBaas, fund wallets"
```

---

### Task 4: core — types, units, ABI, hashing, approval + share typed data

**Files:**
- Create: `packages/core/src/types.ts`, `units.ts`, `abi.ts`, `hash.ts`, `approval.ts`, `share.ts`; modify `index.ts`
- Test: `packages/core/test/hash.test.ts`, `packages/core/test/approval.test.ts`

**Interfaces:**
- Produces:
  - Types in `types.ts` (below) used by every later task.
  - `yenToWei(yen: number): bigint`, `weiToYen(wei: bigint): number`
  - `voucherIface`, `settlementIface`, `erc20Iface` (ethers `Interface`)
  - `hashProposal(chainId: number, txs: UnsignedTx[]): string` (0x bytes32)
  - `approvalDomain(chainId)`, `APPROVAL_TYPES`, `verifyApproval(args): { ok: boolean; reason?: string }`
  - `shareDomain(chainId, settlement)`, `SHARE_TYPES`, `recoverShareSigner(args): string`

- [ ] **Step 1: Types and helpers (no behaviour to test yet)**

`packages/core/src/types.ts`:
```ts
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
```

`packages/core/src/units.ts`:
```ts
import { formatUnits, parseUnits } from 'ethers';
export const yenToWei = (yen: number): bigint => parseUnits(String(Math.trunc(yen)), 18);
export const weiToYen = (wei: bigint): number => Number(formatUnits(wei, 18));
```

`packages/core/src/abi.ts`:
```ts
import { Interface } from 'ethers';
export const voucherIface = new Interface([
  'function buyVoucher(uint256 eventId, uint256 quantity)',
  'function eventInfo(uint256 eventId) view returns (uint256 price, uint256 available, address stall)',
  'event VoucherPurchased(address indexed buyer, uint256 indexed eventId, uint256 quantity, address indexed stall, uint256 amount)',
]);
export const settlementIface = new Interface([
  'function settle(bytes32 billId, address from, address to, uint256 amount, uint256 deadline, bytes signature)',
  'event ShareSettled(bytes32 indexed billId, address indexed from, address indexed to, uint256 amount)',
]);
export const erc20Iface = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);
```

- [ ] **Step 2: Write the failing tests**

`packages/core/test/hash.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashProposal } from '../src/hash.ts';

const tx = { to: '0x000000000000000000000000000000000000dEaD', data: '0x1234', value: '0' };

test('hash is stable and address-case insensitive', () => {
  const a = hashProposal(11155111, [tx]);
  const b = hashProposal(11155111, [{ ...tx, to: tx.to.toLowerCase() }]);
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test('hash changes with chainId, data, order', () => {
  const tx2 = { ...tx, data: '0x5678' };
  const base = hashProposal(11155111, [tx, tx2]);
  assert.notEqual(base, hashProposal(1, [tx, tx2]));
  assert.notEqual(base, hashProposal(11155111, [tx2, tx]));
  assert.notEqual(base, hashProposal(11155111, [tx, { ...tx2, data: '0x5679' }]));
});
```

`packages/core/test/approval.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { APPROVAL_TYPES, approvalDomain, verifyApproval } from '../src/approval.ts';

const human = Wallet.createRandom();
const chainId = 11155111;
const hashA = '0x' + 'aa'.repeat(32);
const hashB = '0x' + 'bb'.repeat(32);
const now = 1_800_000_000;

async function sign(proposalHash: string, totalYen: number, expiresAt: number) {
  return human.signTypedData(approvalDomain(chainId), APPROVAL_TYPES, { proposalHash, totalYen, expiresAt });
}

test('accepts the human approval for the exact proposal', async () => {
  const signature = await sign(hashA, 2400, now + 600);
  assert.deepEqual(
    verifyApproval({ chainId, proposalHash: hashA, totalYen: 2400, expiresAt: now + 600, signature, approver: human.address, now }),
    { ok: true }
  );
});

test('verifyApproval rejects approval for another hash', async () => {
  const signature = await sign(hashA, 2400, now + 600);
  const r = verifyApproval({ chainId, proposalHash: hashB, totalYen: 2400, expiresAt: now + 600, signature, approver: human.address, now });
  assert.equal(r.ok, false);
});

test('rejects a changed total, an expired approval, and a different signer', async () => {
  const signature = await sign(hashA, 2400, now + 600);
  assert.equal(verifyApproval({ chainId, proposalHash: hashA, totalYen: 9999, expiresAt: now + 600, signature, approver: human.address, now }).ok, false);
  const old = await sign(hashA, 2400, now - 1);
  assert.equal(verifyApproval({ chainId, proposalHash: hashA, totalYen: 2400, expiresAt: now - 1, signature: old, approver: human.address, now }).reason, 'Approval expired');
  assert.equal(verifyApproval({ chainId, proposalHash: hashA, totalYen: 2400, expiresAt: now + 600, signature, approver: Wallet.createRandom().address, now }).ok, false);
});

test('garbage signature is a rejection, not a throw', () => {
  const r = verifyApproval({ chainId, proposalHash: hashA, totalYen: 1, expiresAt: now + 1, signature: '0xdead', approver: human.address, now });
  assert.equal(r.ok, false);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -w packages/core`
Expected: FAIL — `Cannot find module '../src/hash.ts'`.

- [ ] **Step 4: Implement**

`packages/core/src/hash.ts`:
```ts
import { AbiCoder, getAddress, keccak256 } from 'ethers';
import type { UnsignedTx } from './types.ts';

// Nonce and gas are deliberately excluded: the signer sets them; what the human approves is to/data/value.
export function hashProposal(chainId: number, txs: UnsignedTx[]): string {
  return keccak256(
    AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'tuple(address to, bytes data, uint256 value)[]'],
      [chainId, txs.map((t) => ({ to: getAddress(t.to), data: t.data, value: BigInt(t.value) }))]
    )
  );
}
```

`packages/core/src/approval.ts`:
```ts
import { getAddress, verifyTypedData } from 'ethers';

export const APPROVAL_TYPES = {
  Approval: [
    { name: 'proposalHash', type: 'bytes32' },
    { name: 'totalYen', type: 'uint256' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};
export const approvalDomain = (chainId: number) => ({ name: 'Matsuri Concierge', version: '1', chainId });

export function verifyApproval(a: {
  chainId: number; proposalHash: string; totalYen: number; expiresAt: number;
  signature: string; approver: string; now?: number;
}): { ok: boolean; reason?: string } {
  const now = a.now ?? Math.floor(Date.now() / 1000);
  if (a.expiresAt <= now) return { ok: false, reason: 'Approval expired' };
  let recovered: string;
  try {
    recovered = verifyTypedData(approvalDomain(a.chainId), APPROVAL_TYPES,
      { proposalHash: a.proposalHash, totalYen: a.totalYen, expiresAt: a.expiresAt }, a.signature);
  } catch {
    return { ok: false, reason: 'Unreadable approval signature' };
  }
  if (getAddress(recovered) !== getAddress(a.approver)) return { ok: false, reason: 'Approval not signed by the approver wallet' };
  return { ok: true };
}
```

`packages/core/src/share.ts`:
```ts
import { verifyTypedData } from 'ethers';

export const SHARE_TYPES = {
  Share: [
    { name: 'billId', type: 'bytes32' },
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};
export const shareDomain = (chainId: number, verifyingContract: string) =>
  ({ name: 'KanjoSettlement', version: '1', chainId, verifyingContract });

export interface ShareMessage { billId: string; from: string; to: string; amount: bigint; deadline: bigint; }

export function recoverShareSigner(chainId: number, settlement: string, share: ShareMessage, signature: string): string {
  return verifyTypedData(shareDomain(chainId, settlement), SHARE_TYPES, share, signature);
}
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0';
export * from './types.ts';
export * from './units.ts';
export * from './abi.ts';
export * from './hash.ts';
export * from './approval.ts';
export * from './share.ts';
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -w packages/core`
Expected: all pass (7 tests).

- [ ] **Step 6: Commit**
```bash
git add packages/core && git commit -m "feat(core): proposal hashing and EIP-712 approval/share typed data"
```

---

### Task 5: core — risk mapping and policy engine

**Files:**
- Create: `packages/core/src/risk.ts`, `packages/core/src/policy.ts`; export both from `index.ts`
- Test: `packages/core/test/risk.test.ts`, `packages/core/test/policy.test.ts`

**Interfaces:**
- Consumes: types from Task 4.
- Produces:
  - `assessRisk(s: Screening, cfg: RiskConfig): RiskAssessment`
  - `evaluateOrder(input: { lines: OrderLine[]; stalls: Stall[]; risk: Record<string, RiskAssessment>; spentTodayYen: number; cfg: PolicyConfig }): OrderDecision` — `risk` keys are lowercase addresses.
  - `evaluateTransfer(input: { to: string; amountYen: number; risk: RiskAssessment; spentTodayYen: number; cfg: PolicyConfig }): TransferDecision`

- [ ] **Step 1: Write failing tests**

`packages/core/test/risk.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../src/risk.ts';

const cfg = { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['sanction_address', 'known_scammer'] };
const ok = (toxicScore: number, traits: any[] = []) => ({ address: '0xa', ok: true, result: { toxicScore, traits }, fetchedAt: 'now' });

test('clean address pays', () => assert.equal(assessRisk(ok(3), cfg).action, 'PAY'));
test('score bands map to CAP / ASK / REFUSE', () => {
  assert.equal(assessRisk(ok(15), cfg).action, 'CAP');
  assert.equal(assessRisk(ok(40), cfg).action, 'ASK');
  assert.equal(assessRisk(ok(70), cfg).action, 'REFUSE');
});
test('a hard trait refuses even at a low score and carries the description', () => {
  const r = assessRisk(ok(5, [{ risk: 90, name: 'sanction_address', txsCount: 1, description: 'Sanctioned by OFAC' }]), cfg);
  assert.deepEqual([r.action, r.reasons], ['REFUSE', ['Sanctioned by OFAC']]);
});
test('screening failure fails closed to ASK', () => {
  const r = assessRisk({ address: '0xa', ok: false, error: 'HTTP 503', fetchedAt: 'now' }, cfg);
  assert.equal(r.action, 'ASK');
  assert.match(r.reasons[0], /HTTP 503/);
});
```

`packages/core/test/policy.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrder, evaluateTransfer } from '../src/policy.ts';
import type { PolicyConfig, RiskAssessment, Stall } from '../src/types.ts';

const cfg: PolicyConfig = {
  maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: [] },
};
const stall = (itemId: number, priceYen: number, payTo: string, available = 100): Stall =>
  ({ itemId, name: `S${itemId}`, item: 'x', emoji: '', priceYen, available, payTo });
const stalls = [stall(1, 600, '0xA1'), stall(2, 700, '0xA2'), stall(5, 300, '0xA5'), stall(4, 500, '0xA4')];
const pay: RiskAssessment = { action: 'PAY', score: 1, reasons: [] };
const risk: Record<string, RiskAssessment> = {
  '0xa1': pay, '0xa2': pay,
  '0xa5': { action: 'REFUSE', score: 95, reasons: ['Known scammer'] },
  '0xa4': { action: 'CAP', score: 20, reasons: ['Mixer transfers'] },
};
const run = (lines: any[], spentTodayYen = 0) => evaluateOrder({ lines, stalls, risk, spentTodayYen, cfg });

test('clean small order pays without approval', () => {
  const d = run([{ itemId: 1, quantity: 1 }]);
  assert.deepEqual([d.lines[0].action, d.totalYen, d.requiresApproval], ['PAY', 600, false]);
});
test('order at or above the threshold needs approval', () => {
  const d = run([{ itemId: 1, quantity: 1 }, { itemId: 2, quantity: 1 }]);
  assert.equal(d.totalYen, 1300);
  assert.equal(d.requiresApproval, true);
});
test('flagged stall is refused with Intercepta reason and excluded from total', () => {
  const d = run([{ itemId: 5, quantity: 2 }, { itemId: 1, quantity: 1 }]);
  const flagged = d.lines.find((l) => l.itemId === 5)!;
  assert.deepEqual([flagged.action, flagged.qty, flagged.reasons], ['REFUSE', 0, ['Known scammer']]);
  assert.equal(d.totalYen, 600);
});
test('CAP risk halves quantity', () => {
  const l = run([{ itemId: 4, quantity: 2 }]).lines[0];
  assert.deepEqual([l.action, l.qty], ['CAP', 1]);
});
test('per-stall cap trims quantity', () => {
  const l = run([{ itemId: 2, quantity: 3 }]).lines[0]; // 2100 > 1500 → 2 x 700
  assert.deepEqual([l.action, l.qty, l.subtotalYen], ['CAP', 2, 1400]);
});
test('duplicate lines are merged before caps apply', () => {
  const d = run([{ itemId: 2, quantity: 2 }, { itemId: 2, quantity: 2 }]);
  assert.equal(d.lines.length, 1);
  assert.deepEqual([d.lines[0].requestedQty, d.lines[0].qty], [4, 2]);
});
test('unknown stall, sold out, and bad quantities are refused', () => {
  assert.equal(run([{ itemId: 99, quantity: 1 }]).lines[0].action, 'REFUSE');
  assert.equal(evaluateOrder({ lines: [{ itemId: 1, quantity: 5 }], stalls: [stall(1, 600, '0xA1', 2)], risk, spentTodayYen: 0, cfg }).lines[0].action, 'REFUSE');
  assert.equal(run([{ itemId: 1, quantity: 0 }]).lines[0].action, 'REFUSE');
  assert.equal(run([{ itemId: 1, quantity: 1.5 }]).lines[0].action, 'REFUSE');
});
test('missing screening becomes ASK and forces approval', () => {
  const d = evaluateOrder({ lines: [{ itemId: 1, quantity: 1 }], stalls, risk: {}, spentTodayYen: 0, cfg });
  assert.deepEqual([d.lines[0].action, d.requiresApproval], ['ASK', true]);
});
test('over the remaining daily budget refuses everything', () => {
  const d = run([{ itemId: 1, quantity: 2 }], 4000);
  assert.equal(d.refusedAll, true);
  assert.ok(d.lines.every((l) => l.action === 'REFUSE'));
  assert.equal(d.totalYen, 0);
});
test('transfer to a flagged friend is refused; clean big transfer needs approval', () => {
  assert.equal(evaluateTransfer({ to: '0xA5', amountYen: 700, risk: risk['0xa5'], spentTodayYen: 0, cfg }).action, 'REFUSE');
  const t = evaluateTransfer({ to: '0xA1', amountYen: 1200, risk: pay, spentTodayYen: 0, cfg });
  assert.deepEqual([t.action, t.requiresApproval], ['PAY', true]);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w packages/core` → FAIL (`risk.ts` missing).

- [ ] **Step 3: Implement**

`packages/core/src/risk.ts`:
```ts
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
```

`packages/core/src/policy.ts`:
```ts
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
```
Add to `index.ts`: `export * from './risk.ts'; export * from './policy.ts';`

- [ ] **Step 4: Run to verify pass** — `npm test -w packages/core` → all pass.

- [ ] **Step 5: Commit**
```bash
git add packages/core && git commit -m "feat(core): deterministic risk mapping and order/transfer policy"
```

---

### Task 6: core — bill split + Intercepta client, and a live probe

**Files:**
- Create: `packages/core/src/split.ts`, `packages/core/src/intercepta.ts`, `packages/core/scripts/probe.ts`; export from `index.ts`
- Test: `packages/core/test/split.test.ts`, `packages/core/test/intercepta.test.ts`

**Interfaces:**
- Produces:
  - `splitBill(input: { organizer: string; participants: string[]; payments: { name: string; amountYen: number }[] }): { totalYen: number; shares: Record<string, number>; transfers: { from: string; to: string; amountYen: number }[] }` — hub model: debtors pay the organizer; the organizer pays creditors.
  - `quickScan(address: string, opts: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchImpl?: typeof fetch }): Promise<Screening>` — never throws.

- [ ] **Step 1: Failing tests**

`packages/core/test/split.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitBill } from '../src/split.ts';

test('hub split: friends pay the organizer, organizer pays the other payer', () => {
  const r = splitBill({
    organizer: 'You', participants: ['You', 'Aoi', 'Mei', 'Ken'],
    payments: [{ name: 'You', amountYen: 2600 }, { name: 'Ken', amountYen: 1800 }],
  });
  assert.equal(r.totalYen, 4400);
  assert.deepEqual(r.shares, { You: 1100, Aoi: 1100, Mei: 1100, Ken: 1100 });
  assert.deepEqual(r.transfers, [
    { from: 'Aoi', to: 'You', amountYen: 1100 },
    { from: 'Mei', to: 'You', amountYen: 1100 },
    { from: 'You', to: 'Ken', amountYen: 700 },
  ]);
});

test('remainder yen go to the first participants, never lost', () => {
  const r = splitBill({ organizer: 'You', participants: ['You', 'Aoi', 'Mei'], payments: [{ name: 'You', amountYen: 1000 }] });
  assert.deepEqual(r.shares, { You: 334, Aoi: 333, Mei: 333 });
  assert.equal(Object.values(r.shares).reduce((a, b) => a + b, 0), 1000);
});

test('rejects payers who are not participants and non-integer yen', () => {
  assert.throws(() => splitBill({ organizer: 'You', participants: ['You'], payments: [{ name: 'X', amountYen: 1 }] }));
  assert.throws(() => splitBill({ organizer: 'You', participants: ['You', 'A'], payments: [{ name: 'You', amountYen: 1.5 }] }));
});
```

`packages/core/test/intercepta.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickScan } from '../src/intercepta.ts';

const addr = '0x0d775e010f0b6c32c9468d43ba599ef47d596e47';
const fakeFetch = (status: number, body: unknown) =>
  (async (url: string, init?: RequestInit) => {
    assert.match(String(url), /\/api\/public\/v2\/extension\/account\/0x0d77.*\/quick-scan$/);
    assert.equal((init?.headers as Record<string, string>)['X-API-KEY'], 'k');
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

test('parses a successful quick scan', async () => {
  const s = await quickScan(addr, { apiKey: 'k', fetchImpl: fakeFetch(200, { toxicScore: 88, traits: [{ risk: 90, name: 'known_scammer', txsCount: 3, description: 'Known scammer' }] }) });
  assert.equal(s.ok, true);
  assert.equal(s.result!.toxicScore, 88);
});

test('HTTP error, malformed body and network failure all return ok:false', async () => {
  assert.equal((await quickScan(addr, { apiKey: 'k', fetchImpl: fakeFetch(503, {}) })).ok, false);
  assert.equal((await quickScan(addr, { apiKey: 'k', fetchImpl: fakeFetch(200, { nope: 1 }) })).ok, false);
  const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
  const s = await quickScan(addr, { apiKey: 'k', fetchImpl: boom });
  assert.deepEqual([s.ok, s.error], [false, 'ECONNRESET']);
});

test('missing api key is ok:false without calling the network', async () => {
  const s = await quickScan(addr, { apiKey: '', fetchImpl: (async () => { throw new Error('should not call'); }) as unknown as typeof fetch });
  assert.deepEqual([s.ok, s.error], [false, 'INTERCEPTA_API_KEY not set']);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w packages/core` → FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/split.ts`:
```ts
export function splitBill(input: {
  organizer: string; participants: string[]; payments: { name: string; amountYen: number }[];
}) {
  const { organizer, participants } = input;
  if (!participants.includes(organizer)) throw new Error('Organizer must be a participant');
  for (const p of input.payments) {
    if (!participants.includes(p.name)) throw new Error(`${p.name} is not a participant`);
    if (!Number.isInteger(p.amountYen) || p.amountYen < 0) throw new Error('Payments must be whole yen');
  }
  const totalYen = input.payments.reduce((s, p) => s + p.amountYen, 0);
  const base = Math.floor(totalYen / participants.length);
  const remainder = totalYen - base * participants.length;
  const shares: Record<string, number> = {};
  participants.forEach((name, i) => { shares[name] = base + (i < remainder ? 1 : 0); });

  const paid: Record<string, number> = Object.fromEntries(participants.map((p) => [p, 0]));
  for (const p of input.payments) paid[p.name] += p.amountYen;

  const transfers: { from: string; to: string; amountYen: number }[] = [];
  for (const name of participants) {
    if (name === organizer) continue;
    const balance = paid[name] - shares[name];
    if (balance < 0) transfers.push({ from: name, to: organizer, amountYen: -balance });
  }
  for (const name of participants) {
    if (name === organizer) continue;
    const balance = paid[name] - shares[name];
    if (balance > 0) transfers.push({ from: organizer, to: name, amountYen: balance });
  }
  return { totalYen, shares, transfers };
}
```

`packages/core/src/intercepta.ts`:
```ts
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
```
Add to `index.ts`: `export * from './split.ts'; export * from './intercepta.ts';`

- [ ] **Step 4: Run to verify pass** — `npm test -w packages/core` → all pass.

- [ ] **Step 5: Live probe (needs the Intercepta key)**

`packages/core/scripts/probe.ts`:
```ts
import stalls from '../../../config/stalls.json' with { type: 'json' };
import policy from '../../../config/policy.json' with { type: 'json' };
import { assessRisk } from '../src/risk.ts';
import { quickScan } from '../src/intercepta.ts';

for (const s of stalls) {
  const scan = await quickScan(s.payTo, { apiKey: process.env.INTERCEPTA_API_KEY ?? '' });
  const risk = assessRisk(scan, policy.risk);
  console.log(`${s.name.padEnd(16)} intent=${s.intent.padEnd(11)} score=${scan.result?.toxicScore ?? '-'} → ${risk.action}  ${risk.reasons.join(' | ') || scan.error || ''}`);
}
```
Run: `INTERCEPTA_API_KEY=… node --import tsx packages/core/scripts/probe.ts`
Expected: stalls 1–3 → `PAY`, Kuro Yatai → `REFUSE` with a human-readable reason. If the bands don't match reality, adjust `config/policy.json` thresholds (not the code) and re-run. Paste the probe output into `FEEDBACK.md` notes (time-to-first-call etc.).

- [ ] **Step 6: Commit**
```bash
git add packages/core config && git commit -m "feat(core): hub bill split and fail-closed Intercepta quick scan"
```

---

### Task 7: api — env, store, event bus

**Files:**
- Create: `services/api/package.json`, `services/api/tsconfig.json`, `services/api/.env.example`, `services/api/src/env.ts`, `services/api/src/store.ts`, `services/api/src/events.ts`
- Test: `services/api/test/store.test.ts`, `services/api/test/no-keys.test.ts`

**Interfaces:**
- Produces:
  - `env` object: `{ port, chainId, mbBaseUrl, mbApiKey, interceptaKey, agentAddress, approverAddress, signerUrl, anthropicModel, agentEffort, publicBaseUrl, deployments }`
  - `openStore(path: string): Store` where
    ```ts
    interface ProposalRow { id: string; kind: ProposalKind; status: 'proposed'|'awaiting_approval'|'approved'|'executed'|'refused'|'held'|'failed';
      hash: string; totalYen: number; requiresApproval: boolean; decision: unknown; txs: UnsignedTx[];
      approval: ApprovalRecord | null; txHashes: string[]; meta: Record<string, unknown>; createdAt: string; }
    interface Store {
      insertProposal(p: Omit<ProposalRow,'createdAt'|'txHashes'|'approval'>): ProposalRow;
      getProposal(id: string): ProposalRow | null;
      setApproval(id: string, a: ApprovalRecord): void;
      setStatus(id: string, status: ProposalRow['status'], txHashes?: string[]): void;
      spentTodayYen(now?: Date): number;           // sum of executed order+transfer totals, local day
      listProposals(limit?: number): ProposalRow[];
      cacheScreening(s: Screening): void;
      getScreening(address: string, maxAgeMs: number): Screening | null;
      putBill(id: string, bill: unknown): void; getBill(id: string): unknown | null;
      markShare(billId: string, from: string): boolean; // false if already marked (dedupe)
    }
    ```
  - `bus.emit(type: string, data: unknown)`, `bus.subscribe(fn): () => void`, `bus.recent(n)`.

- [ ] **Step 1: Manifests**

`services/api/package.json`:
```json
{
  "name": "@mc/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --env-file=.env --import tsx --watch src/server.ts",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.110.0",
    "@curvegrid/multibaas-sdk": "1.1.1",
    "@hono/node-server": "^1.14.0",
    "@mc/core": "*",
    "ethers": "6.17.0",
    "hono": "^4.9.0"
  }
}
```
`services/api/.env.example` (no wallet keys, by design):
```
PORT=8787
MB_BASE_URL=https://pijegreyazbslgm3qxb77bwjwu.multibaas.com
MB_API_KEY=            # DApp User key
INTERCEPTA_API_KEY=
ANTHROPIC_API_KEY=
AGENT_ADDRESS=         # public address of the signer's wallet
APPROVER_ADDRESS=      # the human's MetaMask address
SIGNER_URL=http://127.0.0.1:8788
PUBLIC_BASE_URL=http://localhost:8787
AGENT_MODEL=claude-opus-5
AGENT_EFFORT=medium
```

- [ ] **Step 2: Failing tests**

`services/api/test/store.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';

const base = { kind: 'order' as const, status: 'proposed' as const, hash: '0x1', totalYen: 1200,
  requiresApproval: true, decision: {}, txs: [], meta: {} };

test('proposal round trip, approval, status', () => {
  const s = openStore(':memory:');
  s.insertProposal({ id: 'p1', ...base });
  s.setApproval('p1', { signature: '0xsig', totalYen: 1200, expiresAt: 9 });
  s.setStatus('p1', 'executed', ['0xtx']);
  const p = s.getProposal('p1')!;
  assert.deepEqual([p.status, p.txHashes, p.approval?.signature], ['executed', ['0xtx'], '0xsig']);
});

test('spentTodayYen counts only executed orders and transfers', () => {
  const s = openStore(':memory:');
  s.insertProposal({ id: 'a', ...base, totalYen: 600 }); s.setStatus('a', 'executed');
  s.insertProposal({ id: 'b', ...base, totalYen: 900 });
  s.insertProposal({ id: 'c', ...base, kind: 'settle', totalYen: 1100 }); s.setStatus('c', 'executed');
  assert.equal(s.spentTodayYen(), 600);
});

test('screening cache respects max age and share dedupe works once', () => {
  const s = openStore(':memory:');
  s.cacheScreening({ address: '0xAbC', ok: true, result: { toxicScore: 1, traits: [] }, fetchedAt: new Date().toISOString() });
  assert.equal(s.getScreening('0xabc', 60_000)?.ok, true);
  assert.equal(s.getScreening('0xabc', -1), null);
  assert.equal(s.markShare('bill', '0xF'), true);
  assert.equal(s.markShare('bill', '0xf'), false);
});
```

`services/api/test/no-keys.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

test('the agent service never touches a wallet private key', () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /PRIVATE_KEY|new Wallet\(|signTransaction/, `${f} must not hold keys`);
  }
});
```

- [ ] **Step 3: Run to verify failure** — `npm install && npm test -w services/api` → FAIL.

- [ ] **Step 4: Implement**

`services/api/src/env.ts`:
```ts
import { readFileSync } from 'node:fs';
import type { Deployments } from '@mc/core';

const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
const deployments = JSON.parse(readFileSync(new URL('../../../deployments.json', import.meta.url), 'utf8')) as Deployments;

export const env = {
  port: Number(process.env.PORT ?? 8787),
  chainId: deployments.chainId,
  deployments,
  mbBaseUrl: need('MB_BASE_URL'),
  mbApiKey: need('MB_API_KEY'),
  interceptaKey: process.env.INTERCEPTA_API_KEY ?? '',
  agentAddress: need('AGENT_ADDRESS'),
  approverAddress: need('APPROVER_ADDRESS'),
  signerUrl: process.env.SIGNER_URL ?? 'http://127.0.0.1:8788',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:8787',
  anthropicModel: process.env.AGENT_MODEL ?? 'claude-opus-5',
  agentEffort: (process.env.AGENT_EFFORT ?? 'medium') as 'low' | 'medium' | 'high',
};
```

`services/api/src/store.ts`:
```ts
import { DatabaseSync } from 'node:sqlite';
import type { ApprovalRecord, ProposalKind, Screening, UnsignedTx } from '@mc/core';

export type ProposalStatus = 'proposed' | 'awaiting_approval' | 'approved' | 'executed' | 'refused' | 'held' | 'failed';
export interface ProposalRow {
  id: string; kind: ProposalKind; status: ProposalStatus; hash: string; totalYen: number;
  requiresApproval: boolean; decision: unknown; txs: UnsignedTx[]; approval: ApprovalRecord | null;
  txHashes: string[]; meta: Record<string, unknown>; createdAt: string;
}
export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, kind TEXT, status TEXT, hash TEXT, total_yen INTEGER,
      requires_approval INTEGER, decision TEXT, txs TEXT, approval TEXT, tx_hashes TEXT, meta TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS screenings (address TEXT PRIMARY KEY, body TEXT, fetched_at TEXT);
    CREATE TABLE IF NOT EXISTS bills (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE IF NOT EXISTS shares (bill_id TEXT, payer TEXT, PRIMARY KEY (bill_id, payer));
  `);
  const row = (r: any): ProposalRow => ({
    id: r.id, kind: r.kind, status: r.status, hash: r.hash, totalYen: r.total_yen,
    requiresApproval: !!r.requires_approval, decision: JSON.parse(r.decision), txs: JSON.parse(r.txs),
    approval: r.approval ? JSON.parse(r.approval) : null, txHashes: JSON.parse(r.tx_hashes), meta: JSON.parse(r.meta),
    createdAt: r.created_at,
  });
  return {
    insertProposal(p: Omit<ProposalRow, 'createdAt' | 'txHashes' | 'approval'>): ProposalRow {
      db.prepare(`INSERT INTO proposals VALUES (?,?,?,?,?,?,?,?,NULL,'[]',?,?)`).run(
        p.id, p.kind, p.status, p.hash, p.totalYen, p.requiresApproval ? 1 : 0,
        JSON.stringify(p.decision), JSON.stringify(p.txs), JSON.stringify(p.meta), new Date().toISOString());
      return this.getProposal(p.id)!;
    },
    getProposal(id: string): ProposalRow | null {
      const r = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
      return r ? row(r) : null;
    },
    setApproval(id: string, a: ApprovalRecord) {
      db.prepare(`UPDATE proposals SET approval = ?, status = 'approved' WHERE id = ?`).run(JSON.stringify(a), id);
    },
    setStatus(id: string, status: ProposalStatus, txHashes?: string[]) {
      if (txHashes) db.prepare('UPDATE proposals SET status = ?, tx_hashes = ? WHERE id = ?').run(status, JSON.stringify(txHashes), id);
      else db.prepare('UPDATE proposals SET status = ? WHERE id = ?').run(status, id);
    },
    spentTodayYen(now = new Date()): number {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const r = db.prepare(`SELECT COALESCE(SUM(total_yen),0) AS s FROM proposals
        WHERE status = 'executed' AND kind IN ('order','transfer') AND created_at >= ?`).get(start.toISOString()) as { s: number };
      return r.s;
    },
    listProposals(limit = 50): ProposalRow[] {
      return db.prepare('SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?').all(limit).map(row);
    },
    cacheScreening(s: Screening) {
      db.prepare('INSERT OR REPLACE INTO screenings VALUES (?,?,?)').run(s.address.toLowerCase(), JSON.stringify(s), s.fetchedAt);
    },
    getScreening(address: string, maxAgeMs: number): Screening | null {
      const r = db.prepare('SELECT body, fetched_at FROM screenings WHERE address = ?').get(address.toLowerCase()) as any;
      if (!r || Date.now() - Date.parse(r.fetched_at) > maxAgeMs) return null;
      return JSON.parse(r.body);
    },
    putBill(id: string, bill: unknown) { db.prepare('INSERT OR REPLACE INTO bills VALUES (?,?)').run(id, JSON.stringify(bill)); },
    getBill(id: string): unknown | null {
      const r = db.prepare('SELECT body FROM bills WHERE id = ?').get(id) as any;
      return r ? JSON.parse(r.body) : null;
    },
    markShare(billId: string, from: string): boolean {
      const r = db.prepare('INSERT OR IGNORE INTO shares VALUES (?,?)').run(billId, from.toLowerCase());
      return r.changes === 1;
    },
  };
}
```

`services/api/src/events.ts`:
```ts
export interface BusEvent { id: number; at: string; type: string; data: unknown; }
const listeners = new Set<(e: BusEvent) => void>();
const history: BusEvent[] = [];
let seq = 0;
export const bus = {
  emit(type: string, data: unknown) {
    const e = { id: ++seq, at: new Date().toISOString(), type, data };
    history.push(e); if (history.length > 500) history.shift();
    for (const l of listeners) l(e);
  },
  subscribe(fn: (e: BusEvent) => void) { listeners.add(fn); return () => listeners.delete(fn); },
  recent(n = 100) { return history.slice(-n); },
};
```

- [ ] **Step 5: Run to verify pass** — `npm test -w services/api` → 4 pass.

- [ ] **Step 6: Commit**
```bash
git add services/api && git commit -m "feat(api): keyless env, SQLite decision store, event bus"
```

---

### Task 8: api — MultiBaas client (stalls, unsigned txs, event queries) and screening cache

**Files:**
- Create: `services/api/src/multibaas.ts`, `services/api/src/screening.ts`
- Test: `services/api/test/multibaas.live.test.ts` (skipped unless `LIVE=1`)

**Interfaces:**
- Consumes: `env` (Task 7), `config/stalls.json`.
- Produces:
  - `createMb(baseUrl, apiKey)` returning:
    - `readStalls(): Promise<Stall[]>` (price/available/payTo from chain via `eventInfo`, names from config)
    - `composeBuy(itemId: number, qty: number, from: string): Promise<UnsignedTx>`
    - `composeTransfer(to: string, amountYen: number, from: string): Promise<UnsignedTx>`
    - `composeSettle(args: { billId: string; from: string; to: string; amountYen: number; deadline: number; signature: string }, sender: string): Promise<UnsignedTx>`
    - `purchases(limit?: number): Promise<{ buyer: string; itemId: number; quantity: number; stall: string; amountYen: number; txHash: string; at: string }[]>`
    - `settlements(limit?: number): Promise<{ billId: string; from: string; to: string; amountYen: number; txHash: string; at: string }[]>`
  - `createScreener(store, apiKey): (address: string) => Promise<Screening>` (10-minute cache; emits `screening` bus event)

- [ ] **Step 1: Implement MultiBaas wrapper** (thin I/O; verified live in Step 2)

`services/api/src/multibaas.ts`:
```ts
import * as MB from '@curvegrid/multibaas-sdk';
import { weiToYen, yenToWei, type Stall, type StallMeta, type UnsignedTx } from '@mc/core';
import stallsMeta from '../../../config/stalls.json' with { type: 'json' };

const ALIAS = { coin: 'mc_stablecoin', voucher: 'mc_voucher', settlement: 'mc_settlement' } as const;

export function createMb(baseUrl: string, apiKey: string) {
  const config = new MB.Configuration({ basePath: new URL('/api/v0', baseUrl).toString(), accessToken: apiKey });
  const contracts = new MB.ContractsApi(config);
  const queries = new MB.EventQueriesApi(config);

  async function call(alias: string, method: string, args: unknown[], from?: string) {
    const resp = await contracts.callContractFunction(alias, alias, method, {
      args, from, contractOverride: true, formatInts: 'as_strings',
    } as MB.PostMethodArgs);
    return resp.data.result as MB.CallContractFunction200ResponseAllOfResult & { output?: unknown; tx?: MB.TransactionToSignTx };
  }
  async function compose(alias: string, method: string, args: unknown[], from: string): Promise<UnsignedTx> {
    const r = await call(alias, method, args, from);
    if (!r?.tx?.to || !r.tx.data) throw new Error(`MultiBaas did not return a transaction for ${method}`);
    return { to: r.tx.to, data: r.tx.data, value: r.tx.value ?? '0' };
  }

  return {
    async readStalls(): Promise<Stall[]> {
      return Promise.all((stallsMeta as StallMeta[]).map(async (m) => {
        const r = await call(ALIAS.voucher, 'eventInfo', [m.itemId]);
        const [price, available, payTo] = r.output as [string, string, string];
        return { itemId: m.itemId, name: m.name, item: m.item, emoji: m.emoji,
          priceYen: weiToYen(BigInt(price)), available: Number(available), payTo };
      }));
    },
    composeBuy: (itemId: number, qty: number, from: string) => compose(ALIAS.voucher, 'buyVoucher', [itemId, qty], from),
    composeTransfer: (to: string, amountYen: number, from: string) =>
      compose(ALIAS.coin, 'transfer', [to, yenToWei(amountYen).toString()], from),
    composeSettle: (a: { billId: string; from: string; to: string; amountYen: number; deadline: number; signature: string }, sender: string) =>
      compose(ALIAS.settlement, 'settle', [a.billId, a.from, a.to, yenToWei(a.amountYen).toString(), a.deadline, a.signature], sender),

    async purchases(limit = 50) {
      const q: MB.EventQuery = {
        events: [{
          eventName: 'VoucherPurchased(address,uint256,uint256,address,uint256)',
          select: [
            { type: 'input', inputIndex: 0, alias: 'buyer' }, { type: 'input', inputIndex: 1, alias: 'itemId' },
            { type: 'input', inputIndex: 2, alias: 'quantity' }, { type: 'input', inputIndex: 3, alias: 'stall' },
            { type: 'input', inputIndex: 4, alias: 'amount' }, { type: 'tx_hash', alias: 'txhash' },
            { type: 'triggered_at', alias: 'at' },
          ],
          filter: { fieldType: 'contract_address_alias', operator: 'equal', value: ALIAS.voucher },
        }],
        orderBy: 'at', order: 'DESC',
      } as MB.EventQuery;
      const rows = ((await queries.executeArbitraryEventQuery(q, 0, limit)).data.result?.rows ?? []) as any[];
      return rows.map((r) => ({ buyer: r.buyer, itemId: Number(r.itemid ?? r.itemId), quantity: Number(r.quantity),
        stall: r.stall, amountYen: weiToYen(BigInt(r.amount)), txHash: r.txhash, at: r.at }));
    },
    async settlements(limit = 50) {
      const q: MB.EventQuery = {
        events: [{
          eventName: 'ShareSettled(bytes32,address,address,uint256)',
          select: [
            { type: 'input', inputIndex: 0, alias: 'billId' }, { type: 'input', inputIndex: 1, alias: 'from' },
            { type: 'input', inputIndex: 2, alias: 'to' }, { type: 'input', inputIndex: 3, alias: 'amount' },
            { type: 'tx_hash', alias: 'txhash' }, { type: 'triggered_at', alias: 'at' },
          ],
          filter: { fieldType: 'contract_address_alias', operator: 'equal', value: ALIAS.settlement },
        }],
        orderBy: 'at', order: 'DESC',
      } as MB.EventQuery;
      const rows = ((await queries.executeArbitraryEventQuery(q, 0, limit)).data.result?.rows ?? []) as any[];
      return rows.map((r) => ({ billId: r.billid ?? r.billId, from: r.from, to: r.to,
        amountYen: weiToYen(BigInt(r.amount)), txHash: r.txhash, at: r.at }));
    },
  };
}
export type Mb = ReturnType<typeof createMb>;
```
Note: the sample used bare `eventName: 'VoucherPurchased'`; if MultiBaas rejects the full signature form, fall back to the bare name. MultiBaas lower-cases row aliases, hence `r.itemid ?? r.itemId`.

`services/api/src/screening.ts`:
```ts
import { quickScan, type Screening } from '@mc/core';
import type { Store } from './store.ts';
import { bus } from './events.ts';

export function createScreener(store: Store, apiKey: string) {
  return async (address: string): Promise<Screening> => {
    const cached = store.getScreening(address, 10 * 60_000);
    if (cached) return cached;
    const s = await quickScan(address, { apiKey });
    if (s.ok) store.cacheScreening(s);
    bus.emit('screening', { address, ok: s.ok, toxicScore: s.result?.toxicScore ?? null,
      traits: s.result?.traits.map((t) => t.description || t.name) ?? [], error: s.error });
    return s;
  };
}
export type Screener = ReturnType<typeof createScreener>;
```

- [ ] **Step 2: Live check**

`services/api/test/multibaas.live.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMb } from '../src/multibaas.ts';

test('reads stalls and composes an unsigned buy', { skip: process.env.LIVE !== '1' }, async () => {
  const mb = createMb(process.env.MB_BASE_URL!, process.env.MB_API_KEY!);
  const stalls = await mb.readStalls();
  assert.equal(stalls.length, 5);
  assert.equal(stalls[0].priceYen, 600);
  const tx = await mb.composeBuy(1, 1, process.env.AGENT_ADDRESS!);
  assert.match(tx.data, /^0x/);
});
```
Run: `cd services/api && LIVE=1 node --env-file=.env --import tsx --test test/multibaas.live.test.ts`
Expected: PASS. If `composeBuy` fails with an estimation revert, the agent wallet's allowance is not set yet: run Task 10 Step 5 (`setup:allowance`) first, then re-run.

- [ ] **Step 3: Commit**
```bash
git add services/api && git commit -m "feat(api): MultiBaas stall reads, unsigned tx composition, event queries, cached screening"
```

---

### Task 9: api — proposal service

**Files:**
- Create: `services/api/src/proposals.ts`, `services/api/src/signerClient.ts`
- Test: `services/api/test/proposals.test.ts`

**Interfaces:**
- Consumes: `Mb`, `Screener`, `Store`, `bus`, core `evaluateOrder` / `evaluateTransfer` / `assessRisk` / `hashProposal` / `verifyApproval`.
- Produces:
  ```ts
  interface Deps { mb: Pick<Mb,'readStalls'|'composeBuy'|'composeTransfer'>; screen: Screener; store: Store;
    policy: PolicyConfig; chainId: number; agentAddress: string; approverAddress: string; publicBaseUrl: string;
    signer: { sign(id: string): Promise<{ txHashes: string[] }> }; }
  proposeOrder(d: Deps, lines: OrderLine[]): Promise<ProposalView>
  proposeTransfer(d: Deps, a: { to: string; amountYen: number; memo: string }): Promise<ProposalView>
  recordApproval(d: Deps, id: string, a: ApprovalRecord): { ok: boolean; reason?: string }
  execute(d: Deps, id: string): Promise<{ status: ProposalStatus; txHashes?: string[]; reason?: string }>
  type ProposalView = { proposalId: string; kind: ProposalKind; status: ProposalStatus; totalYen: number;
    requiresApproval: boolean; approvalReasons: string[]; approvalUrl: string | null; hash: string; decision: unknown }
  ```
  - `createSignerClient(url): { sign(id) }` → `POST {url}/sign {proposalId}`.

- [ ] **Step 1: Failing tests** (fakes for mb/screen/signer; real store + core)

`services/api/test/proposals.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { APPROVAL_TYPES, approvalDomain, type PolicyConfig } from '@mc/core';
import { openStore } from '../src/store.ts';
import { execute, proposeOrder, proposeTransfer, recordApproval } from '../src/proposals.ts';

const policy: PolicyConfig = { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } };
const human = Wallet.createRandom();
const stalls = [
  { itemId: 1, name: 'Takoyaki', item: 't', emoji: '', priceYen: 600, available: 9, payTo: '0x00000000000000000000000000000000000000a1' },
  { itemId: 5, name: 'Kuro', item: 'k', emoji: '', priceYen: 300, available: 9, payTo: '0x00000000000000000000000000000000000000a5' },
];
function deps(signed: string[] = []) {
  return {
    mb: {
      readStalls: async () => stalls,
      composeBuy: async (itemId: number, qty: number) => ({ to: '0x00000000000000000000000000000000000000b0', data: `0x0${itemId}0${qty}`, value: '0' }),
      composeTransfer: async () => ({ to: '0x00000000000000000000000000000000000000c0', data: '0xfeed', value: '0' }),
    },
    screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now',
      result: address.endsWith('a5') ? { toxicScore: 90, traits: [{ risk: 90, name: 'known_scammer', txsCount: 2, description: 'Known scammer' }] }
                                     : { toxicScore: 2, traits: [] } }),
    store: openStore(':memory:'), policy, chainId: 11155111,
    agentAddress: '0x00000000000000000000000000000000000000ee', approverAddress: human.address,
    publicBaseUrl: 'http://x',
    signer: { sign: async (id: string) => { signed.push(id); return { txHashes: ['0xhash'] }; } },
  };
}

test('small clean order executes without approval', async () => {
  const signed: string[] = []; const d = deps(signed);
  const v = await proposeOrder(d, [{ itemId: 1, quantity: 1 }]);
  assert.deepEqual([v.status, v.requiresApproval], ['proposed', false]);
  assert.equal((await execute(d, v.proposalId)).status, 'executed');
  assert.deepEqual(signed, [v.proposalId]);
});

test('flagged stall is dropped; its tx is never composed', async () => {
  const d = deps();
  const v = await proposeOrder(d, [{ itemId: 5, quantity: 2 }, { itemId: 1, quantity: 1 }]);
  const row = d.store.getProposal(v.proposalId)!;
  assert.equal(row.txs.length, 1);
  assert.equal(v.totalYen, 600);
});

test('big order waits for a valid human approval bound to its hash', async () => {
  const d = deps();
  const v = await proposeOrder(d, [{ itemId: 1, quantity: 2 }]);
  assert.equal(v.status, 'awaiting_approval');
  assert.equal((await execute(d, v.proposalId)).status, 'awaiting_approval');
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const bad = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES, { proposalHash: '0x' + '00'.repeat(32), totalYen: 1200, expiresAt });
  assert.equal(recordApproval(d, v.proposalId, { signature: bad, totalYen: 1200, expiresAt }).ok, false);
  const good = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES, { proposalHash: v.hash, totalYen: 1200, expiresAt });
  assert.equal(recordApproval(d, v.proposalId, { signature: good, totalYen: 1200, expiresAt }).ok, true);
  assert.equal((await execute(d, v.proposalId)).status, 'executed');
});

test('all-refused order is refused and cannot execute', async () => {
  const d = deps();
  const v = await proposeOrder(d, [{ itemId: 5, quantity: 1 }]);
  assert.equal(v.status, 'refused');
  assert.equal((await execute(d, v.proposalId)).status, 'refused');
});

test('transfer to a flagged friend agent is held', async () => {
  const d = deps();
  const v = await proposeTransfer(d, { to: stalls[1].payTo, amountYen: 700, memo: 'Ken drinks' });
  assert.equal(v.status, 'held');
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w services/api` → FAIL.

- [ ] **Step 3: Implement**

`services/api/src/signerClient.ts`:
```ts
export function createSignerClient(url: string) {
  return {
    async sign(proposalId: string): Promise<{ txHashes: string[] }> {
      const res = await fetch(`${url}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposalId }) });
      const body = await res.json() as { txHashes?: string[]; error?: string };
      if (!res.ok || !body.txHashes) throw new Error(body.error ?? `signer HTTP ${res.status}`);
      return { txHashes: body.txHashes };
    },
  };
}
```

`services/api/src/proposals.ts`:
```ts
import { randomUUID } from 'node:crypto';
import {
  assessRisk, evaluateOrder, evaluateTransfer, hashProposal, verifyApproval,
  type ApprovalRecord, type OrderLine, type PolicyConfig, type ProposalKind, type RiskAssessment,
} from '@mc/core';
import type { Mb } from './multibaas.ts';
import type { Screener } from './screening.ts';
import type { ProposalStatus, Store } from './store.ts';
import { bus } from './events.ts';

export interface Deps {
  mb: Pick<Mb, 'readStalls' | 'composeBuy' | 'composeTransfer'>; screen: Screener; store: Store;
  policy: PolicyConfig; chainId: number; agentAddress: string; approverAddress: string; publicBaseUrl: string;
  signer: { sign(id: string): Promise<{ txHashes: string[] }> };
}
export interface ProposalView {
  proposalId: string; kind: ProposalKind; status: ProposalStatus; totalYen: number; requiresApproval: boolean;
  approvalReasons: string[]; approvalUrl: string | null; hash: string; decision: unknown;
}

function view(d: Deps, id: string): ProposalView {
  const p = d.store.getProposal(id)!;
  const dec = p.decision as { approvalReasons?: string[] };
  return { proposalId: p.id, kind: p.kind, status: p.status, totalYen: p.totalYen, requiresApproval: p.requiresApproval,
    approvalReasons: dec.approvalReasons ?? [], hash: p.hash, decision: p.decision,
    approvalUrl: p.status === 'awaiting_approval' ? `${d.publicBaseUrl.replace(':8787', ':5180')}/approve/${p.id}` : null };
}

export async function proposeOrder(d: Deps, lines: OrderLine[]): Promise<ProposalView> {
  const stalls = await d.mb.readStalls();
  const wanted = new Set(lines.map((l) => l.itemId));
  const risk: Record<string, RiskAssessment> = {};
  await Promise.all(stalls.filter((s) => wanted.has(s.itemId)).map(async (s) => {
    risk[s.payTo.toLowerCase()] = assessRisk(await d.screen(s.payTo), d.policy.risk);
  }));
  const decision = evaluateOrder({ lines, stalls, risk, spentTodayYen: d.store.spentTodayYen(), cfg: d.policy });
  const payable = decision.lines.filter((l) => l.action !== 'REFUSE');
  const txs = [];
  for (const l of payable) txs.push(await d.mb.composeBuy(l.itemId, l.qty, d.agentAddress));
  const status: ProposalStatus = decision.refusedAll ? 'refused' : decision.requiresApproval ? 'awaiting_approval' : 'proposed';
  const id = randomUUID();
  d.store.insertProposal({ id, kind: 'order', status, hash: hashProposal(d.chainId, txs), totalYen: decision.totalYen,
    requiresApproval: decision.requiresApproval, decision, txs, meta: { lines } });
  bus.emit('proposal', view(d, id));
  return view(d, id);
}

export async function proposeTransfer(d: Deps, a: { to: string; amountYen: number; memo: string }): Promise<ProposalView> {
  const risk = assessRisk(await d.screen(a.to), d.policy.risk);
  const decision = evaluateTransfer({ to: a.to, amountYen: a.amountYen, risk, spentTodayYen: d.store.spentTodayYen(), cfg: d.policy });
  const txs = decision.action === 'REFUSE' ? [] : [await d.mb.composeTransfer(a.to, a.amountYen, d.agentAddress)];
  const status: ProposalStatus = decision.action === 'REFUSE' ? 'held' : decision.requiresApproval ? 'awaiting_approval' : 'proposed';
  const id = randomUUID();
  d.store.insertProposal({ id, kind: 'transfer', status, hash: hashProposal(d.chainId, txs),
    totalYen: decision.action === 'REFUSE' ? 0 : a.amountYen, requiresApproval: decision.requiresApproval,
    decision, txs, meta: { memo: a.memo } });
  bus.emit('proposal', view(d, id));
  return view(d, id);
}

export function recordApproval(d: Deps, id: string, a: ApprovalRecord) {
  const p = d.store.getProposal(id);
  if (!p) return { ok: false, reason: 'Unknown proposal' };
  if (p.status !== 'awaiting_approval') return { ok: false, reason: `Proposal is ${p.status}` };
  if (a.totalYen !== p.totalYen) return { ok: false, reason: 'Approved total does not match proposal' };
  const v = verifyApproval({ chainId: d.chainId, proposalHash: p.hash, totalYen: a.totalYen, expiresAt: a.expiresAt,
    signature: a.signature, approver: d.approverAddress });
  if (!v.ok) return v;
  d.store.setApproval(id, a);
  bus.emit('approval', { proposalId: id });
  return { ok: true };
}

export async function execute(d: Deps, id: string) {
  const p = d.store.getProposal(id);
  if (!p) return { status: 'failed' as ProposalStatus, reason: 'Unknown proposal' };
  if (p.status === 'refused' || p.status === 'held' || p.status === 'executed') return { status: p.status };
  if (p.requiresApproval && !p.approval) return { status: 'awaiting_approval' as ProposalStatus };
  try {
    const { txHashes } = await d.signer.sign(id);
    d.store.setStatus(id, 'executed', txHashes);
    bus.emit('executed', { proposalId: id, txHashes });
    return { status: 'executed' as ProposalStatus, txHashes };
  } catch (e) {
    d.store.setStatus(id, 'failed');
    bus.emit('signer_refused', { proposalId: id, reason: (e as Error).message });
    return { status: 'failed' as ProposalStatus, reason: (e as Error).message };
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -w services/api` → all pass.

- [ ] **Step 5: Commit**
```bash
git add services/api && git commit -m "feat(api): propose/approve/execute orders and transfers through the policy"
```

---

### Task 10: signer — independent verification, then sign

**Files:**
- Create: `services/signer/package.json`, `.env.example`, `src/env.ts`, `src/chain.ts`, `src/verify.ts`, `src/server.ts`, `src/setupAllowance.ts`
- Test: `services/signer/test/verify.test.ts`

**Interfaces:**
- Consumes: core (`hashProposal`, `verifyApproval`, `evaluateOrder`, `evaluateTransfer`, `assessRisk`, `quickScan`, ifaces, `recoverShareSigner`, `weiToYen`), api internal endpoint `GET {API_URL}/internal/proposals/:id` → `ProposalForSigner` (Task 12).
- Produces:
  - `verifyForSigning(p: ProposalForSigner, ctx: VerifyCtx): Promise<{ ok: true } | { ok: false; reason: string }>` where
    ```ts
    interface VerifyCtx { deployments: Deployments; policy: PolicyConfig; approver: string; agentAddress: string;
      readItem(itemId: number): Promise<{ priceYen: number; available: number; payTo: string }>;
      screen(address: string): Promise<Screening>; spentTodayYen: number; now?: number; }
    ```
  - HTTP `POST /sign {proposalId}` → `{ txHashes }` or `4xx { error }`.

- [ ] **Step 1: Failing tests**

`services/signer/test/verify.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { APPROVAL_TYPES, approvalDomain, erc20Iface, hashProposal, voucherIface, type PolicyConfig } from '@mc/core';
import { verifyForSigning } from '../src/verify.ts';

const deployments = { chainId: 11155111, stablecoin: '0x00000000000000000000000000000000000000c0',
  voucher: '0x00000000000000000000000000000000000000b0', settlement: '0x00000000000000000000000000000000000000d0' };
const policy: PolicyConfig = { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
  risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } };
const human = Wallet.createRandom();
const items: Record<number, { priceYen: number; available: number; payTo: string }> = {
  1: { priceYen: 600, available: 9, payTo: '0x00000000000000000000000000000000000000a1' },
  5: { priceYen: 300, available: 9, payTo: '0x00000000000000000000000000000000000000a5' },
};
const ctx = {
  deployments, policy, approver: human.address, agentAddress: '0x00000000000000000000000000000000000000ee', spentTodayYen: 0,
  readItem: async (id: number) => items[id],
  screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now',
    result: address.endsWith('a5') ? { toxicScore: 95, traits: [{ risk: 95, name: 'known_scammer', txsCount: 1, description: 'Known scammer' }] }
                                   : { toxicScore: 1, traits: [] } }),
};
const buy = (itemId: number, qty: number) => ({ to: deployments.voucher, data: voucherIface.encodeFunctionData('buyVoucher', [itemId, qty]), value: '0' });
const order = (txs: any[], approval: any = null) => ({ id: 'p', kind: 'order' as const, chainId: 11155111, txs, approval });

test('clean small order passes', async () => {
  assert.deepEqual(await verifyForSigning(order([buy(1, 1)]), ctx), { ok: true });
});

test('rejects tx to non-allowlisted contract', async () => {
  const r = await verifyForSigning(order([{ ...buy(1, 1), to: '0x00000000000000000000000000000000000000ff' }]), ctx);
  assert.equal(r.ok, false);
});

test('rejects an unexpected selector on an allowlisted contract', async () => {
  const data = erc20Iface.encodeFunctionData('approve', [human.address, 10n ** 30n]);
  const r = await verifyForSigning(order([{ to: deployments.voucher, data, value: '0' }]), ctx);
  assert.equal(r.ok, false);
});

test('re-screens the stall itself and refuses a flagged payTo even if the api let it through', async () => {
  const r = await verifyForSigning(order([buy(5, 1)]), ctx);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /Known scammer/);
});

test('refuses quantities the policy would have capped', async () => {
  assert.equal((await verifyForSigning(order([buy(1, 3)]), ctx)).ok, false); // 1800 > 1500 per stall
});

test('big order needs a signature over the hash the signer computes', async () => {
  const txs = [buy(1, 2)];
  assert.equal((await verifyForSigning(order(txs), ctx)).ok, false);
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const signature = await human.signTypedData(approvalDomain(11155111), APPROVAL_TYPES,
    { proposalHash: hashProposal(11155111, txs), totalYen: 1200, expiresAt });
  assert.deepEqual(await verifyForSigning(order(txs, { signature, totalYen: 1200, expiresAt }), ctx), { ok: true });
  const other = [buy(1, 1), buy(1, 1)];
  assert.equal((await verifyForSigning(order(other, { signature, totalYen: 1200, expiresAt }), ctx)).ok, false);
});

test('transfer to flagged recipient is refused', async () => {
  const data = erc20Iface.encodeFunctionData('transfer', [items[5].payTo, 700n * 10n ** 18n]);
  const r = await verifyForSigning({ id: 't', kind: 'transfer', chainId: 11155111, txs: [{ to: deployments.stablecoin, data, value: '0' }], approval: null }, ctx);
  assert.equal(r.ok, false);
});
```

- [ ] **Step 2: Run to verify failure** — `npm install && npm test -w services/signer` → FAIL.

- [ ] **Step 3: Implement**

`services/signer/package.json`:
```json
{
  "name": "@mc/signer",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --env-file=.env --import tsx src/server.ts",
    "setup:allowance": "node --env-file=.env --import tsx src/setupAllowance.ts",
    "test": "node --import tsx --test test/*.test.ts"
  },
  "dependencies": { "@hono/node-server": "^1.14.0", "@mc/core": "*", "ethers": "6.17.0", "hono": "^4.9.0" }
}
```
`services/signer/.env.example` (AGENT_PRIVATE_KEY/AGENT_ADDRESS are written by `npm run wallets`):
```
PORT=8788
API_URL=http://127.0.0.1:8787
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
INTERCEPTA_API_KEY=
APPROVER_ADDRESS=
AGENT_PRIVATE_KEY=
AGENT_ADDRESS=
```

`services/signer/src/verify.ts`:
```ts
import {
  assessRisk, erc20Iface, evaluateOrder, evaluateTransfer, hashProposal, recoverShareSigner, settlementIface,
  verifyApproval, voucherIface, weiToYen,
  type Deployments, type OrderLine, type PolicyConfig, type ProposalForSigner, type RiskAssessment, type Screening, type Stall,
} from '@mc/core';
import { getAddress } from 'ethers';

export interface VerifyCtx {
  deployments: Deployments; policy: PolicyConfig; approver: string; agentAddress: string; spentTodayYen: number;
  readItem(itemId: number): Promise<{ priceYen: number; available: number; payTo: string }>;
  screen(address: string): Promise<Screening>; now?: number;
}
type Result = { ok: true } | { ok: false; reason: string };
const fail = (reason: string): Result => ({ ok: false, reason });
const same = (a: string, b: string) => getAddress(a) === getAddress(b);

function checkApproval(p: ProposalForSigner, ctx: VerifyCtx, totalYen: number): Result {
  if (!p.approval) return fail('Human approval required but missing');
  if (p.approval.totalYen !== totalYen) return fail('Approval total does not match the transactions');
  const v = verifyApproval({ chainId: p.chainId, proposalHash: hashProposal(p.chainId, p.txs), totalYen,
    expiresAt: p.approval.expiresAt, signature: p.approval.signature, approver: ctx.approver, now: ctx.now });
  return v.ok ? { ok: true } : fail(v.reason!);
}

export async function verifyForSigning(p: ProposalForSigner, ctx: VerifyCtx): Promise<Result> {
  if (p.chainId !== ctx.deployments.chainId) return fail('Wrong chain');
  if (p.txs.length === 0) return fail('Nothing to sign');
  if (p.txs.some((t) => BigInt(t.value) !== 0n)) return fail('Native value transfers are not allowed');

  if (p.kind === 'order') {
    const lines: OrderLine[] = [];
    for (const t of p.txs) {
      if (!same(t.to, ctx.deployments.voucher)) return fail(`Transaction to non-allowlisted contract ${t.to}`);
      let parsed;
      try { parsed = voucherIface.parseTransaction({ data: t.data }); } catch { return fail('Unreadable calldata'); }
      if (parsed?.name !== 'buyVoucher') return fail(`Unexpected function ${parsed?.name ?? 'unknown'}`);
      lines.push({ itemId: Number(parsed.args[0]), quantity: Number(parsed.args[1]) });
    }
    const stalls: Stall[] = [];
    const risk: Record<string, RiskAssessment> = {};
    for (const itemId of new Set(lines.map((l) => l.itemId))) {
      const item = await ctx.readItem(itemId);
      stalls.push({ itemId, name: `item ${itemId}`, item: '', emoji: '', ...item });
      risk[item.payTo.toLowerCase()] = assessRisk(await ctx.screen(item.payTo), ctx.policy.risk);
    }
    const d = evaluateOrder({ lines, stalls, risk, spentTodayYen: ctx.spentTodayYen, cfg: ctx.policy });
    for (const l of d.lines) {
      if (l.action === 'REFUSE') return fail(`${l.stallName}: ${l.reasons.join('; ')}`);
      if (l.qty !== l.requestedQty) return fail(`${l.stallName}: quantity ${l.requestedQty} exceeds policy (${l.qty})`);
    }
    return d.requiresApproval ? checkApproval(p, ctx, d.totalYen) : { ok: true };
  }

  if (p.kind === 'transfer') {
    if (p.txs.length !== 1) return fail('Transfer must be a single transaction');
    const [t] = p.txs;
    if (!same(t.to, ctx.deployments.stablecoin)) return fail(`Transaction to non-allowlisted contract ${t.to}`);
    const parsed = erc20Iface.parseTransaction({ data: t.data });
    if (parsed?.name !== 'transfer') return fail(`Unexpected function ${parsed?.name ?? 'unknown'}`);
    const to = String(parsed.args[0]);
    const amountYen = weiToYen(parsed.args[1] as bigint);
    const risk = assessRisk(await ctx.screen(to), ctx.policy.risk);
    const d = evaluateTransfer({ to, amountYen, risk, spentTodayYen: ctx.spentTodayYen, cfg: ctx.policy });
    if (d.action === 'REFUSE') return fail(d.reasons.join('; '));
    return d.requiresApproval ? checkApproval(p, ctx, amountYen) : { ok: true };
  }

  // settle: money flows IN to the agent; the signer only pays gas, but still screens the payer.
  if (p.txs.length !== 1) return fail('Settle must be a single transaction');
  const [t] = p.txs;
  if (!same(t.to, ctx.deployments.settlement)) return fail(`Transaction to non-allowlisted contract ${t.to}`);
  const parsed = settlementIface.parseTransaction({ data: t.data });
  if (parsed?.name !== 'settle') return fail(`Unexpected function ${parsed?.name ?? 'unknown'}`);
  const [billId, from, to, amount, deadline, signature] = parsed.args as unknown as [string, string, string, bigint, bigint, string];
  if (!same(to, ctx.agentAddress)) return fail('Settlement must pay the organizer wallet');
  let signer = '';
  try { signer = recoverShareSigner(p.chainId, ctx.deployments.settlement, { billId, from, to, amount, deadline }, signature); }
  catch { return fail('Unreadable share signature'); }
  if (!same(signer, from)) return fail('Share not signed by payer');
  const risk = assessRisk(await ctx.screen(from), ctx.policy.risk);
  if (risk.action === 'REFUSE' || risk.action === 'ASK') return fail(`Payer held: ${risk.reasons.join('; ')}`);
  return { ok: true };
}
```

`services/signer/src/env.ts`:
```ts
import { readFileSync } from 'node:fs';
import type { Deployments, PolicyConfig } from '@mc/core';
const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`${k} is required`); return v; };
export const env = {
  port: Number(process.env.PORT ?? 8788),
  apiUrl: process.env.API_URL ?? 'http://127.0.0.1:8787',
  rpcUrl: need('RPC_URL'),
  interceptaKey: process.env.INTERCEPTA_API_KEY ?? '',
  approver: need('APPROVER_ADDRESS'),
  agentKey: need('AGENT_PRIVATE_KEY'),
  deployments: JSON.parse(readFileSync(new URL('../../../deployments.json', import.meta.url), 'utf8')) as Deployments,
  // The signer loads its own copy of the policy; the api cannot loosen it.
  policy: JSON.parse(readFileSync(new URL('../../../config/policy.json', import.meta.url), 'utf8')) as PolicyConfig,
};
```

`services/signer/src/chain.ts`:
```ts
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { voucherIface, weiToYen, type UnsignedTx } from '@mc/core';
import { env } from './env.ts';

export const provider = new JsonRpcProvider(env.rpcUrl, env.deployments.chainId);
export const wallet = new Wallet(env.agentKey, provider);
const voucher = new Contract(env.deployments.voucher, voucherIface, provider);

export async function readItem(itemId: number) {
  const [price, available, payTo] = await voucher.eventInfo(itemId);
  return { priceYen: weiToYen(price), available: Number(available), payTo: String(payTo) };
}

export async function sendAll(txs: UnsignedTx[]): Promise<string[]> {
  const hashes: string[] = [];
  for (const t of txs) {
    const sent = await wallet.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value) });
    await sent.wait(1);
    hashes.push(sent.hash);
  }
  return hashes;
}
```

`services/signer/src/server.ts`:
```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { quickScan, type ProposalForSigner } from '@mc/core';
import { env } from './env.ts';
import { readItem, sendAll, wallet } from './chain.ts';
import { verifyForSigning } from './verify.ts';

const app = new Hono();
const inFlight = new Set<string>();

app.post('/sign', async (c) => {
  const { proposalId } = await c.req.json<{ proposalId: string }>();
  if (inFlight.has(proposalId)) return c.json({ error: 'Already signing' }, 409);
  inFlight.add(proposalId);
  try {
    const res = await fetch(`${env.apiUrl}/internal/proposals/${proposalId}`);
    if (!res.ok) return c.json({ error: 'Unknown proposal' }, 404);
    const { proposal, spentTodayYen } = (await res.json()) as { proposal: ProposalForSigner; spentTodayYen: number };
    const verdict = await verifyForSigning(proposal, {
      deployments: env.deployments, policy: env.policy, approver: env.approver, agentAddress: wallet.address,
      spentTodayYen, readItem, screen: (a) => quickScan(a, { apiKey: env.interceptaKey }),
    });
    if (!verdict.ok) {
      console.log(`[signer] REFUSED ${proposalId}: ${verdict.reason}`);
      return c.json({ error: verdict.reason }, 422);
    }
    const txHashes = await sendAll(proposal.txs);
    console.log(`[signer] signed ${proposalId}: ${txHashes.join(', ')}`);
    return c.json({ txHashes });
  } finally {
    inFlight.delete(proposalId);
  }
});

serve({ fetch: app.fetch, port: env.port, hostname: '127.0.0.1' });
console.log(`signer for ${wallet.address} on 127.0.0.1:${env.port}`);
```

Note: the signer trusts the api's `spentTodayYen` only as an input that can make it *stricter*; the on-chain allowance (Step 5) is the hard budget.

- [ ] **Step 4: Run to verify pass** — `npm test -w services/signer` → 7 pass.

- [ ] **Step 5: On-chain budget backstop**

`services/signer/src/setupAllowance.ts`:
```ts
import { Contract } from 'ethers';
import { erc20Iface, yenToWei } from '@mc/core';
import { env } from './env.ts';
import { wallet } from './chain.ts';

const coin = new Contract(env.deployments.stablecoin, erc20Iface, wallet);
const budget = yenToWei(env.policy.dailyBudgetYen);
await (await coin.approve(env.deployments.voucher, budget)).wait(1);
console.log(`voucher allowance for ${wallet.address} set to ¥${env.policy.dailyBudgetYen}`);
```
Run: `npm run setup:allowance -w services/signer`
Expected: `voucher allowance … set to ¥5000`.

- [ ] **Step 6: Commit**
```bash
git add services/signer && git commit -m "feat(signer): independent re-verification before signing, on-chain budget allowance"
```

---

### Task 11: api — Kanjō bills (x402-style) and ledger

**Files:**
- Create: `services/api/src/kanjo.ts`, `services/api/src/ledger.ts`
- Test: `services/api/test/kanjo.test.ts`

**Interfaces:**
- Consumes: core `splitBill`, `recoverShareSigner`, `assessRisk`, `hashProposal`; `Deps` (Task 9) plus `mb.composeSettle`; names→addresses map `FRIENDS` from env (`AOI_ADDRESS`, `MEI_ADDRESS`, `KEN_PAYTO`).
- Produces:
  - `createBill(d, input: { participants: string[]; payments: {name;amountYen}[]; memo: string }): BillView`
    ```ts
    interface BillView { billId: string; totalYen: number; shares: Record<string, number>;
      requests: { from: string; amountYen: number; payUrl: string; status: 'pending'|'paid'|'held'; reason?: string; txHash?: string }[];
      payouts: { to: string; amountYen: number; proposalId: string; status: string; reasons: string[] }[] }
    ```
    Friends who owe the organizer get a `payUrl` = `${publicBaseUrl}/kanjo/bills/${billId}/pay?from=${name}`; creditors trigger `proposeTransfer` to their payTo (Ken → `KEN_PAYTO`).
  - `paymentRequired(d, billId, fromName)` → 402 body `{ x402Version: 'mc-kanjo-1', accepts: [{ scheme: 'eip712-share', chainId, settlement, token, to, amount, billId, deadline }] }`
  - `acceptPayment(d, billId, fromName, header: string)` → `{ status: 200, body: { txHash } } | { status: 403, body: { held: true, reasons } } | { status: 409, body: { error } }`
  - `ledger(d)` → `{ purchases, settlements, decisions: ProposalRow[] }`; `rescreen(d)` → `{ address, before, after, changed }[]`

- [ ] **Step 1: Failing tests** (fake mb/signer; real share signatures)

`services/api/test/kanjo.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { SHARE_TYPES, shareDomain } from '@mc/core';
import { openStore } from '../src/store.ts';
import { acceptPayment, createBill, paymentRequired } from '../src/kanjo.ts';

const aoi = Wallet.createRandom();
const settlement = '0x00000000000000000000000000000000000000d0';
const organizer = '0x00000000000000000000000000000000000000ee';
function deps(flagged = false) {
  const signed: string[] = [];
  return { signed, d: {
    mb: {
      readStalls: async () => [], composeBuy: async () => ({ to: '0x0', data: '0x', value: '0' }),
      composeTransfer: async () => ({ to: '0x00000000000000000000000000000000000000c0', data: '0xfeed', value: '0' }),
      composeSettle: async () => ({ to: settlement, data: '0xabcd', value: '0' }),
    },
    screen: async (address: string) => ({ address, ok: true, fetchedAt: 'now',
      result: flagged ? { toxicScore: 90, traits: [{ risk: 90, name: 'known_scammer', txsCount: 1, description: 'Known scammer' }] } : { toxicScore: 1, traits: [] } }),
    store: openStore(':memory:'),
    policy: { maxPerStallYen: 1500, approvalThresholdYen: 1000, dailyBudgetYen: 5000,
      risk: { refuseScore: 70, askScore: 40, capScore: 15, capFraction: 0.5, hardTraits: ['known_scammer'] } },
    chainId: 11155111, agentAddress: organizer, approverAddress: organizer, publicBaseUrl: 'http://x',
    deployments: { chainId: 11155111, stablecoin: '0xc0', voucher: '0xb0', settlement },
    friends: { Aoi: aoi.address, Mei: Wallet.createRandom().address, Ken: '0x00000000000000000000000000000000000000a5' },
    signer: { sign: async (id: string) => { signed.push(id); return { txHashes: ['0xsettled'] }; } },
  } };
}
async function pay(d: any, billId: string) {
  const req = paymentRequired(d, billId, 'Aoi')!;
  const a = req.accepts[0];
  const share = { billId: a.billId, from: aoi.address, to: a.to, amount: BigInt(a.amount), deadline: BigInt(a.deadline) };
  const signature = await aoi.signTypedData(shareDomain(11155111, settlement), SHARE_TYPES, share);
  return Buffer.from(JSON.stringify({ from: aoi.address, signature })).toString('base64');
}

test('bill: friends owe the organizer, organizer owes Ken', async () => {
  const { d } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi', 'Mei', 'Ken'],
    payments: [{ name: 'You', amountYen: 2600 }, { name: 'Ken', amountYen: 1800 }], memo: 'dinner' });
  assert.deepEqual(b.requests.map((r) => [r.from, r.amountYen]), [['Aoi', 1100], ['Mei', 1100]]);
  assert.deepEqual(b.payouts.map((p) => [p.to, p.amountYen]), [['Ken', 700]]);
});

test('402 then a valid share settles once; replay is rejected', async () => {
  const { d, signed } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const header = await pay(d, b.billId);
  const first = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.deepEqual([first.status, signed.length], [200, 1]);
  const again = await acceptPayment(d, b.billId, 'Aoi', header);
  assert.equal(again.status, 409);
});

test('flagged payer is held before anything is signed', async () => {
  const { d, signed } = deps(true);
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const r = await acceptPayment(d, b.billId, 'Aoi', await pay(d, b.billId));
  assert.equal(r.status, 403);
  assert.equal(signed.length, 0);
});

test('a share signed by someone else is rejected', async () => {
  const { d } = deps();
  const b = await createBill(d, { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 2200 }], memo: 'x' });
  const forged = Buffer.from(JSON.stringify({ from: aoi.address, signature: '0x' + '11'.repeat(65) })).toString('base64');
  assert.equal((await acceptPayment(d, b.billId, 'Aoi', forged)).status, 400);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w services/api` → FAIL.

- [ ] **Step 3: Implement**

`services/api/src/kanjo.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { id as keccakId } from 'ethers';
import { assessRisk, hashProposal, recoverShareSigner, splitBill, yenToWei, type Deployments } from '@mc/core';
import type { Deps } from './proposals.ts';
import { execute, proposeTransfer } from './proposals.ts';
import type { Mb } from './multibaas.ts';
import { bus } from './events.ts';

export type KanjoDeps = Deps & {
  mb: Deps['mb'] & Pick<Mb, 'composeSettle'>;
  deployments: Deployments;
  friends: Record<string, string>; // name → address (payer address for debtors, payTo for creditors)
};
interface BillRequest { from: string; amountYen: number; payUrl: string; status: 'pending' | 'paid' | 'held'; reason?: string; txHash?: string; }
interface Bill { billId: string; memo: string; totalYen: number; shares: Record<string, number>; deadline: number;
  requests: BillRequest[]; payouts: { to: string; amountYen: number; proposalId: string; status: string; reasons: string[] }[]; }

export async function createBill(d: KanjoDeps, input: { participants: string[]; payments: { name: string; amountYen: number }[]; memo: string }) {
  const split = splitBill({ organizer: 'You', participants: input.participants, payments: input.payments });
  const billId = keccakId(`bill:${randomUUID()}`);
  const bill: Bill = { billId, memo: input.memo, totalYen: split.totalYen, shares: split.shares,
    deadline: Math.floor(Date.now() / 1000) + 24 * 3600, requests: [], payouts: [] };
  for (const t of split.transfers) {
    if (t.to === 'You') {
      bill.requests.push({ from: t.from, amountYen: t.amountYen, status: 'pending',
        payUrl: `${d.publicBaseUrl}/kanjo/bills/${billId}/pay?from=${encodeURIComponent(t.from)}` });
    } else {
      const to = d.friends[t.to];
      if (!to) throw new Error(`No address for ${t.to}`);
      const v = await proposeTransfer(d, { to, amountYen: t.amountYen, memo: `${input.memo}: pay ${t.to}` });
      const reasons = (v.decision as { reasons?: string[] }).reasons ?? [];
      bill.payouts.push({ to: t.to, amountYen: t.amountYen, proposalId: v.proposalId, status: v.status, reasons });
    }
  }
  d.store.putBill(billId, bill);
  bus.emit('bill', bill);
  return bill;
}

export function paymentRequired(d: KanjoDeps, billId: string, fromName: string) {
  const bill = d.store.getBill(billId) as Bill | null;
  const req = bill?.requests.find((r) => r.from === fromName);
  if (!bill || !req) return null;
  return { x402Version: 'mc-kanjo-1', error: 'Payment required', accepts: [{
    scheme: 'eip712-share', chainId: d.chainId, settlement: d.deployments.settlement, token: d.deployments.stablecoin,
    to: d.agentAddress, amount: yenToWei(req.amountYen).toString(), amountYen: req.amountYen,
    billId, deadline: bill.deadline, memo: bill.memo }] };
}

export async function acceptPayment(d: KanjoDeps, billId: string, fromName: string, header: string) {
  const bill = d.store.getBill(billId) as Bill | null;
  const req = bill?.requests.find((r) => r.from === fromName);
  if (!bill || !req) return { status: 404, body: { error: 'Unknown bill or payer' } };
  let payload: { from: string; signature: string };
  try { payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return { status: 400, body: { error: 'Bad X-PAYMENT' } }; }
  const share = { billId, from: payload.from, to: d.agentAddress, amount: yenToWei(req.amountYen), deadline: BigInt(bill.deadline) };
  let signer = '';
  try { signer = recoverShareSigner(d.chainId, d.deployments.settlement, share, payload.signature); } catch { /* invalid */ }
  if (signer.toLowerCase() !== payload.from.toLowerCase()) return { status: 400, body: { error: 'Share signature invalid' } };

  const risk = assessRisk(await d.screen(payload.from), d.policy.risk);
  if (risk.action === 'REFUSE' || risk.action === 'ASK') {
    req.status = 'held'; req.reason = risk.reasons.join('; ');
    d.store.putBill(billId, bill);
    bus.emit('kanjo_held', { billId, from: fromName, reasons: risk.reasons });
    return { status: 403, body: { held: true, reasons: risk.reasons } };
  }
  if (!d.store.markShare(billId, payload.from)) return { status: 409, body: { error: 'Share already submitted' } };

  const tx = await d.mb.composeSettle({ billId, from: payload.from, to: d.agentAddress, amountYen: req.amountYen,
    deadline: bill.deadline, signature: payload.signature }, d.agentAddress);
  const proposalId = randomUUID();
  d.store.insertProposal({ id: proposalId, kind: 'settle', status: 'proposed', hash: hashProposal(d.chainId, [tx]),
    totalYen: req.amountYen, requiresApproval: false, decision: { risk }, txs: [tx], meta: { billId, from: fromName } });
  const r = await execute(d, proposalId);
  if (r.status !== 'executed') return { status: 502, body: { error: r.reason ?? r.status } };
  req.status = 'paid'; req.txHash = r.txHashes![0];
  d.store.putBill(billId, bill);
  bus.emit('kanjo_paid', { billId, from: fromName, amountYen: req.amountYen, txHash: req.txHash });
  return { status: 200, body: { txHash: req.txHash } };
}
```

`services/api/src/ledger.ts`:
```ts
import type { Mb } from './multibaas.ts';
import type { Store } from './store.ts';
import type { Screener } from './screening.ts';

export async function ledger(mb: Mb, store: Store) {
  const [purchases, settlements] = await Promise.all([mb.purchases(), mb.settlements()]);
  const decisions = store.listProposals(30).map((p) => ({ id: p.id, kind: p.kind, status: p.status,
    totalYen: p.totalYen, decision: p.decision, txHashes: p.txHashes, at: p.createdAt }));
  return { purchases, settlements, decisions, spentTodayYen: store.spentTodayYen() };
}

export async function rescreen(mb: Mb, store: Store, fresh: (address: string) => Promise<ReturnType<Screener> extends Promise<infer S> ? S : never>) {
  const paid = [...new Set((await mb.purchases()).map((p) => p.stall.toLowerCase()))];
  return Promise.all(paid.map(async (address) => {
    const before = store.getScreening(address, Number.MAX_SAFE_INTEGER);
    const after = await fresh(address);
    if (after.ok) store.cacheScreening(after);
    return { address, before: before?.result?.toxicScore ?? null, after: after.result?.toxicScore ?? null,
      changed: (before?.result?.toxicScore ?? null) !== (after.result?.toxicScore ?? null),
      traits: after.result?.traits.map((t) => t.description || t.name) ?? [] };
  }));
}
```

- [ ] **Step 4: Run to verify pass** — `npm test -w services/api` → all pass.

- [ ] **Step 5: Commit**
```bash
git add services/api && git commit -m "feat(api): Kanjō bills with x402-style EIP-712 shares, payer screening, ledger"
```

---

### Task 12: api — agent loop, tools, HTTP server

**Files:**
- Create: `services/api/src/tools.ts`, `services/api/src/agent.ts`, `services/api/src/server.ts`
- Test: `services/api/test/tools.test.ts`

**Interfaces:**
- Consumes: everything in Tasks 7–11.
- Produces:
  - `TOOLS: Anthropic.Beta.BetaTool[]` and `runTool(name: string, input: unknown, d: KanjoDeps & { mbFull: Mb }): Promise<unknown>`
  - `chat(sessionId: string, text: string, d): Promise<{ reply: string; toolCalls: { name: string; input: unknown; output: unknown }[] }>`
  - HTTP:
    - `POST /api/chat {sessionId, text}` → `{ reply, toolCalls }`
    - `GET /api/events` (SSE; replays `bus.recent()` then streams)
    - `GET /api/proposals/:id` → `ProposalRow` + `approvalTypedData` for the UI
    - `POST /api/proposals/:id/approve {signature, totalYen, expiresAt}` → `{ ok, reason? , execution? }` (auto-executes on success)
    - `GET /api/stalls`, `GET /api/ledger`
    - `GET /internal/proposals/:id` → `{ proposal: ProposalForSigner, spentTodayYen }` (loopback only)
    - `GET /kanjo/bills/:billId/pay?from=` → 402 JSON; with `X-PAYMENT` header → settle

- [ ] **Step 1: Failing test for tool input validation**

`services/api/test/tools.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, validateInput } from '../src/tools.ts';

test('every tool has a strict object schema', () => {
  for (const t of TOOLS) {
    assert.equal((t.input_schema as any).type, 'object', t.name);
    assert.equal((t.input_schema as any).additionalProperties, false, t.name);
  }
});

test('propose_order rejects malformed input before touching money', () => {
  assert.equal(validateInput('propose_order', { items: [{ itemId: 1, quantity: 2 }] }).ok, true);
  assert.equal(validateInput('propose_order', { items: [{ itemId: '1', quantity: 2 }] }).ok, false);
  assert.equal(validateInput('propose_order', { items: [] }).ok, false);
  assert.equal(validateInput('split_bill', { participants: ['You', 'Aoi'], payments: [{ name: 'You', amountYen: 100 }], memo: 'x' }).ok, true);
  assert.equal(validateInput('split_bill', { participants: ['You'], payments: [], memo: 'x', extra: 1 }).ok, false);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w services/api` → FAIL.

- [ ] **Step 3: Implement tools**

`services/api/src/tools.ts`:
```ts
import type Anthropic from '@anthropic-ai/sdk';
import type { Mb } from './multibaas.ts';
import { execute, proposeOrder } from './proposals.ts';
import { createBill, type KanjoDeps } from './kanjo.ts';
import { ledger, rescreen } from './ledger.ts';
import { quickScan } from '@mc/core';

type Tool = Anthropic.Beta.BetaTool;
const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });

export const TOOLS: Tool[] = [
  { name: 'list_stalls', description: 'List festival food stalls with item, price in yen, stock and payout address, read live from chain via MultiBaas.',
    input_schema: obj({}, []) },
  { name: 'propose_order', description: 'Propose buying vouchers. Returns the missing-layer verdict per stall (PAY/CAP/ASK/REFUSE with reasons), total yen and whether a human approval is needed. Does not move money.',
    input_schema: obj({ items: { type: 'array', minItems: 1, items: obj({ itemId: { type: 'integer' }, quantity: { type: 'integer' } }, ['itemId', 'quantity']) } }, ['items']) },
  { name: 'execute_order', description: 'Ask the independent signer to execute a proposal. Returns executed, awaiting_approval, refused, held or failed with a reason. You cannot sign.',
    input_schema: obj({ proposalId: { type: 'string' } }, ['proposalId']) },
  { name: 'split_bill', description: 'Split the evening between friends. participants must include "You" (the organizer). payments lists who paid how much in whole yen. Creates payment requests to friends and payouts from you, each screened.',
    input_schema: obj({ participants: { type: 'array', minItems: 2, items: { type: 'string' } },
      payments: { type: 'array', items: obj({ name: { type: 'string' }, amountYen: { type: 'integer' } }, ['name', 'amountYen']) },
      memo: { type: 'string' } }, ['participants', 'payments', 'memo']) },
  { name: 'ledger', description: 'On-chain purchases and settlements (MultiBaas event queries) plus the decision log with verdicts and reasons.',
    input_schema: obj({}, []) },
  { name: 'rescreen_counterparties', description: 'Re-screen every stall already paid with Intercepta and report score changes.',
    input_schema: obj({}, []) },
];

export function validateInput(name: string, input: unknown): { ok: true } | { ok: false; reason: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, reason: `Unknown tool ${name}` };
  const check = (schema: any, value: any, path: string): string | null => {
    if (schema.type === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      for (const k of Object.keys(value)) if (!(k in schema.properties)) return `${path}.${k} is not allowed`;
      for (const k of schema.required ?? []) if (!(k in value)) return `${path}.${k} is required`;
      for (const [k, s] of Object.entries(schema.properties)) if (k in value) { const e = check(s, value[k], `${path}.${k}`); if (e) return e; }
      return null;
    }
    if (schema.type === 'array') {
      if (!Array.isArray(value)) return `${path} must be an array`;
      if (schema.minItems && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} item(s)`;
      for (let i = 0; i < value.length; i++) { const e = check(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
      return null;
    }
    if (schema.type === 'integer') return Number.isInteger(value) ? null : `${path} must be an integer`;
    if (schema.type === 'string') return typeof value === 'string' ? null : `${path} must be a string`;
    return null;
  };
  const err = check(tool.input_schema, input, 'input');
  return err ? { ok: false, reason: err } : { ok: true };
}

export async function runTool(name: string, input: any, d: KanjoDeps & { mbFull: Mb; interceptaKey: string }) {
  const v = validateInput(name, input);
  if (!v.ok) return { error: v.reason };
  switch (name) {
    case 'list_stalls': return d.mbFull.readStalls();
    case 'propose_order': return proposeOrder(d, input.items);
    case 'execute_order': return execute(d, input.proposalId);
    case 'split_bill': return createBill(d, input);
    case 'ledger': return ledger(d.mbFull, d.store);
    case 'rescreen_counterparties': return rescreen(d.mbFull, d.store, (a) => quickScan(a, { apiKey: d.interceptaKey }));
    default: return { error: `Unknown tool ${name}` };
  }
}
```

- [ ] **Step 4: Implement the agent loop** (manual loop, per the claude-api skill; server-side fallback on refusal)

`services/api/src/agent.ts`:
```ts
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, runTool } from './tools.ts';
import { bus } from './events.ts';

const client = new Anthropic();
const sessions = new Map<string, Anthropic.Beta.BetaMessageParam[]>();

const SYSTEM = `You are Matsuri Concierge, a festival agent for a group of friends at a Japanese matsuri.
You plan food and pay stalls in MJPY (1 MJPY = 1 yen), and you settle the bill between friends.
Rules you must follow:
- You cannot sign or move money yourself. You propose; a policy engine, Intercepta screening, the human, and an independent signer decide.
- Never compute prices, totals or splits in your head. Use list_stalls, propose_order and split_bill; quote their numbers exactly.
- After propose_order, explain every stall's verdict in one short line (PAY / CAP / ASK / REFUSE and the reason). If a stall is REFUSED, you may propose an alternative stall once.
- If approval is required, tell the user to approve on their phone (the approval card) and wait; call execute_order only after they say they approved or when no approval is needed.
- Keep replies short and friendly. Reply in the user's language (Japanese or English).`;

export async function chat(sessionId: string, text: string, deps: Parameters<typeof runTool>[2], model: string, effort: 'low' | 'medium' | 'high') {
  const messages = sessions.get(sessionId) ?? [];
  messages.push({ role: 'user', content: text });
  const toolCalls: { name: string; input: unknown; output: unknown }[] = [];

  for (let turn = 0; turn < 12; turn++) {
    const response = await client.beta.messages.create({
      model, max_tokens: 16000, system: SYSTEM, tools: TOOLS, messages,
      thinking: { type: 'adaptive' }, output_config: { effort },
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'refusal') break;
    if (response.stop_reason === 'pause_turn') continue;
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (uses.length === 0) break;

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      bus.emit('tool_call', { name: u.name, input: u.input });
      let output: unknown;
      try { output = await runTool(u.name, u.input, deps); }
      catch (e) { output = { error: (e as Error).message }; }
      toolCalls.push({ name: u.name, input: u.input, output });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(output),
        is_error: typeof output === 'object' && output !== null && 'error' in output });
    }
    messages.push({ role: 'user', content: results });
  }
  sessions.set(sessionId, messages);
  const last = messages[messages.length - 1];
  const reply = last.role === 'assistant' && Array.isArray(last.content)
    ? last.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    : '';
  bus.emit('agent_reply', { sessionId, reply });
  return { reply, toolCalls };
}
```
If `tsc`/runtime rejects `fallbacks` or `output_config` typing on the installed SDK version, keep the `as` cast (the fields are passed through) and confirm with one live call.

- [ ] **Step 5: HTTP server**

`services/api/src/server.ts`:
```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { readFileSync } from 'node:fs';
import { APPROVAL_TYPES, approvalDomain, type PolicyConfig } from '@mc/core';
import { env } from './env.ts';
import { openStore } from './store.ts';
import { createMb } from './multibaas.ts';
import { createScreener } from './screening.ts';
import { createSignerClient } from './signerClient.ts';
import { execute, recordApproval } from './proposals.ts';
import { acceptPayment, paymentRequired } from './kanjo.ts';
import { ledger } from './ledger.ts';
import { chat } from './agent.ts';
import { bus } from './events.ts';

const policy = JSON.parse(readFileSync(new URL('../../../config/policy.json', import.meta.url), 'utf8')) as PolicyConfig;
const store = openStore(new URL('../data.sqlite', import.meta.url).pathname);
const mb = createMb(env.mbBaseUrl, env.mbApiKey);
const deps = {
  mb, mbFull: mb, screen: createScreener(store, env.interceptaKey), store, policy, chainId: env.chainId,
  agentAddress: env.agentAddress, approverAddress: env.approverAddress, publicBaseUrl: env.publicBaseUrl,
  signer: createSignerClient(env.signerUrl), deployments: env.deployments, interceptaKey: env.interceptaKey,
  friends: { Aoi: process.env.AOI_ADDRESS ?? '', Mei: process.env.MEI_ADDRESS ?? '', Ken: process.env.KEN_PAYTO ?? '' },
};

const app = new Hono();
app.post('/api/chat', async (c) => {
  const { sessionId, text } = await c.req.json<{ sessionId: string; text: string }>();
  return c.json(await chat(sessionId, text, deps, env.anthropicModel, env.agentEffort));
});
app.get('/api/events', (c) => streamSSE(c, async (stream) => {
  for (const e of bus.recent()) await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
  const off = bus.subscribe((e) => { void stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) }); });
  stream.onAbort(() => off());
  while (!stream.aborted) await stream.sleep(15_000);
}));
app.get('/api/stalls', async (c) => c.json(await mb.readStalls()));
app.get('/api/ledger', async (c) => c.json(await ledger(mb, store)));
app.get('/api/proposals/:id', (c) => {
  const p = store.getProposal(c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ ...p, approver: env.approverAddress,
    typedData: { domain: approvalDomain(env.chainId), types: APPROVAL_TYPES, primaryType: 'Approval' } });
});
app.post('/api/proposals/:id/approve', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ signature: string; totalYen: number; expiresAt: number }>();
  const r = recordApproval(deps, id, body);
  if (!r.ok) return c.json(r, 400);
  return c.json({ ok: true, execution: await execute(deps, id) });
});
app.get('/internal/proposals/:id', (c) => {
  const p = store.getProposal(c.req.param('id'));
  if (!p) return c.json({ error: 'not found' }, 404);
  return c.json({ proposal: { id: p.id, kind: p.kind, chainId: env.chainId, txs: p.txs, approval: p.approval },
    spentTodayYen: store.spentTodayYen() });
});
app.get('/kanjo/bills/:billId/pay', async (c) => {
  const billId = c.req.param('billId'); const from = c.req.query('from') ?? '';
  const header = c.req.header('X-PAYMENT');
  if (!header) {
    const req = paymentRequired(deps, billId, from);
    return req ? c.json(req, 402) : c.json({ error: 'not found' }, 404);
  }
  const r = await acceptPayment(deps, billId, from, header);
  return c.json(r.body, r.status as 200);
});

serve({ fetch: app.fetch, port: env.port });
console.log(`api on :${env.port} (agent wallet ${env.agentAddress}, no keys here)`);
```
Add to `services/api/.env.example`: `AOI_ADDRESS=`, `MEI_ADDRESS=`, `KEN_PAYTO=` (Ken's payTo = a flagged mainnet address from Intercepta's Discord list).

- [ ] **Step 6: Run tests + a live smoke**

Run: `npm test -w services/api` → all pass.
Live (signer running with `npm run dev:signer`):
```bash
npm run dev:api &
curl -s localhost:8787/api/chat -H 'content-type: application/json' -d '{"sessionId":"s1","text":"Just list the stalls"}'
```
Expected: a reply naming the five stalls with prices 600/700/400/500/300.

- [ ] **Step 7: Commit**
```bash
git add services/api && git commit -m "feat(api): Claude agent loop with validated tools, SSE events, approval + x402-style endpoints"
```

---

### Task 13: friends — simulated friend agents

**Files:**
- Create: `services/friends/package.json`, `.env.example`, `src/server.ts`, `src/setupApprove.ts`

**Interfaces:**
- Consumes: api `GET /kanjo/bills/:id/pay` (402 flow), core `SHARE_TYPES`, `shareDomain`.
- Produces: `POST /friends/:name/pay {payUrl}` → `{ status, body }` (the friend's agent handles the 402 itself).

- [ ] **Step 1: Implement**

`services/friends/package.json`:
```json
{
  "name": "@mc/friends",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --env-file=.env --import tsx src/server.ts",
    "setup:approve": "node --env-file=.env --import tsx src/setupApprove.ts"
  },
  "dependencies": { "@hono/node-server": "^1.14.0", "@mc/core": "*", "ethers": "6.17.0", "hono": "^4.9.0" }
}
```

`services/friends/src/server.ts`:
```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { Wallet } from 'ethers';
import { SHARE_TYPES, shareDomain } from '@mc/core';

const friends: Record<string, Wallet> = {
  Aoi: new Wallet(process.env.AOI_PRIVATE_KEY!),
  Mei: new Wallet(process.env.MEI_PRIVATE_KEY!),
};
const app = new Hono();

// A friend's agent: fetch the 402, check it is within its own limit, sign the share, retry with X-PAYMENT.
app.post('/friends/:name/pay', async (c) => {
  const wallet = friends[c.req.param('name')];
  if (!wallet) return c.json({ error: 'unknown friend' }, 404);
  const { payUrl } = await c.req.json<{ payUrl: string }>();
  const first = await fetch(payUrl);
  if (first.status !== 402) return c.json({ error: `expected 402, got ${first.status}` }, 400);
  const { accepts: [a] } = await first.json() as { accepts: any[] };
  if (a.amountYen > 3000) return c.json({ error: `friend agent limit: ¥${a.amountYen} is too much` }, 400);
  const share = { billId: a.billId, from: wallet.address, to: a.to, amount: BigInt(a.amount), deadline: BigInt(a.deadline) };
  const signature = await wallet.signTypedData(shareDomain(a.chainId, a.settlement), SHARE_TYPES, share);
  const header = Buffer.from(JSON.stringify({ from: wallet.address, signature })).toString('base64');
  const second = await fetch(payUrl, { headers: { 'X-PAYMENT': header } });
  return c.json({ status: second.status, body: await second.json() });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8790) });
console.log('friend agents Aoi, Mei on :8790');
```

`services/friends/src/setupApprove.ts` (each friend approves the settlement contract once; needs the gas ETH from Task 3):
```ts
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { erc20Iface, yenToWei } from '@mc/core';
import deployments from '../../../deployments.json' with { type: 'json' };

const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com', deployments.chainId);
for (const key of [process.env.AOI_PRIVATE_KEY!, process.env.MEI_PRIVATE_KEY!]) {
  const w = new Wallet(key, provider);
  const coin = new Contract(deployments.stablecoin, erc20Iface, w);
  await (await coin.approve(deployments.settlement, yenToWei(5000))).wait(1);
  console.log(`${w.address} approved settlement for ¥5000`);
}
```

- [ ] **Step 2: Run the approvals** — `npm install && npm run setup:approve -w services/friends` → two `approved` lines.

- [ ] **Step 3: Live Kanjō check** (api + signer + friends running)
```bash
npm run dev:friends &
curl -s localhost:8787/api/chat -H 'content-type: application/json' \
  -d '{"sessionId":"k1","text":"Split tonight: You paid 2600, Ken paid 1800. Participants You, Aoi, Mei, Ken."}'
# take Aoi's payUrl from the reply's toolCalls, then:
curl -s localhost:8790/friends/Aoi/pay -H 'content-type: application/json' -d '{"payUrl":"<payUrl>"}'
```
Expected: `{"status":200,"body":{"txHash":"0x…"}}`; the Ken payout shows `held` with the Intercepta reason.

- [ ] **Step 4: Commit**
```bash
git add services/friends && git commit -m "feat(friends): simulated friend agents that answer x402-style payment requests"
```

---

### Task 14: web — chat, missing-layer feed, approval page, ledger

**Files:**
- Create: `apps/web/package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/api.ts`, `src/App.tsx`, `src/Chat.tsx`, `src/DecisionFeed.tsx`, `src/Approve.tsx`, `src/Ledger.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: api HTTP + SSE (Task 12), friends `POST /friends/:name/pay` (for the "Aoi's phone" demo buttons).
- Produces: UI at `http://localhost:5180`; approval route `/approve/:id`.

- [ ] **Step 1: Manifest + Vite proxy**

`apps/web/package.json`:
```json
{
  "name": "@mc/web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite --port 5180 --strictPort", "build": "tsc --noEmit && vite build" },
  "dependencies": { "@mc/core": "*", "ethers": "6.17.0", "react": "19.3.0", "react-dom": "19.3.0" },
  "devDependencies": { "@types/react": "19.3.0", "@types/react-dom": "19.3.0", "@vitejs/plugin-react": "6.1.1", "vite": "8.3.1" }
}
```
`apps/web/vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8787', '/kanjo': 'http://localhost:8787', '/friends': 'http://localhost:8790' } },
});
```
`apps/web/index.html`: standard Vite root with `<div id="root"></div>` and `<script type="module" src="/src/main.tsx"></script>`, title `Matsuri Concierge`.

- [ ] **Step 2: API client + app shell**

`apps/web/src/api.ts`:
```ts
export async function sendChat(sessionId: string, text: string) {
  const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, text }) });
  return r.json() as Promise<{ reply: string; toolCalls: { name: string; input: unknown; output: any }[] }>;
}
export type FeedEvent = { id: number; at: string; type: string; data: any };
export function subscribe(onEvent: (e: FeedEvent) => void) {
  const es = new EventSource('/api/events');
  for (const t of ['proposal', 'screening', 'approval', 'executed', 'signer_refused', 'bill', 'kanjo_paid', 'kanjo_held', 'tool_call'])
    es.addEventListener(t, (m) => onEvent(JSON.parse((m as MessageEvent).data)));
  return () => es.close();
}
export const getProposal = (id: string) => fetch(`/api/proposals/${id}`).then((r) => r.json());
export const approve = (id: string, body: { signature: string; totalYen: number; expiresAt: number }) =>
  fetch(`/api/proposals/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
export const getLedger = () => fetch('/api/ledger').then((r) => r.json());
export const friendPay = (name: string, payUrl: string) =>
  fetch(`/friends/${name}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payUrl }) }).then((r) => r.json());
```

`apps/web/src/main.tsx`:
```tsx
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import Approve from './Approve.tsx';
import './styles.css';
const m = location.pathname.match(/^\/approve\/(.+)$/);
createRoot(document.getElementById('root')!).render(m ? <Approve id={m[1]} /> : <App />);
```

`apps/web/src/App.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { subscribe, type FeedEvent } from './api.ts';
import Chat from './Chat.tsx';
import DecisionFeed from './DecisionFeed.tsx';
import Ledger from './Ledger.tsx';

export default function App() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => subscribe((e) => setEvents((xs) => (xs.some((x) => x.id === e.id) ? xs : [...xs, e]))), []);
  return (
    <div className="layout">
      <header><h1>🏮 Matsuri Concierge</h1><p>AI creates intent. The missing layer decides whether money moves.</p></header>
      <main>
        <Chat events={events} />
        <DecisionFeed events={events} />
      </main>
      <Ledger events={events} />
    </div>
  );
}
```

- [ ] **Step 3: Chat (text + optional voice via Web Speech API)**

`apps/web/src/Chat.tsx`:
```tsx
import { useState } from 'react';
import { friendPay, sendChat, type FeedEvent } from './api.ts';

const sessionId = crypto.randomUUID();
type Msg = { who: 'you' | 'agent'; text: string };

export default function Chat({ events }: { events: FeedEvent[] }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bills = events.filter((e) => e.type === 'bill').map((e) => e.data);

  async function send(t: string) {
    if (!t.trim()) return;
    setMsgs((m) => [...m, { who: 'you', text: t }]); setText(''); setBusy(true);
    try { const r = await sendChat(sessionId, t); setMsgs((m) => [...m, { who: 'agent', text: r.reply }]); }
    finally { setBusy(false); }
  }
  function listen() {
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR(); rec.lang = navigator.language.startsWith('ja') ? 'ja-JP' : 'en-US';
    rec.onresult = (e: any) => send(e.results[0][0].transcript);
    rec.start();
  }
  return (
    <section className="panel chat">
      <h2>Concierge</h2>
      <div className="msgs">{msgs.map((m, i) => <p key={i} className={m.who}>{m.text}</p>)}{busy && <p className="agent">…</p>}</div>
      <form onSubmit={(e) => { e.preventDefault(); void send(text); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="4 of us, ¥3,000, dinner please" />
        <button type="button" onClick={listen} title="Speak">🎤</button>
        <button disabled={busy}>Send</button>
      </form>
      {bills.map((b: any) => b.requests.map((r: any) => (
        <button key={b.billId + r.from} className="friend" onClick={() => friendPay(r.from, r.payUrl)}>
          📱 {r.from}'s agent pays ¥{r.amountYen}
        </button>
      )))}
    </section>
  );
}
```

- [ ] **Step 4: Missing-layer decision feed**

`apps/web/src/DecisionFeed.tsx`:
```tsx
import type { FeedEvent } from './api.ts';

const color: Record<string, string> = { PAY: 'pay', CAP: 'cap', ASK: 'ask', REFUSE: 'refuse' };

export default function DecisionFeed({ events }: { events: FeedEvent[] }) {
  return (
    <section className="panel feed">
      <h2>The missing layer</h2>
      {[...events].reverse().map((e) => {
        const d = e.data;
        if (e.type === 'screening') return <div key={e.id} className="row">🔎 Intercepta {short(d.address)} → score {d.toxicScore ?? 'n/a'} {d.traits.join(', ')} {d.error ?? ''}</div>;
        if (e.type === 'proposal') return (
          <div key={e.id} className="card">
            <strong>{d.kind === 'order' ? '🧾 Order' : '💸 Transfer'} · ¥{d.totalYen} · {d.status}</strong>
            {(d.decision.lines ?? [d.decision]).map((l: any, i: number) => (
              <div key={i} className={`verdict ${color[l.action]}`}>{l.action} {l.stallName ?? short(l.to)} {l.qty !== undefined ? `×${l.qty}` : ''} {l.reasons?.join('; ')}</div>
            ))}
            {d.approvalUrl && <a className="approve" href={d.approvalUrl} target="_blank">✋ Approve on your phone</a>}
          </div>
        );
        if (e.type === 'executed') return <div key={e.id} className="row ok">✅ Signed by the signer: {d.txHashes.map((h: string) => <a key={h} href={`https://sepolia.etherscan.io/tx/${h}`} target="_blank">{short(h)} </a>)}</div>;
        if (e.type === 'signer_refused') return <div key={e.id} className="row bad">⛔ Signer refused: {d.reason}</div>;
        if (e.type === 'kanjo_paid') return <div key={e.id} className="row ok">🤝 {d.from} paid ¥{d.amountYen}</div>;
        if (e.type === 'kanjo_held') return <div key={e.id} className="row bad">⏸ {d.from}'s payment held: {d.reasons.join('; ')}</div>;
        return null;
      })}
    </section>
  );
}
const short = (s: string) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : '');
```

- [ ] **Step 5: Approval page (human signs EIP-712 with MetaMask)**

`apps/web/src/Approve.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { BrowserProvider } from 'ethers';
import { approve, getProposal } from './api.ts';

export default function Approve({ id }: { id: string }) {
  const [p, setP] = useState<any>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { void getProposal(id).then(setP); }, [id]);
  if (!p) return <p className="panel">Loading…</p>;

  async function sign() {
    const provider = new BrowserProvider((window as any).ethereum);
    const signer = await provider.getSigner();
    if ((await signer.getAddress()).toLowerCase() !== p.approver.toLowerCase()) { setMsg(`Switch MetaMask to ${p.approver}`); return; }
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const signature = await signer.signTypedData(p.typedData.domain, p.typedData.types, { proposalHash: p.hash, totalYen: p.totalYen, expiresAt });
    const r = await approve(id, { signature, totalYen: p.totalYen, expiresAt });
    setMsg(r.ok ? `Approved · ${r.execution.status}` : `Rejected: ${r.reason}`);
  }
  return (
    <div className="panel approve-page">
      <h1>✋ Approve ¥{p.totalYen}?</h1>
      {(p.decision.lines ?? [p.decision]).map((l: any, i: number) => <div key={i} className={`verdict ${l.action.toLowerCase()}`}>{l.action} {l.stallName ?? l.to} ×{l.qty ?? ''} ¥{l.subtotalYen ?? l.amountYen}</div>)}
      <p>Why you're asked: {p.decision.approvalReasons?.join('; ')}</p>
      <p className="hash">Proposal hash {p.hash}</p>
      <button onClick={sign} disabled={p.status !== 'awaiting_approval'}>Sign approval</button>
      <p>{msg}</p>
    </div>
  );
}
```

- [ ] **Step 6: Ledger + styles**

`apps/web/src/Ledger.tsx`:
```tsx
import { useEffect, useState } from 'react';
import { getLedger, type FeedEvent } from './api.ts';

export default function Ledger({ events }: { events: FeedEvent[] }) {
  const [l, setL] = useState<any>(null);
  const executedCount = events.filter((e) => e.type === 'executed').length;
  useEffect(() => { void getLedger().then(setL); }, [executedCount]);
  if (!l) return null;
  return (
    <section className="panel ledger">
      <h2>Ledger (MultiBaas event queries) · spent today ¥{l.spentTodayYen}</h2>
      <table><tbody>
        {l.purchases.map((p: any) => <tr key={p.txHash}><td>🧾</td><td>item {p.itemId} ×{p.quantity}</td><td>¥{p.amountYen}</td><td>{p.stall.slice(0, 8)}…</td></tr>)}
        {l.settlements.map((s: any) => <tr key={s.txHash}><td>🤝</td><td>{s.from.slice(0, 8)}… → you</td><td>¥{s.amountYen}</td><td>{s.billId.slice(0, 8)}…</td></tr>)}
      </tbody></table>
    </section>
  );
}
```
`apps/web/src/styles.css`: warm festival palette (lantern red `#c8412b`, paper `#fff8ef`, ink `#2b1d16`); `.layout` grid with header, two-column `main` (chat | feed) collapsing to one column under 800px; `.verdict.pay` green, `.cap` amber, `.ask` blue, `.refuse` red; `.approve` large button link; readable 16px base. Copy the font stack and card radius from the Curvegrid sample's `apps/web/src/styles/app.css` (MIT) for visual continuity.

- [ ] **Step 7: Verify in the browser**

Run all four processes (`dev:signer`, `dev:api`, `dev:friends`, `dev:web`), open `http://localhost:5180` with the gstack `/browse` skill, type "4 of us, ¥3,000, dinner please". Expected: stalls listed, Kuro Yatai REFUSED with the Intercepta reason in the feed, an approval card for the total ≥ ¥1,000; opening the approval link and signing with the approver MetaMask account results in "Approved · executed" and Sepolia tx links.

- [ ] **Step 8: Commit**
```bash
git add apps/web && git commit -m "feat(web): chat, missing-layer decision feed, EIP-712 approval page, ledger"
```

---

### Task 15: Rehearsal script, README, feedback, video

**Files:**
- Create: `README.md`, `FEEDBACK.md`, `docs/demo-script.md`

- [ ] **Step 1: End-to-end rehearsal (twice, fresh session each time)**
1. "We're 4, budget ¥3,000, dinner please." → expect PAY lines, a REFUSE on Kuro Yatai (reason shown), the agent swapping in another stall, and an approval request.
2. Approve on the phone page → executed tx links.
3. "Split it: I paid 2600, Ken paid 1800, we're You, Aoi, Mei, Ken." → Aoi/Mei payment buttons; Ken payout HELD with reason.
4. Click "Aoi's agent pays" and "Mei's agent pays" → 🤝 rows, ledger updates.
5. "What did we spend and why was Kuro Yatai blocked?" → answer quotes ledger totals and the Intercepta trait.
6. Negative test live: stop the api, hand-craft `curl -X POST 127.0.0.1:8788/sign -d '{"proposalId":"<refused id>"}'` → signer refuses.

- [ ] **Step 2: README** — sections: one-liner; the Curvegrid architecture diagram (intent → agent → policy engine → human approval → secure signer → chain) mapped to our folders; **where Intercepta is called** (`packages/core/src/intercepta.ts`, called from `services/api/src/screening.ts`, `services/api/src/kanjo.ts` and `services/signer/src/server.ts`); where MultiBaas is used (`services/api/src/multibaas.ts`: unsigned tx composition + Event Queries; deployment via hardhat-multibaas-plugin); "x402-style, not official x402" note; how to run (wallets → deploy → fund → allowance → approve → four dev commands); honest limitations (simulated friends, Sepolia instead of Awaji because of MIZU gas minimum, screening of mainnet addresses reused on testnet); credits (Curvegrid sample MIT); AI attribution link.

- [ ] **Step 3: FEEDBACK.md** — 3–5 lines on Intercepta (time to first call, what confused us, what was missing), plus MultiBaas notes (the ignition link-skip on resumed deploys; `rpc.sepolia.org` default is dead; Awaji 30 gwei min tip vs faucet amount).

- [ ] **Step 4: Record the 2–4 minute video** (720p+, real voice, no speed-up) following `docs/demo-script.md`.

- [ ] **Step 5: Commit + push** (push to a new public GitHub repo only after the user confirms the repo name/visibility)
```bash
git add README.md FEEDBACK.md docs/demo-script.md && git commit -m "docs: README with sponsor call sites, feedback, demo script"
```

---

### Stretch (only after Task 15 is green)

- **S1 World ID for Agents step-up** on the approval page (third partner: World "Best Use of World ID for Agents" needs the denied/expired path and backend validation; sandbox rejects http localhost callbacks → needs an HTTPS tunnel).
- **S2 Official x402 SDK** for Kanjō (requires EIP-3009 on MJPY + a facilitator on Sepolia).
- **S3 Deploy** api/web to Railway for a live demo link.
