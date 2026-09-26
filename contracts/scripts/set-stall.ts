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
const voucher = await ethers.getContractAt('MatsuriVoucher', deployments.voucher);

// STALL_ID/PAYTO are required; PRICE_YEN/AVAILABLE default to whatever is already on-chain for that
// stall (read via eventInfo), so re-pointing a stall's payout doesn't accidentally also reset its
// price or stock unless the operator explicitly asks to.
const stallIdStr = process.env.STALL_ID;
const payTo = process.env.PAYTO;
if (!stallIdStr) throw new Error('STALL_ID is required');
if (!payTo) throw new Error('PAYTO is required');
const stallId = BigInt(stallIdStr);

const current = await voucher.eventInfo(stallId);
if (current.price === 0n) {
  throw new Error(`Stall ${stallIdStr} has no on-chain event configured yet (price is 0) — ` +
    'pass PRICE_YEN and AVAILABLE explicitly to configure it for the first time.');
}
const priceWei = process.env.PRICE_YEN ? ethers.parseUnits(process.env.PRICE_YEN, 18) : current.price;
const available = process.env.AVAILABLE ? BigInt(process.env.AVAILABLE) : current.available;

const tx = await voucher.setEvent(stallId, priceWei, available, payTo);
const receipt = await tx.wait();
console.log(`set-stall ${stallIdStr}: payTo=${payTo} priceYen=${ethers.formatUnits(priceWei, 18)} available=${available} tx=${receipt?.hash}`);
console.log('Remember to update config/stalls.json\'s matching payTo so the UI stays consistent with on-chain state (this script does not touch that file).');
