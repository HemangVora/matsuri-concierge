import { network } from 'hardhat';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load /deployments.json via readFileSync instead of a JSON import attribute:
// Hardhat's module loader doesn't reliably resolve `with { type: 'json' }` here.
// Hardhat のモジュールローダーが `with { type: 'json' }` を確実に解決できないため、
// JSON インポート属性の代わりに readFileSync で /deployments.json を読み込む。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const deployments = JSON.parse(readFileSync(path.join(__dirname, '../../deployments.json'), 'utf-8'));

const { ethers } = await network.create();
const [owner] = await ethers.getSigners();
const coin = await ethers.getContractAt('MatsuriStablecoin', deployments.stablecoin);

const targets = [
  { name: 'agent', address: process.env.FUND_AGENT!, yen: '10000' },
  { name: 'aoi', address: process.env.FUND_AOI!, yen: '5000' },
  { name: 'mei', address: process.env.FUND_MEI!, yen: '5000' },
];
// Gas top-up target per wallet. Raised from 0.005 to 0.01 ETH so a wallet that's already sent a few
// transactions this session doesn't run dry mid-demo. The deployer historically holds ~0.029 ETH on
// Sepolia, which is enough to top up all three targets from empty exactly once, with no headroom for
// a second full round — see the insufficient-balance handling below.
const gasTarget = ethers.parseEther('0.01');

for (const t of targets) {
  if (!t.address) throw new Error(`FUND_${t.name.toUpperCase()} missing`);
  const targetYen = ethers.parseUnits(t.yen, 18);
  // Idempotent against the RPC's known nonce lag (HHE10412-style): a retry after a
  // partial failure should top up to the target, not mint/send again on top of it.
  // 既知の RPC ノンス遅延（HHE10412 相当）に対して冪等にする：
  // 部分失敗後の再実行では、上乗せではなく目標額まで補填する。
  const currentYen = await coin.balanceOf(t.address);
  if (currentYen < targetYen) {
    await (await coin.mint(t.address, targetYen - currentYen)).wait();
  }
  const currentEth = await ethers.provider.getBalance(t.address);
  if (currentEth < gasTarget) {
    const need = gasTarget - currentEth;
    const ownerBalance = await ethers.provider.getBalance(owner.address);
    // Fail closed with a clear, actionable message rather than letting `sendTransaction` throw
    // mid-loop on insufficient funds: a partial run (e.g. agent + aoi funded, mei not) should be
    // obvious from the log, not an uncaught exception that leaves the operator guessing which
    // wallets still need gas before recording.
    if (ownerBalance <= need) {
      console.log(`SKIPPED gas top-up for ${t.name} ${t.address}: deployer balance ¥${ethers.formatEther(ownerBalance)} ETH ` +
        `is not enough to send ${ethers.formatEther(need)} ETH. Fund the deployer wallet and re-run — MJPY balance above is unaffected.`);
      continue;
    }
    await (await owner.sendTransaction({ to: t.address, value: need })).wait();
  }
  console.log(`funded ${t.name} ${t.address}: ¥${t.yen} MJPY + ${ethers.formatEther(gasTarget)} ETH`);
}
